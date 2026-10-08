const test = require('node:test');
const assert = require('node:assert/strict');
const accounts = require('../dist/main/codex-accounts.js');
const { codexProvider } = require('../dist/main/providers/codex/index.js');
const { RefreshManager } = require('../dist/main/refresh.js');

test('account switches reuse snapshots, deduplicate requests, and ignore late responses', async (t) => {
  t.mock.method(accounts, 'getCodexAccountState', (config) => config.codexAccounts);
  const config = (id) => ({
    version: 1,
    providers: [{ id: 'codex', enabled: true }],
    codexAccounts: {
      activeAccountId: id,
      accounts: ['a', 'b'].map((id) => ({ id, managedHomePath: id, authFingerprint: id })),
    },
  });
  const requests = [];
  t.mock.method(codexProvider, 'fetch', (_provider, config, onUsage) => new Promise((resolve) => {
    requests.push({ id: config.codexAccounts.activeAccountId, onUsage, resolve });
  }));
  let display;
  let refreshing = false;
  const manager = new RefreshManager(config('a'), (data) => { display = data; },
    () => { refreshing = true; }, () => { refreshing = false; });
  t.after(() => manager.stop());
  const usage = (id) => ({ identity: id, updatedAt: Date.now(), sourceLabel: 'test' });

  const a = manager.refresh();
  const duplicate = manager.refresh();
  assert.equal(requests.length, 1);
  requests[0].onUsage(usage('a'));
  assert.equal(display.codex.identity, 'a', 'limits display before history completes');

  manager.updateConfig(config('b'));
  const b = manager.refresh(false);
  assert.equal(requests.length, 2, 'B starts without waiting for A');
  assert.deepEqual(display, {}, 'never show A under B');
  requests[0].onUsage(usage('a'));
  assert.deepEqual(display, {}, 'ignore partial updates from A');

  manager.updateConfig(config('a'));
  assert.equal(display.codex.identity, 'a', 'partial snapshot is available on return');
  manager.updateConfig(config('b'));
  requests[1].resolve({ providerId: 'codex', usage: usage('b') });
  await b;
  assert.equal(display.codex.identity, 'b');
  assert.equal(refreshing, false);
  requests[0].resolve({ providerId: 'codex', usage: usage('a') });
  await Promise.all([a, duplicate]);
  assert.equal(display.codex.identity, 'b', 'late A cannot overwrite B');

  manager.updateConfig(config('a'));
  assert.equal(display.codex.identity, 'a', 'cached return is synchronous');
  await manager.refresh(false);
  assert.equal(requests.length, 2, 'fresh cached tab does not fetch again');

  const manual = manager.refresh();
  assert.equal(requests.length, 3, 'manual refresh bypasses fresh cache');
  requests[2].resolve({ providerId: 'codex', usage: usage('a') });
  await manual;

  const changedAuth = config('a');
  changedAuth.codexAccounts.accounts[0].authFingerprint = 'replacement';
  manager.updateConfig(changedAuth);
  assert.deepEqual(display, {}, 'new credentials cannot reuse old usage');
  const replacement = manager.refresh(false);
  assert.equal(requests.length, 4);
  const disabled = config('a');
  disabled.providers[0].enabled = false;
  manager.updateConfig(disabled);
  await manager.refresh();
  requests[3].resolve({ providerId: 'codex', usage: usage('a') });
  await replacement;
  assert.deepEqual(display, {}, 'disabled provider stays hidden after a late response');
});

test('Codex publishes limits before waiting for pricing and history', async (t) => {
  const oauth = require('../dist/main/providers/codex/oauth.js');
  const pricing = require('../dist/main/providers/codex/pricing.js');
  const history = require('../dist/main/providers/codex/history.js');
  t.mock.method(accounts, 'resolveActiveCodexTarget', () => ({ homePath: 'test-home' }));
  const usage = { identity: 'test', updatedAt: 1, sourceLabel: 'test' };
  t.mock.method(oauth, 'fetchViaOAuth', async () => ({ providerId: 'codex', usage }));
  let finishPricing;
  t.mock.method(pricing, 'loadCodexPricing', () => new Promise((resolve) => { finishPricing = resolve; }));
  t.mock.method(history, 'getCodexUsageHistory', async () => ({ local: {} }));
  let published;
  const pending = codexProvider.fetch({ id: 'codex', source: 'oauth' }, undefined, (data) => { published = data; });
  await new Promise(setImmediate);
  assert.equal(published.identity, 'test');
  assert.equal(published.history, undefined);
  finishPricing({});
  assert.deepEqual((await pending).usage.history, { local: {} });
});

test('Claude switches keep independent snapshots and ignore a previous account response', async (t) => {
  const claudeAccounts = require('../dist/main/claude-accounts.js');
  const { claudeProvider } = require('../dist/main/providers/claude/index.js');
  t.mock.method(accounts, 'getCodexAccountState', () => ({ accounts: [] }));
  t.mock.method(claudeAccounts, 'getClaudeAccountState', (config) => config.claudeAccounts);
  const config = (id) => ({ version: 1, providers: [{ id: 'claude', enabled: true }], claudeAccounts: {
    activeAccountId: id, accounts: ['a', 'b'].map((id) => ({ id, managedHomePath: id, authFingerprint: id })),
  } });
  const requests = [];
  t.mock.method(claudeProvider, 'fetch', (_provider, config) => new Promise((resolve) => {
    requests.push({ id: config.claudeAccounts.activeAccountId, resolve });
  }));
  let display;
  const manager = new RefreshManager(config('a'), (data) => { display = data; }, () => {}, () => {});
  t.after(() => manager.stop());
  const a = manager.refresh();
  manager.updateConfig(config('b'));
  assert.deepEqual(display, {});
  const b = manager.refresh();
  assert.deepEqual(requests.map((request) => request.id), ['a', 'b']);
  requests[1].resolve({ providerId: 'claude', usage: { identity: 'b' } });
  await b;
  requests[0].resolve({ providerId: 'claude', usage: { identity: 'a' } });
  await a;
  assert.equal(display.claude.identity, 'b');
  manager.updateConfig(config('a'));
  assert.equal(display.claude.identity, 'a');
  await manager.refresh(false);
  assert.equal(requests.length, 2);
});
