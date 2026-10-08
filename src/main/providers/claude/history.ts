import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { execFile } from 'child_process';
import { getDefaultClaudeHome } from '../../claude-accounts';
import type { ProviderUsageHistory, RemoteHistoryConfig, UsageHistoryPeriod } from '../types';
import { CLAUDE_PRICING, normalizeClaudeModel } from './pricing';

interface UsageRow {
  date: string;
  totalTokens: number;
  requests: number;
  costUSD: number;
  costIncomplete?: boolean;
}

interface MessageUsage {
  timestamp: string;
  model: string;
  tokens: number[]; // Uncached input, output, cache reads, cache writes, one-hour writes.
}

const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))) : 0;
const dateKey = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function costOf(message: MessageUsage): number | undefined {
  const rate = CLAUDE_PRICING[normalizeClaudeModel(message.model)];
  if (!rate) return undefined;
  const [input, output, reads, writes, hour] = message.tokens;
  const long = rate.threshold !== undefined && input + reads + writes > rate.threshold;
  const inputRate = long ? rate.longInput! : rate.input;
  const outputRate = long ? rate.longOutput! : rate.output;
  const multiplier = inputRate / rate.input;
  return (input * inputRate + output * outputRate + reads * rate.cacheRead * multiplier
    + (writes - hour) * rate.cacheWrite * multiplier + hour * rate.cacheWriteHour * multiplier) / 1_000_000;
}

async function scanFiles(directory: string, messages: Map<string, MessageUsage>, cutoff: string): Promise<void> {
  let files: fs.Dirent[];
  try { files = await fs.promises.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, file.name);
    if (file.isDirectory()) { await scanFiles(filename, messages, cutoff); continue; }
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
    const stream = fs.createReadStream(filename, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let readError: Error | undefined;
    stream.on('error', (error) => { readError = error; lines.close(); });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber++;
        let row;
        try { row = JSON.parse(line); } catch { continue; } // Includes unfinished trailing records.
        const message = row?.message;
        const usage = message?.usage;
        if (row?.type !== 'assistant' || !usage || typeof row.timestamp !== 'string' || typeof message.model !== 'string') continue;
        const timestamp = new Date(row.timestamp);
        if (!Number.isFinite(timestamp.getTime()) || dateKey(timestamp) < cutoff) continue;
        const creation = number(usage.cache_creation_input_tokens);
        const hour = number(usage.cache_creation?.ephemeral_1h_input_tokens);
        const writes = Math.max(creation, hour + number(usage.cache_creation?.ephemeral_5m_input_tokens));
        const tokens = [number(usage.input_tokens), number(usage.output_tokens), number(usage.cache_read_input_tokens), writes, hour];
        if (!tokens.some(Boolean)) continue;
        const id = typeof message.id === 'string' ? `message:${message.id}`
          : typeof row.requestId === 'string' ? `request:${row.requestId}`
          : typeof row.uuid === 'string' ? `uuid:${row.uuid}` : `${filename}:${lineNumber}`;
        const previous = messages.get(id);
        // Streaming chunks and fork copies repeat the same message usage; retain the fullest counts once.
        messages.set(id, { timestamp: previous?.timestamp || row.timestamp, model: message.model,
          tokens: tokens.map((count, index) => Math.max(count, previous?.tokens[index] || 0)) });
      }
      if (readError) throw readError;
    } finally { lines.close(); stream.destroy(); }
  }
}

function periods(rows: UsageRow[], now: Date): NonNullable<ProviderUsageHistory['local']> {
  const past = (days: number) => { const date = new Date(now); date.setDate(date.getDate() - days); return dateKey(date); };
  const today = dateKey(now), yesterday = past(1), monday = past((now.getDay() + 6) % 7), month = past(29);
  const empty = (): UsageHistoryPeriod => ({ tokensUsed: 0, requestsCount: 0, estimatedCostUSD: 0 });
  const result = { today: empty(), yesterday: empty(), week: empty(), month30: empty() };
  for (const row of rows) {
    if (row.date > today || row.date < month) continue;
    const targets = [row.date === today ? result.today : undefined, row.date === yesterday ? result.yesterday : undefined,
      row.date >= monday ? result.week : undefined, result.month30];
    for (const period of targets) {
      if (!period) continue;
      period.tokensUsed += number(row.totalTokens);
      period.requestsCount += number(row.requests);
      period.estimatedCostUSD += typeof row.costUSD === 'number' && Number.isFinite(row.costUSD) ? Math.max(0, row.costUSD) : 0;
      if (row.costIncomplete) period.costIncomplete = true;
    }
  }
  return result;
}

