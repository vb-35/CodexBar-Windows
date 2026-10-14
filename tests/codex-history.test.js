const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zstdCompressSync, constants } = require('node:zlib');

function compressedHistoryFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-zstd-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const timestamp = new Date().toISOString();
  const record = (tokens) => JSON.stringify({ type: 'event_msg', timestamp, payload: {
    type: 'token_count', info: { total_token_usage: { input_tokens: tokens, output_tokens: 10, cached_input_tokens: 80 } },
  } });
  const context = JSON.stringify({ type: 'turn_context', timestamp, payload: { model: 'gpt-5.6-sol' } });
  const write = (name, content) => {
    const file = path.join(home, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const compress = (content) => zstdCompressSync(content, { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } });
  const plain = [context, record(100)].join('\n');
  write('sessions/nested/plain.jsonl', plain);
  write('sessions/nested/plain.jsonl.zst', compress(plain));
  write('sessions/nested/compressed.jsonl.zst', Buffer.concat([
    compress(context + '\nmalformed line\n'), compress(record(200) + '\n' + record(200)),
  ]));
  write('archived_sessions/archived.jsonl.zst', compress([context, record(300)].join('\n')));
  write('sessions/broken.jsonl.zst', 'not zstd');
  return home;
}

test('compressed active and archived sessions include usage and costs without duplicate copies', async (t) => {
  const home = compressedHistoryFixture(t);
  const { getCodexUsageHistory } = require('../dist/main/providers/codex/history.js');
  const history = await getCodexUsageHistory(home);
  assert.equal(history.local.today.tokensUsed, 630);
  assert.equal(history.local.today.requestsCount, 3);
  assert.ok(Math.abs(history.local.today.estimatedCostUSD - 0.00282) < 1e-12);
  assert.deepEqual(history.local.month30, history.local.today);
});

