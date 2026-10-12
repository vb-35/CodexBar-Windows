const test = require('node:test');
const assert = require('node:assert/strict');
const codexAccounts = require('../dist/main/codex-accounts.js');
const claudeAccounts = require('../dist/main/claude-accounts.js');
const { AccountUsagePoller, getAccountUsageTargets } = require('../dist/main/account-usage.js');
const { formatSessionCountdown, getRemainingPercent, summarizeAccountUsage } = require('../dist/shared/popover-model.js');

const now = 1_800_000_000_000;
const nowSeconds = now / 1000;
const session = (usedPercent, secondsLeft) => ({ usedPercent, resetAt: nowSeconds + secondsLeft, limitWindowSeconds: 18000, label: 'Session' });
const weekly = (usedPercent) => ({ usedPercent, resetAt: nowSeconds + 3 * 86400, limitWindowSeconds: 604800, label: 'Weekly' });

test('summary picks windows by length and drops the timer of an idle Codex session', () => {
  assert.deepEqual(summarizeAccountUsage({ primary: weekly(18), secondary: session(36, 8000) }, now),
    { session: session(36, 8000), weekly: weekly(18) });
  assert.equal(summarizeAccountUsage({ primary: session(0, 18000) }, now).session.resetAt, 0);
  assert.equal(summarizeAccountUsage({ primary: session(0, 17000) }, now).session.resetAt, nowSeconds + 17000);
  assert.deepEqual(summarizeAccountUsage({ secondary: weekly(5) }, now), { session: undefined, weekly: weekly(5) });
});

test('remaining percent restores after reset and countdown is compact', () => {
  assert.equal(getRemainingPercent(session(36, 100), now), 64);
  assert.equal(getRemainingPercent(session(36, -1), now), 100);
  assert.equal(getRemainingPercent({ ...session(120, 10) }, now), 0);
  assert.equal(formatSessionCountdown(session(1, 2 * 3600 + 14 * 60 + 30), now), '2h14');
  assert.equal(formatSessionCountdown(session(1, 38 * 60 + 5), now), '38m');
  assert.equal(formatSessionCountdown(session(1, 20), now), '<1m');
  assert.equal(formatSessionCountdown(session(1, -5), now), '');
  assert.equal(formatSessionCountdown({ ...session(0, 0), resetAt: 0 }, now), '');
  assert.equal(formatSessionCountdown(undefined, now), '');
});

function mockStates(t) {
  t.mock.method(codexAccounts, 'getCodexAccountState', (config) => config.codexAccounts);
  t.mock.method(claudeAccounts, 'getClaudeAccountState', (config) => config.claudeAccounts);
}

const makeConfig = (activeAccountId) => ({
  version: 1,
  refreshCadenceSeconds: 120,
  providers: [{ id: 'codex', enabled: true }, { id: 'claude', enabled: false }],
  codexAccounts: {
    activeAccountId,
    systemAccount: { label: 'sys', authFingerprint: 's' },
    missingSystemAuth: false,
    accounts: [
      { id: 'a', label: 'A', managedHomePath: 'home-a', source: 'managed' },
      { id: 'b', label: 'B', managedHomePath: 'home-b', source: 'managed' },
      { id: 'c', label: 'C', source: 'managed' },
    ],
  },
  claudeAccounts: { accounts: [{ id: 'x', label: 'X', managedHomePath: 'home-x', source: 'managed' }], missingSystemAuth: true },
});

test('targets skip the selected account, disabled providers, and accounts without a home', (t) => {
  mockStates(t);
  const targets = getAccountUsageTargets(makeConfig('a'));
  assert.deepEqual(targets.map((item) => item.tabId), ['system', 'b']);
  assert.equal(targets[1].home, 'home-b');
});

test('poller records failures as empty, feeds the selected account from refresh, and prunes removed accounts', async (t) => {
  mockStates(t);
  const fetched = [];
  let published;
  const poller = new AccountUsagePoller(makeConfig('a'), (map) => { published = map; }, async (_config, target) => {
    fetched.push(target.tabId);
    return target.tabId === 'b'
      ? { providerId: 'codex', fetchedAt: now, usage: { primary: session(40, 3600), secondary: weekly(10), updatedAt: now, sourceLabel: 'test' } }
      : { providerId: 'codex', fetchedAt: now, error: 'boom' };
  });
  t.after(() => poller.stop());

  await Promise.all([poller.refresh(), poller.refresh()]);
  assert.deepEqual(fetched, ['system', 'b']);
  assert.deepEqual(published.codex.system, {});
  assert.equal(published.codex.b.session.usedPercent, 40);
  assert.equal(published.codex.b.weekly.usedPercent, 10);

  poller.recordActive({ codex: { providerId: 'codex', displayName: 'Codex', iconColor: '', primary: session(10, 3600) } });
  assert.equal(published.codex.a.session.usedPercent, 10);
  poller.recordActive({});
  assert.equal(published.codex.a.session.usedPercent, 10);
  poller.recordActive({ codex: { providerId: 'codex', displayName: 'Codex', iconColor: '', error: 'expired' } });
  assert.deepEqual(published.codex.a, {});

  const removed = makeConfig('a');
  removed.codexAccounts.accounts = removed.codexAccounts.accounts.filter((account) => account.id !== 'b');
  poller.updateConfig(removed);
  assert.equal(published.codex.b, undefined);
  assert.deepEqual(published.codex.a, {});
});

test('switching accounts records refresh data against the newly selected tab', (t) => {
  mockStates(t);
  let published;
  const poller = new AccountUsagePoller(makeConfig('a'), (map) => { published = map; }, async () => ({ providerId: 'codex', fetchedAt: now, error: 'skip' }));
  t.after(() => poller.stop());
  poller.recordActive({ codex: { providerId: 'codex', displayName: 'Codex', iconColor: '', primary: session(10, 3600) } });
  poller.updateConfig(makeConfig('b'));
  poller.recordActive({ codex: { providerId: 'codex', displayName: 'Codex', iconColor: '', primary: session(70, 3600) } });
  assert.equal(published.codex.a.session.usedPercent, 10);
  assert.equal(published.codex.b.session.usedPercent, 70);
});