// Mirrors the local scanner; only daily aggregate usage leaves the remote machine.
const REMOTE_HISTORY_SCRIPT = String.raw`import json, math, os, sys
from datetime import datetime, timedelta, timezone
P=json.loads(__PRICING_JSON__)
cutoff=(datetime.now().astimezone()-timedelta(days=29)).date().isoformat()
def num(v):
 return max(0,min(9007199254740991,int(v))) if isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) else 0
def obj(v): return v if isinstance(v,dict) else {}
messages={}
home=os.path.expanduser(sys.argv[1])
for directory,dirs,files in os.walk(os.path.join(home,"projects")):
 dirs.sort()
 for name in sorted(files):
  if not name.endswith(".jsonl"): continue
  filename=os.path.join(directory,name)
  if os.path.islink(filename): continue
  with open(filename,encoding="utf-8",errors="replace") as f:
   for index,line in enumerate(f):
    try: row=obj(json.loads(line))
    except (ValueError,TypeError): continue
    message=obj(row.get("message")); usage=obj(message.get("usage")); model=message.get("model")
    if row.get("type")!="assistant" or not usage or not isinstance(model,str): continue
    try: when=datetime.fromisoformat(row.get("timestamp").replace("Z","+00:00")).astimezone()
    except (ValueError,AttributeError,TypeError): continue
    day=when.date().isoformat()
    if day<cutoff: continue
    cache=obj(usage.get("cache_creation")); hour=num(cache.get("ephemeral_1h_input_tokens"))
    writes=max(num(usage.get("cache_creation_input_tokens")),hour+num(cache.get("ephemeral_5m_input_tokens")))
    tokens=[num(usage.get("input_tokens")),num(usage.get("output_tokens")),num(usage.get("cache_read_input_tokens")),writes,hour]
    if not any(tokens): continue
    mid=message.get("id"); request=row.get("requestId"); uid=row.get("uuid")
    key="message:"+mid if isinstance(mid,str) else "request:"+request if isinstance(request,str) else "uuid:"+uid if isinstance(uid,str) else filename+":"+str(index+1)
    old=messages.get(key)
    messages[key]=(old[0] if old else day,model,[max(v,old[2][i] if old else 0) for i,v in enumerate(tokens)])
daily={}
for day,model,tokens in messages.values():
 if model.startswith("anthropic/"): model=model[len("anthropic/"):]
 if len(model)>9 and model[-9]=="-" and model[-8:].isdigit(): model=model[:-9]
 model=model.replace(".","-"); rate=P.get(model)
 inp,out,reads,writes,hour=tokens
 entry=daily.setdefault(day,{"date":day,"totalTokens":0,"requests":0,"costUSD":0})
 entry["totalTokens"]+=inp+out+reads+writes; entry["requests"]+=1
 if not rate: entry["costIncomplete"]=True; continue
 long=rate.get("threshold") is not None and inp+reads+writes>rate["threshold"]
 ir=rate["longInput"] if long else rate["input"]; output=rate["longOutput"] if long else rate["output"]; factor=ir/rate["input"]
 entry["costUSD"]+=(inp*ir+out*output+reads*rate["cacheRead"]*factor+(writes-hour)*rate["cacheWrite"]*factor+hour*rate["cacheWriteHour"]*factor)/1000000
print(json.dumps({"daily":list(daily.values())},separators=(",",":")))
`;

export function fetchRemoteClaudeLogs(config: RemoteHistoryConfig): Promise<UsageRow[]> {
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', config.sshTarget,
      `python3 - ${quote(config.claudeHome || '~/.claude')}`],
    { timeout: 15000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return reject(new Error('Remote Claude history unavailable. Check the SSH target, Claude home, and Python 3 installation.'));
      try {
        const data = JSON.parse(stdout);
        if (!Array.isArray(data.daily) || data.daily.some((row: UsageRow) => !row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date))) throw new Error();
        resolve(data.daily);
      } catch { reject(new Error('Remote Claude history returned invalid usage totals.')); }
    });
    child.stdin?.end(REMOTE_HISTORY_SCRIPT.replace('__PRICING_JSON__', JSON.stringify(JSON.stringify(CLAUDE_PRICING))));
  });
}

export async function getClaudeUsageHistory(home = getDefaultClaudeHome(), remoteConfig?: RemoteHistoryConfig, now = new Date()): Promise<ProviderUsageHistory> {
  const history: ProviderUsageHistory = { note: 'History covers this CLI directory, including other logins. Costs are API-equivalent estimates, not subscription charges.' };
  const remote = remoteConfig?.sshTarget ? fetchRemoteClaudeLogs(remoteConfig).then((rows) => { history.remote = periods(rows, now); })
    .catch((error: Error) => { history.remoteError = error.message; }) : Promise.resolve();
  try {
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 29);
    const messages = new Map<string, MessageUsage>();
    await scanFiles(path.join(home, 'projects'), messages, dateKey(cutoff));
    history.local = periods(Array.from(messages.values(), (message) => {
      const cost = costOf(message);
      return { date: dateKey(new Date(message.timestamp)), totalTokens: message.tokens.slice(0, 4).reduce((a, b) => a + b, 0),
        requests: 1, costUSD: cost || 0, costIncomplete: cost === undefined };
    }), now);
  } catch { history.note += ' Local transcript history could not be read.'; }
  await remote;
  return history;
}