test('SSH calculator reads the same compressed sessions as local history', async (t) => {
  const python = ['python3', 'python'].find((binary) => childProcess.spawnSync(binary, ['-c',
    'try:\n from compression import zstd\nexcept ImportError:\n import zstandard',
  ], { windowsHide: true }).status === 0);
  if (!python) return t.skip('Python with Zstandard support is required to verify the remote calculator');
  const home = compressedHistoryFixture(t);
  t.mock.method(childProcess, 'execFile', (_binary, _args, _options, callback) => ({ stdin: { end(input) {
    const result = childProcess.spawnSync(python, ['-', home], { input, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    callback(null, result.stdout, '');
  } } }));
  const { getCodexUsageHistory } = require('../dist/main/providers/codex/history.js');
  const history = await getCodexUsageHistory(home, { sshTarget: 'fixture.test' });
  assert.equal(history.remote.today.tokensUsed, 630);
  assert.equal(history.remote.today.tokensUsed, history.local.today.tokensUsed);
  assert.equal(history.remote.today.estimatedCostUSD, history.local.today.estimatedCostUSD);
});

const pricingMarkdown = `
### Standard pricing data
| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-sol (<272K context length) | $6.00 | $0.60 | $7.50 | $36.00 | $12.00 | $1.20 | $15.00 | $54.00 |
| gpt-5.6-terra | $2.00 | $0.20 | $2.50 | $12.00 | $4.00 | $0.40 | $5.00 | $18.00 |
| gpt-5.6-luna | $0.20 | $0.02 | $0.25 | $1.20 | - | - | - | - |

## Specialized models
### Grouped Pricing Table data
| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $1.75 | $0.175 | $14.00 |
`;

test('official pricing markdown is parsed and cached without another fetch', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-pricing-'));
  const cachePath = path.join(cacheDir, 'pricing.json');
  try {
    const { loadCodexPricing, parseOpenAIPricingMarkdown } = require('../dist/main/providers/codex/pricing.js');
    const parsed = parseOpenAIPricingMarkdown(pricingMarkdown);
    assert.equal(parsed['gpt-5.6-sol'].input_cost_per_token, 6e-6);
    assert.equal(parsed['gpt-5.6-sol'].threshold_tokens, 272000);
    assert.equal(parsed['gpt-5.6-sol'].output_cost_per_token_above_threshold, 54e-6);
    assert.equal(parsed['gpt-5.6-terra'].threshold_tokens, 272000);
    assert.equal(parsed['gpt-5.6-terra'].output_cost_per_token_above_threshold, 18e-6);
    assert.equal(parsed['gpt-5.3-codex'].cache_read_input_cost_per_token, 0.175e-6);

    let fetches = 0;
    const first = await loadCodexPricing({
      cachePath,
      now: 1_000,
      fetchText: async () => { fetches += 1; return pricingMarkdown; },
    });
    const second = await loadCodexPricing({
      cachePath,
      now: 2_000,
      fetchText: async () => { throw new Error('fresh cache should be used'); },
    });
    assert.equal(first['gpt-5.6-sol'].input_cost_per_token, 6e-6);
    assert.equal(second['gpt-5.6-sol'].input_cost_per_token, 6e-6);
    assert.equal(fetches, 1);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('cached input tokens are not counted twice', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-history-'));
  const now = new Date();
  const sessionDir = path.join(
    codexHome,
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), [
    JSON.stringify({
      type: 'turn_context',
      timestamp: now.toISOString(),
      payload: { model: 'openai/gpt-5.6-sol' },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: now.toISOString(),
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 80,
            output_tokens: 10,
          },
        },
      },
    }),
  ].join('\n'));

  try {
    const { getCodexUsageHistory } = require('../dist/main/providers/codex/history.js');
    const history = await getCodexUsageHistory(codexHome);
    assert.equal(history.local.today.tokensUsed, 110);
    assert.ok(Math.abs(history.local.today.estimatedCostUSD - 0.00044) < 1e-12);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('history uses local calendar days, Monday weeks, and a 30-day window', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-history-periods-'));
  const sessionsDir = path.join(codexHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const addDays = (date, days) => {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  };
  const dateKey = (date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');

  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const entries = [
    { date: today, tokens: 1 },
    { date: addDays(today, -1), tokens: 2 },
    { date: monday, tokens: 4 },
    { date: addDays(monday, -1), tokens: 8 },
    { date: addDays(today, -29), tokens: 16 },
    { date: addDays(today, -30), tokens: 32 },
  ];

  fs.writeFileSync(path.join(sessionsDir, 'session.jsonl'), [
    JSON.stringify({
      type: 'turn_context',
      timestamp: today.toISOString(),
      payload: { model: 'openai/gpt-5.4' },
    }),
    ...entries.map(({ date, tokens }) => JSON.stringify({
      type: 'event_msg',
      timestamp: date.toISOString(),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: tokens, cached_input_tokens: 0, output_tokens: 0 },
        },
      },
    })),
  ].join('\n'));

  const sumFrom = (start) => entries
    .filter(({ date }) => date >= start && date <= today)
    .reduce((total, { tokens }) => total + tokens, 0);
  const sumOn = (target) => entries
    .filter(({ date }) => dateKey(date) === dateKey(target))
    .reduce((total, { tokens }) => total + tokens, 0);

  try {
    const { getCodexUsageHistory } = require('../dist/main/providers/codex/history.js');
    const history = await getCodexUsageHistory(codexHome);
    const expected = {
      today: sumOn(today),
      yesterday: sumOn(addDays(today, -1)),
      week: sumFrom(monday),
      month30: sumFrom(addDays(today, -29)),
    };

    assert.equal(history.local.today.tokensUsed, expected.today);
    assert.equal(history.local.yesterday.tokensUsed, expected.yesterday);
    assert.equal(history.local.week.tokensUsed, expected.week);
    assert.equal(history.local.month30.tokensUsed, expected.month30);
    assert.equal(history.remote, undefined);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('remote history streams its bundled calculator over configured SSH', async () => {
  const originalExecFile = childProcess.execFile;
  let invocation;
  let script;
  childProcess.execFile = (file, args, options, callback) => {
    invocation = { file, args, options };
    return {
      stdin: {
        end(value) {
          script = value;
          callback(null, '{"daily":[{"date":"2026-07-31","totalTokens":42,"costUSD":0.5}]}', '');
        },
      },
    };
  };

  try {
    const { fetchRemoteLogs } = require('../dist/main/providers/codex/history.js');
    const result = await fetchRemoteLogs(
      { sshTarget: 'user@example.test', codexHome: '/srv/codex home' },
      { 'custom-model': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_read_input_cost_per_token: 1e-7 } },
    );
    assert.equal(invocation.file, 'ssh');
    assert.deepEqual(invocation.args.slice(-3), ['--', 'user@example.test', "python3 - '/srv/codex home'"]);
    assert.match(script, /archived_sessions/);
    assert.match(script, /custom-model/);
    assert.doesNotMatch(script, /gpt-5\.6-sol/);
    assert.equal(result.daily[0].totalTokens, 42);
  } finally {
    childProcess.execFile = originalExecFile;
  }
});
