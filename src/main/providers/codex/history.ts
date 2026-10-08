import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { ProviderUsageHistory, RemoteHistoryConfig, UsageHistoryPeriod } from '../types';
import { getDefaultCodexHome } from './auth';
import { CodexPricingTable, FALLBACK_CODEX_PRICING } from './pricing';

interface RemoteDaily {
  date: string;
  totalTokens?: number | null;
  costUSD?: number | null;
}

interface RemoteData {
  daily?: RemoteDaily[];
}

const REMOTE_HISTORY_SCRIPT = String.raw`import json, os, sys
from datetime import datetime, timezone

P=json.loads(__PRICING_JSON__)
Z=(0,0,0)
def num(v):
 try: return max(0,int(v or 0))
 except (TypeError,ValueError): return 0
def tok(d):
 d=d if isinstance(d,dict) else {}
 return (num(d.get("input_tokens")),num(d.get("cached_input_tokens",d.get("cache_read_input_tokens"))),num(d.get("output_tokens")))
def add(a,b): return tuple(x+y for x,y in zip(a or Z,b))
def sub(a,b): return tuple(max(0,x-y) for x,y in zip(a,b or Z))
def le(a,b): return all(x<=y for x,y in zip(a,b))
def stamp(v):
 try:
  d=datetime.fromisoformat(v.replace("Z","+00:00"))
  return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d
 except (AttributeError,ValueError): return None
def load(p):
 out=[]
 try:
  with open(p,encoding="utf-8",errors="replace") as f:
   for line in f:
    try:
     o=json.loads(line)
     if isinstance(o,dict): out.append(o)
    except (json.JSONDecodeError,TypeError): pass
 except OSError: pass
 return out
def meta(objs):
 for o in objs:
  if o.get("type")!="session_meta": continue
  p=o.get("payload") if isinstance(o.get("payload"),dict) else {}
  return (p.get("session_id") or p.get("sessionId") or p.get("id") or o.get("session_id") or o.get("id"),
          p.get("forked_from_id") or p.get("forkedFromId") or p.get("parent_session_id") or p.get("parentSessionId"),
          p.get("timestamp") or o.get("timestamp"))
 return (None,None,None)
def snapshots(objs):
 out=[]; prev=None; base=None
 for o in objs:
  p=o.get("payload") if isinstance(o.get("payload"),dict) else {}
  if o.get("type")!="event_msg" or p.get("type")!="token_count": continue
  info=p.get("info") if isinstance(p.get("info"),dict) else {}; when=stamp(o.get("timestamp"))
  if not when: continue
  total=info.get("total_token_usage"); last=info.get("last_token_usage")
  if isinstance(last,dict):
   raw=tok(last); counted=raw
   if isinstance(total,dict):
    current=tok(total); change=sub(current,base)
    if base is not None and le(base,current) and le(change,raw): counted=change
    prev=add(prev,counted); base=current
   else: prev=add(prev,raw); base=prev
   out.append((when,prev))
  elif isinstance(total,dict):
   current=tok(total); prev=add(prev,sub(current,base)); base=current; out.append((when,prev))
 return out
def model_name(v):
 m=v.strip()
 if m.startswith("openai/"): m=m[len("openai/"):]
 if m in P: return m
 if len(m)>11 and m[-11]=="-" and m[:-11] in P: return m[:-11]
 return m
def price(model,t):
 p=P.get(model_name(model))
 if not p: return None
 inp,cache,out=t; cache=min(cache,inp); threshold=p.get("threshold_tokens"); long=threshold is not None and inp>threshold
 ir=p.get("input_cost_per_token_above_threshold") if long else p["input_cost_per_token"]
 out_r=p.get("output_cost_per_token_above_threshold") if long else p["output_cost_per_token"]
 cache_r=p.get("cache_read_input_cost_per_token_above_threshold") if long else p.get("cache_read_input_cost_per_token")
 if cache_r is None: cache_r=ir
 return (inp-cache)*ir+cache*cache_r+out*out_r

home=os.path.expanduser(sys.argv[1] if len(sys.argv)>1 else "~/.codex")
files=[]
for root in ("sessions","archived_sessions"):
 base=os.path.join(home,root)
 for directory,_,names in os.walk(base):
  files.extend(os.path.join(directory,n) for n in names if n.endswith(".jsonl"))
files.sort(); objects={f:load(f) for f in files}; by_id={}
for f,objs in objects.items():
 sid,_,_=meta(objs)
 if isinstance(sid,str): by_id[sid]=objs
daily={}
for f in files:
 objs=objects[f]; _,parent,fork_time=meta(objs); inherited=None
 if isinstance(parent,str) and parent in by_id:
  cutoff=stamp(fork_time) if fork_time else None
  for when,total in snapshots(by_id[parent]):
   if cutoff is None or when<=cutoff: inherited=total
   else: break
 current_model=None; previous=None; baseline=None; remaining=inherited
 for o in objs:
  payload=o.get("payload") if isinstance(o.get("payload"),dict) else {}
  if o.get("type")=="turn_context":
   info=payload.get("info") if isinstance(payload.get("info"),dict) else {}
   candidate=payload.get("model") or info.get("model") or info.get("model_name")
   if isinstance(candidate,str): current_model=candidate
   continue
  if o.get("type")!="event_msg" or payload.get("type")!="token_count": continue
  when=stamp(o.get("timestamp"))
  if not when: continue
  info=payload.get("info") if isinstance(payload.get("info"),dict) else {}
  total=info.get("total_token_usage"); last=info.get("last_token_usage"); change=None
  if isinstance(last,dict):
   raw=tok(last)
   if remaining is not None:
    change=sub(raw,remaining); remaining=sub(remaining,raw)
    if remaining==Z: remaining=None
   else: change=raw
   if isinstance(total,dict):
    current=sub(tok(total),inherited); total_change=sub(current,baseline)
    if remaining is None and baseline is not None and le(baseline,current) and le(total_change,raw): change=total_change
    previous=add(previous,change); baseline=current
   else: previous=add(previous,change); baseline=previous
  elif isinstance(total,dict):
   current=sub(tok(total),inherited); change=sub(current,baseline); previous=add(previous,change); baseline=current; remaining=None
  if change is None or change==Z: continue
  candidate=current_model or info.get("model") or info.get("model_name") or payload.get("model") or o.get("model") or "gpt-5"
  model=model_name(candidate if isinstance(candidate,str) else "gpt-5"); day=when.astimezone().date().isoformat()
  entry=daily.setdefault(day,{"date":day,"totalTokens":0,"costUSD":0.0,"hasCost":False})
  entry["totalTokens"]+=change[0]+change[2]; value=price(model,change)
  if value is not None: entry["costUSD"]+=value; entry["hasCost"]=True
result=[]
for day in sorted(daily):
 entry=daily[day]; entry["costUSD"]=entry["costUSD"] if entry.pop("hasCost") else None; result.append(entry)
print(json.dumps({"daily":result},separators=(",",":")))
`;

