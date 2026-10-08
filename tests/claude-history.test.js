const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const children = require('node:child_process');
const { getClaudeUsageHistory, fetchRemoteClaudeLogs } = require('../dist/main/providers/claude/history.js');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-claude-history-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function writeLog(home, filename, rows) {
  const file = path.join(home, 'projects', filename);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
}
function record(id, date, usage, model = 'claude-sonnet-4-6') {
  return { type: 'assistant', timestamp: date.toISOString(), message: { id, model, usage } };
}

test('Claude history counts full streamed usage once across fork copies and subagents, including both cache TTLs', async (t) => {
  const home = tempHome(t), now = new Date();
  const first = record('msg-one', now, { input_tokens: 100, output_tokens: 2, cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 } }, 'anthropic/claude-sonnet-4-6-20260101');
  const complete = { ...first, message: { ...first.message, usage: { ...first.message.usage, output_tokens: 20 } } };
  writeLog(home, 'project/session.jsonl', [first, complete, '{unfinished', null, { ...complete, type: 'user' },
    { ...complete, timestamp: 'invalid' }, record('zero', now, { input_tokens: -1, output_tokens: '30' })]);
  writeLog(home, 'project/fork.jsonl', [first, complete]);
  writeLog(home, 'project/session/subagents/agent.jsonl', [record('agent', now, { input_tokens: 10, output_tokens: 5 }, 'claude-haiku-4-5')]);
  const history = await getClaudeUsageHistory(home);
  assert.equal(history.local.today.tokensUsed, 195);
  assert.equal(history.local.today.requestsCount, 2);
  assert.ok(Math.abs(history.local.today.estimatedCostUSD - (0.000666 + 0.000035)) < 1e-12);
  assert.equal(history.remote, undefined);
  assert.match(history.note, /including other logins/);
  assert.match(history.note, /not subscription charges/);
});

test('Claude periods use calendar days, Monday weeks, a 30-day window, and exclude future rows', async (t) => {
  const home = tempHome(t), now = new Date(2026, 9, 8, 12);
  const daysAgo = (days) => { const date = new Date(now); date.setDate(date.getDate() - days); return date; };
  const data = [[0, 1], [1, 2], [3, 4], [4, 8], [29, 16], [30, 32], [-1, 64]];
  writeLog(home, 'session.jsonl', data.map(([days, tokens]) => record(`msg-${days}`, daysAgo(days), { input_tokens: tokens })));
  const history = await getClaudeUsageHistory(home, undefined, now);
  assert.equal(history.local.today.tokensUsed, 1);
  assert.equal(history.local.yesterday.tokensUsed, 2);
  assert.equal(history.local.week.tokensUsed, 7);
  assert.equal(history.local.month30.tokensUsed, 31);
});

test('unknown model prices stay visibly incomplete and long context uses the higher tier', async (t) => {
  const home = tempHome(t), now = new Date();
  writeLog(home, 'session.jsonl', [record('unknown', now, { input_tokens: 10 }, 'claude-future-model'),
    record('long', now, { input_tokens: 100001, output_tokens: 10 }, 'claude-haiku-5-5')]);
  const history = await getClaudeUsageHistory(home);
  assert.equal(history.local.today.tokensUsed, 100021);
  assert.equal(history.local.today.costIncomplete, true);
  assert.ok(Math.abs(history.local.today.estimatedCostUSD - 0.0500255) < 1e-12);
});

test('SSH history runs the bundled calculator with quoted paths and exposes only aggregate usage', async (t) => {
  const home = tempHome(t), now = new Date();
  const entry = record('message', now, { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 6, ephemeral_5m_input_tokens: 4 } });
  writeLog(home, 'session.jsonl', [entry, entry]);
  writeLog(home, 'subagents/agent.jsonl', [record('unknown', now, { input_tokens: 3 }, 'unknown-model')]);
  const python = ['python3', 'python'].find((binary) => children.spawnSync(binary, ['--version'], { windowsHide: true }).status === 0);
  if (!python) return t.skip('Python is required to verify the remote calculator');
  let script;
  t.mock.method(children, 'execFile', (binary, args, options, callback) => {
    assert.equal(binary, 'ssh'); assert.equal(options.windowsHide, true);
    assert.equal(args.at(-2), 'user@example.test');
    assert.equal(args.at(-1), "python3 - '/srv/Claude'\"'\"'s home'");
    return { stdin: { end(input) {
      script = input;
      const result = children.spawnSync(python, ['-', home], { input, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      callback(null, result.stdout, '');
    } } };
  });
  const rows = await fetchRemoteClaudeLogs({ sshTarget: 'user@example.test', claudeHome: "/srv/Claude's home" });
  assert.equal(rows.length, 1); assert.equal(rows[0].totalTokens, 183); assert.equal(rows[0].requests, 2);
  assert.equal(rows[0].costIncomplete, true);
  assert.ok(Math.abs(rows[0].costUSD - 0.000666) < 1e-12);
  assert.doesNotMatch(script, /credentials|accessToken|refreshToken/);
  const history = await getClaudeUsageHistory(home, { sshTarget: 'user@example.test', claudeHome: "/srv/Claude's home" });
  assert.deepEqual(history.remote, history.local, 'local and remote scanners agree');
});

test('SSH failures retain local history and report an actionable error', async (t) => {
  const home = tempHome(t);
  writeLog(home, 'session.jsonl', [record('local', new Date(), { input_tokens: 42 })]);
  t.mock.method(children, 'execFile', (_binary, _args, _options, callback) => {
    return { stdin: { end() { callback(new Error('offline'), '', ''); } } };
  });
  const history = await getClaudeUsageHistory(home, { sshTarget: 'example.test' });
  assert.equal(history.local.today.tokensUsed, 42); assert.equal(history.remote, undefined);
  assert.match(history.remoteError, /SSH target/);
});

test('unreadable transcripts return a warning without failing the provider refresh', async (t) => {
  const home = tempHome(t);
  writeLog(home, 'session.jsonl', []);
  t.mock.method(fs, 'createReadStream', () => {
    const { Readable } = require('node:stream');
    return new Readable({ read() { this.destroy(new Error('access denied')); } });
  });
  const history = await getClaudeUsageHistory(home);
  assert.equal(history.local, undefined);
  assert.match(history.note, /could not be read/);
});