function quoteRemoteArgument(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function fetchRemoteLogs(
  config?: RemoteHistoryConfig,
  pricing: CodexPricingTable = FALLBACK_CODEX_PRICING,
): Promise<RemoteData | null> {
  if (!config?.sshTarget) return Promise.resolve(null);
  return new Promise((resolve) => {
    const remoteCommand = `python3 - ${quoteRemoteArgument(config.codexHome || '~/.codex')}`;
    const child = execFile('ssh', [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '--',
      config.sshTarget,
      remoteCommand,
    ], { timeout: 15000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) {
        console.error('[Codex History] SSH remote history failed:', error.message);
        return resolve(null);
      }
      try {
        const data = JSON.parse(stdout) as RemoteData;
        resolve(Array.isArray(data.daily) ? data : null);
      } catch (parseError) {
        console.error('[Codex History] Failed to parse remote logs JSON:', parseError);
        resolve(null);
      }
    });
    child.stdin?.end(REMOTE_HISTORY_SCRIPT.replace('__PRICING_JSON__', JSON.stringify(JSON.stringify(pricing))));
  });
}

class Totals {
  input: number;
  cached: number;
  output: number;

  constructor(input = 0, cached = 0, output = 0) {
    this.input = input;
    this.cached = cached;
    this.output = output;
  }

  add(other: Totals): Totals {
    return new Totals(
      this.input + other.input,
      this.cached + other.cached,
      this.output + other.output
    );
  }

  deltaFrom(baseline: Totals | null): Totals {
    const base = baseline || new Totals();
    return new Totals(
      Math.max(0, this.input - base.input),
      Math.max(0, this.cached - base.cached),
      Math.max(0, this.output - base.output)
    );
  }

  isZero(): boolean {
    return this.input === 0 && this.cached === 0 && this.output === 0;
  }
}

interface UsageRow {
  day: string;
  model: string;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}

function normalizeCodexModel(raw: string, pricing: CodexPricingTable): string {
  let model = raw.trim();
  if (model.startsWith('openai/')) {
    model = model.substring('openai/'.length);
  }
  if (pricing[model]) {
    return model;
  }
  if (model.length > 11 && model.charAt(model.length - 11) === '-') {
    const parts = model.split('-');
    if (parts.length >= 3) {
      const base = parts.slice(0, parts.length - 3).join('-');
      if (pricing[base]) {
        return base;
      }
    }
  }
  return model;
}

function codexCostUSD(pricingTable: CodexPricingTable, model: string, inputTokens: number, cachedInputTokens: number, outputTokens: number): number | null {
  const pricing = pricingTable[normalizeCodexModel(model, pricingTable)];
  if (!pricing) return null;

  const cached = Math.min(Math.max(0, cachedInputTokens), Math.max(0, inputTokens));
  const nonCached = Math.max(0, inputTokens - cached);
  
  let cachedRate = pricing.cache_read_input_cost_per_token;
  if (cachedRate === null) {
    cachedRate = pricing.input_cost_per_token;
  }

  const useLongContext = pricing.threshold_tokens !== undefined && Math.max(0, inputTokens) > pricing.threshold_tokens;

  const inputRate = (useLongContext && pricing.input_cost_per_token_above_threshold !== undefined)
    ? pricing.input_cost_per_token_above_threshold
    : pricing.input_cost_per_token;

  const outputRate = (useLongContext && pricing.output_cost_per_token_above_threshold !== undefined)
    ? pricing.output_cost_per_token_above_threshold
    : pricing.output_cost_per_token;

  const cachedInputRate = useLongContext
    ? (pricing.cache_read_input_cost_per_token_above_threshold ?? inputRate)
    : cachedRate;

  return (
    nonCached * inputRate +
    cached * cachedInputRate +
    Math.max(0, outputTokens) * outputRate
  );
}

function parseTimestampToLocalDay(text: string): string | null {
  try {
    const dt = new Date(text);
    if (isNaN(dt.getTime())) return null;
    
    const year = dt.getFullYear();
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

function parseTimestamp(text: string): Date | null {
  try {
    const dt = new Date(text);
    return isNaN(dt.getTime()) ? null : dt;
  } catch {
    return null;
  }
}

function toInt(value: any): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function totalDeltaLessThanEqual(a: Totals, b: Totals): boolean {
  return a.input <= b.input && a.cached <= b.cached && a.output <= b.output;
}

async function loadJsonlObjects(filePath: string): Promise<any[]> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const objects: any[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj === 'object' && obj !== null) {
          objects.push(obj);
        }
      } catch {
        // ignore
      }
    }
    return objects;
  } catch {
    return [];
  }
}

function parseSessionMeta(objects: any[]): [string | null, string | null, string | null] {
  for (const obj of objects) {
    if (obj.type !== 'session_meta') continue;
    const payload = obj.payload || {};
    const sessionId = payload.session_id || payload.sessionId || payload.id || obj.session_id || obj.sessionId || obj.id;
    const forkedFromId = payload.forked_from_id || payload.forkedFromId || payload.parent_session_id || payload.parentSessionId;
    const forkTimestamp = payload.timestamp || obj.timestamp;
    return [
      typeof sessionId === 'string' ? sessionId : null,
      typeof forkedFromId === 'string' ? forkedFromId : null,
      typeof forkTimestamp === 'string' ? forkTimestamp : null
    ];
  }
  return [null, null, null];
}

function tokenSnapshots(objects: any[]): Array<[Date, Totals]> {
  const snapshots: Array<[Date, Totals]> = [];
  let previousTotals: Totals | null = null;
  let rawTotalsBaseline: Totals | null = null;

  for (const obj of objects) {
    if (obj.type !== 'event_msg') continue;
    const payload = obj.payload || {};
    if (payload.type !== 'token_count') continue;
    const info = payload.info || {};
    const timestampText = obj.timestamp;
    if (typeof timestampText !== 'string') continue;
    const timestamp = parseTimestamp(timestampText);
    if (!timestamp) continue;

    const total = info.total_token_usage;
    const last = info.last_token_usage;

    if (last) {
      const rawDelta = new Totals(
        Math.max(0, toInt(last.input_tokens)),
        Math.max(0, toInt(last.cached_input_tokens || last.cache_read_input_tokens)),
        Math.max(0, toInt(last.output_tokens))
      );
      const base: Totals = previousTotals || new Totals();
      let countedDelta = rawDelta;
      
      if (total) {
        const rawTotals = new Totals(
          toInt(total.input_tokens),
          toInt(total.cached_input_tokens || total.cache_read_input_tokens),
          toInt(total.output_tokens)
        );
        const totalDelta = rawTotals.deltaFrom(rawTotalsBaseline);
        if (
          rawTotalsBaseline !== null &&
          rawTotals.input >= rawTotalsBaseline.input &&
          rawTotals.cached >= rawTotalsBaseline.cached &&
          rawTotals.output >= rawTotalsBaseline.output &&
          totalDeltaLessThanEqual(totalDelta, rawDelta)
        ) {
          countedDelta = totalDelta;
        }
        previousTotals = base.add(countedDelta);
        rawTotalsBaseline = rawTotals;
      } else {
        previousTotals = base.add(countedDelta);
        rawTotalsBaseline = previousTotals;
      }
      if (previousTotals) {
        snapshots.push([timestamp, previousTotals]);
      }
    } else if (total) {
      const current = new Totals(
        toInt(total.input_tokens),
        toInt(total.cached_input_tokens || total.cache_read_input_tokens),
        toInt(total.output_tokens)
      );
      const delta = current.deltaFrom(rawTotalsBaseline);
      previousTotals = (previousTotals || new Totals()).add(delta);
      rawTotalsBaseline = current;
      if (previousTotals) {
        snapshots.push([timestamp, previousTotals]);
      }
    }
  }

  return snapshots;
}

async function inheritedTotalsFor(
  sessionId: string,
  forkTimestamp: string | null,
  sessionFileById: Record<string, string>,
  snapshotCache: Record<string, Array<[Date, Totals]>>
): Promise<Totals | null> {
  const parentPath = sessionFileById[sessionId];
  if (!parentPath) return null;

  if (!snapshotCache[sessionId]) {
    snapshotCache[sessionId] = tokenSnapshots(await loadJsonlObjects(parentPath));
  }

  const snapshots = snapshotCache[sessionId];
  if (!snapshots || snapshots.length === 0) return null;

  const cutoff = forkTimestamp ? parseTimestamp(forkTimestamp) : null;
  let inherited: Totals | null = null;
  for (const [snapshotTime, totals] of snapshots) {
    if (!cutoff || snapshotTime.getTime() <= cutoff.getTime()) {
      inherited = totals;
    } else {
      break;
    }
  }
  return inherited;
}

async function findJsonlFiles(dir: string, fileList: string[]): Promise<void> {
  try {
    const files = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dir, file.name);
      if (file.isDirectory()) {
        await findJsonlFiles(filePath, fileList);
      } else if (file.isFile() && file.name.endsWith('.jsonl')) {
        fileList.push(filePath);
      }
    }
  } catch (err) {
    // silent
  }
}

async function iterCodexFiles(codexHome: string): Promise<string[]> {
  const files: string[] = [];
  for (const directory of ['sessions', 'archived_sessions']) {
    await findJsonlFiles(path.join(codexHome, directory), files);
  }
  return files.sort();
}

async function buildSessionIndex(files: string[]): Promise<Record<string, string>> {
  const sessionFileById: Record<string, string> = {};
  for (const filePath of files) {
    const [sessionId] = parseSessionMeta(await loadJsonlObjects(filePath));
    if (sessionId) {
      sessionFileById[sessionId] = filePath;
    }
  }
  return sessionFileById;
}

async function scanCodexRows(codexHome: string, pricing: CodexPricingTable): Promise<UsageRow[]> {
  const files = await iterCodexFiles(codexHome);
  const sessionFileById = await buildSessionIndex(files);
  const snapshotCache: Record<string, Array<[Date, Totals]>> = {};
  const rows: UsageRow[] = [];

  for (const filePath of files) {
    const objects = await loadJsonlObjects(filePath);
    const [sessionId, forkedFromId, forkTimestamp] = parseSessionMeta(objects);
    
    let inheritedTotals: Totals | null = null;
    if (forkedFromId) {
      inheritedTotals = await inheritedTotalsFor(
        forkedFromId,
        forkTimestamp,
        sessionFileById,
        snapshotCache
      );
    }

    let currentModel: string | null = null;
    let previousTotals: Totals | null = null;
    let rawTotalsBaseline: Totals | null = null;
    let remainingInherited = inheritedTotals 
      ? new Totals(inheritedTotals.input, inheritedTotals.cached, inheritedTotals.output)
      : null;

    for (const obj of objects) {
      const objType = obj.type;
      if (objType === 'turn_context') {
        const payload = obj.payload || {};
        let model = payload.model;
        if (typeof model !== 'string') {
          const info = payload.info || {};
          model = info.model || info.model_name;
        }
        if (typeof model === 'string') {
          currentModel = model;
        }
        continue;
      }

      if (objType !== 'event_msg') continue;
      const payload = obj.payload || {};
      if (payload.type !== 'token_count') continue;
      
      const timestampText = obj.timestamp;
      if (typeof timestampText !== 'string') continue;
      const dayKey = parseTimestampToLocalDay(timestampText);
      if (!dayKey) continue;

      const info = payload.info || {};
      let model = currentModel || info.model || info.model_name || payload.model || obj.model || 'gpt-5';
      if (typeof model !== 'string') {
        model = 'gpt-5';
      }
      model = normalizeCodexModel(model, pricing);

      const total = info.total_token_usage;
      const last = info.last_token_usage;

      let delta: Totals | null = null;

      if (last) {
        const rawDelta = new Totals(
          Math.max(0, toInt(last.input_tokens)),
          Math.max(0, toInt(last.cached_input_tokens || last.cache_read_input_tokens)),
          Math.max(0, toInt(last.output_tokens))
        );
        
        if (remainingInherited) {
          const adjusted = new Totals(
            Math.max(0, rawDelta.input - remainingInherited.input),
            Math.max(0, rawDelta.cached - remainingInherited.cached),
            Math.max(0, rawDelta.output - remainingInherited.output)
          );
          remainingInherited = new Totals(
            Math.max(0, remainingInherited.input - rawDelta.input),
            Math.max(0, remainingInherited.cached - rawDelta.cached),
            Math.max(0, remainingInherited.output - rawDelta.output)
          );
          if (remainingInherited.isZero()) {
            remainingInherited = null;
          }
          delta = adjusted;
        } else {
          delta = rawDelta;
        }

        if (total) {
          const rawTotals = new Totals(
            toInt(total.input_tokens),
            toInt(total.cached_input_tokens || total.cache_read_input_tokens),
            toInt(total.output_tokens)
          );
          const currentTotals = rawTotals.deltaFrom(inheritedTotals);
          const totalDelta = currentTotals.deltaFrom(rawTotalsBaseline);
          if (
            !remainingInherited &&
            rawTotalsBaseline !== null &&
            currentTotals.input >= rawTotalsBaseline.input &&
            currentTotals.cached >= rawTotalsBaseline.cached &&
            currentTotals.output >= rawTotalsBaseline.output &&
            totalDeltaLessThanEqual(totalDelta, rawDelta)
          ) {
            delta = totalDelta;
          }
          previousTotals = (previousTotals || new Totals()).add(delta);
          rawTotalsBaseline = currentTotals;
        } else {
          previousTotals = (previousTotals || new Totals()).add(delta);
          rawTotalsBaseline = previousTotals;
        }
      } else if (total) {
        const rawTotals = new Totals(
          toInt(total.input_tokens),
          toInt(total.cached_input_tokens || total.cache_read_input_tokens),
          toInt(total.output_tokens)
        );
        const currentTotals = rawTotals.deltaFrom(inheritedTotals);
        delta = currentTotals.deltaFrom(rawTotalsBaseline);
        previousTotals = (previousTotals || new Totals()).add(delta);
        rawTotalsBaseline = currentTotals;
        remainingInherited = null;
      }

      if (!delta || delta.isZero()) continue;

      const clampedCached = Math.min(delta.cached, delta.input);
      const costUsd = codexCostUSD(
        pricing,
        model,
        delta.input,
        clampedCached,
        delta.output
      );

      rows.push({
        day: dayKey,
        model,
        input_tokens: delta.input,
        cached_tokens: clampedCached,
        output_tokens: delta.output,
        cost_usd: costUsd
      });
    }
  }

  return rows;
}

export async function getCodexUsageHistory(
  codexHome: string = getDefaultCodexHome(),
  remoteConfig?: RemoteHistoryConfig,
  pricing: CodexPricingTable = FALLBACK_CODEX_PRICING,
): Promise<ProviderUsageHistory> {
  let rows: UsageRow[] = [];
  try {
    rows = await scanCodexRows(codexHome, pricing);
  } catch (err) {
    console.error('Error scanning Codex session rows:', err);
  }

  const now = new Date();
  
  const getLocalDateStr = (dateObj: Date): string => {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const todayStr = getLocalDateStr(now);

  const getPastDateStr = (daysAgo: number): string => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    return getLocalDateStr(d);
  };

  const yesterdayStr = getPastDateStr(1);
  const weekStartStr = getPastDateStr((now.getDay() + 6) % 7);
  const monthStartStr = getPastDateStr(29);

  const todayPeriod: UsageHistoryPeriod = { tokensUsed: 0, requestsCount: 0, estimatedCostUSD: 0 };
  const yesterdayPeriod: UsageHistoryPeriod = { tokensUsed: 0, requestsCount: 0, estimatedCostUSD: 0 };
  const weekPeriod: UsageHistoryPeriod = { tokensUsed: 0, requestsCount: 0, estimatedCostUSD: 0 };
  const month30Period: UsageHistoryPeriod = { tokensUsed: 0, requestsCount: 0, estimatedCostUSD: 0 };

  for (const row of rows) {
    const totalTokens = row.input_tokens + row.output_tokens;
    const cost = row.cost_usd || 0;

    if (row.day === todayStr) {
      todayPeriod.tokensUsed += totalTokens;
      todayPeriod.requestsCount += 1;
      todayPeriod.estimatedCostUSD += cost;
    }

    if (row.day === yesterdayStr) {
      yesterdayPeriod.tokensUsed += totalTokens;
      yesterdayPeriod.requestsCount += 1;
      yesterdayPeriod.estimatedCostUSD += cost;
    }

    if (row.day >= weekStartStr && row.day <= todayStr) {
      weekPeriod.tokensUsed += totalTokens;
      weekPeriod.requestsCount += 1;
      weekPeriod.estimatedCostUSD += cost;
    }

    if (row.day >= monthStartStr && row.day <= todayStr) {
      month30Period.tokensUsed += totalTokens;
      month30Period.requestsCount += 1;
      month30Period.estimatedCostUSD += cost;
    }
  }

  // Fetch remote SSH logs separately
  const local = {
    today: todayPeriod,
    yesterday: yesterdayPeriod,
    week: weekPeriod,
    month30: month30Period
  };

  let remote: { today: UsageHistoryPeriod; yesterday: UsageHistoryPeriod; week: UsageHistoryPeriod; month30: UsageHistoryPeriod } | undefined;
  try {
    const remoteData = await fetchRemoteLogs(remoteConfig, pricing);
    if (remoteData && Array.isArray(remoteData.daily)) {
      const remoteToday: UsageHistoryPeriod = { tokensUsed: 0, requestsCount: 0, estimatedCostUSD: 0 };
      const remoteYesterday: UsageHistoryPeriod = { tokensUsed: 0, requestsCount: 0, estimatedCostUSD: 0 };
      const remoteWeek: UsageHistoryPeriod = { tokensUsed: 0, requestsCount: 0, estimatedCostUSD: 0 };
      const remoteMonth30: UsageHistoryPeriod = { tokensUsed: 0, requestsCount: 0, estimatedCostUSD: 0 };

      for (const entry of remoteData.daily) {
        if (!entry.date) continue;
        const totalTokens = entry.totalTokens || 0;
        const cost = entry.costUSD || 0;
        const isActive = totalTokens > 0;
        const reqIncrement = isActive ? 1 : 0;

        if (entry.date === todayStr) {
          remoteToday.tokensUsed += totalTokens;
          remoteToday.requestsCount += reqIncrement;
          remoteToday.estimatedCostUSD += cost;
        }

        if (entry.date === yesterdayStr) {
          remoteYesterday.tokensUsed += totalTokens;
          remoteYesterday.requestsCount += reqIncrement;
          remoteYesterday.estimatedCostUSD += cost;
        }

        if (entry.date >= weekStartStr && entry.date <= todayStr) {
          remoteWeek.tokensUsed += totalTokens;
          remoteWeek.requestsCount += reqIncrement;
          remoteWeek.estimatedCostUSD += cost;
        }

        if (entry.date >= monthStartStr && entry.date <= todayStr) {
          remoteMonth30.tokensUsed += totalTokens;
          remoteMonth30.requestsCount += reqIncrement;
          remoteMonth30.estimatedCostUSD += cost;
        }
      }

      remote = {
        today: remoteToday,
        yesterday: remoteYesterday,
        week: remoteWeek,
        month30: remoteMonth30
      };
    }
  } catch (remoteErr) {
    console.error('[Codex History] SSH remote logs fetch failed gracefully:', remoteErr);
  }

  return {
    local,
    remote
  };
}
