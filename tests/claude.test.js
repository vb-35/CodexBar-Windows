const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const accounts = require('../dist/main/claude-accounts.js');
const { claudeProvider } = require('../dist/main/providers/claude/index.js');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-claude-'));
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.USERPROFILE = process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function writeAuth(home, token, extra = {}) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, '.credentials.json');
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: token, ...extra } }));
  return file;
}
const config = () => ({ version: 1, providers: [{ id: 'claude', enabled: true }] });

test('Claude import, deduplication, selection, removal, and config reload stay separate from Codex', async (t) => {
  const home = tempHome(t);
  const file = writeAuth(path.join(home, 'import'), 'alpha-token');
  t.mock.method(global, 'fetch', async (_url, options) => ({ ok: true,
    json: async () => ({ account: { email: options.headers.Authorization.includes('beta') ? 'beta@example.com' : 'alpha@example.com' } }) }));
  const initial = { ...config(), codexAccounts: { accounts: [], activeAccountId: 'codex-choice' } };
  const first = await accounts.importClaudeAccount(initial, file);
  assert.equal(first.ok, true);
  assert.equal(first.state.accounts[0].email, 'alpha@example.com');
  assert.equal(first.config.codexAccounts.activeAccountId, 'codex-choice');
  assert.doesNotMatch(JSON.stringify(first.state), /alpha-token/);
  const duplicate = await accounts.importClaudeAccount(first.config, file);
  assert.equal(duplicate.state.accounts.length, 1);
  assert.equal(duplicate.state.accounts[0].id, first.state.accounts[0].id);
  writeAuth(path.dirname(file), 'beta-token');
  const second = await accounts.importClaudeAccount(duplicate.config, file);
  assert.equal(second.state.accounts.length, 2);
  assert.equal(second.state.activeAccountId, second.state.accounts[1].id);
  assert.equal(accounts.selectClaudeAccount(second.config, 'unknown').ok, false);
  const selected = accounts.selectClaudeAccount(second.config, first.state.accounts[0].id);
  assert.equal(accounts.resolveActiveClaudeHome(selected.config), selected.state.accounts[0].managedHomePath);
  const store = require('../dist/main/config.js');
  store.saveConfig(selected.config);
  const reloaded = store.loadConfig();
  assert.equal(reloaded.claudeAccounts.activeAccountId, first.state.accounts[0].id);
  assert.equal(reloaded.providers.find((provider) => provider.id === 'claude').enabled, true);
  const removedHome = selected.state.accounts[0].managedHomePath;
  const removed = accounts.removeClaudeAccount(reloaded, selected.state.activeAccountId);
  assert.equal(removed.state.accounts.length, 1);
  assert.equal(removed.state.activeAccountId, undefined);
  assert.equal(fs.existsSync(removedHome), false);
  assert.equal(fs.existsSync(file), true, 'the imported source is preserved');
  fs.writeFileSync(file, 'null');
  assert.equal((await accounts.importClaudeAccount(initial, file)).ok, false);
  const unsafe = { ...config(), claudeAccounts: { accounts: [{ id: 'unsafe', managedHomePath: home }] } };
  assert.equal(accounts.removeClaudeAccount(unsafe, 'unsafe').ok, false);
  assert.equal(fs.existsSync(home), true);
});

test('Claude reads ambient metadata, respects config overrides, and maps usage windows', async (t) => {
  const home = tempHome(t);
  writeAuth(path.join(home, '.claude'), 'system-token', { subscriptionType: 'max' });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'USER@example.com', accountUuid: 'uuid' } }));
  assert.equal(accounts.getClaudeAccountState(config()).systemAccount.email, 'user@example.com');
  const reset = '2026-10-08T18:00:00Z';
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(options.headers.Authorization, 'Bearer system-token');
    assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ five_hour: { utilization: 25, resets_at: reset }, seven_day: { utilization: 10, resets_at: reset },
      seven_day_sonnet: { utilization: 35, resets_at: reset }, seven_day_opus: { utilization: 120, resets_at: null } }) };
  });
  const result = await claudeProvider.fetch({ id: 'claude' }, config());
  assert.equal(result.usage.identity, 'user@example.com');
  assert.equal(result.usage.planType, 'max');
  assert.equal(result.usage.primary.usedPercent, 25);
  assert.equal(result.usage.primary.resetAt, Date.parse(reset) / 1000);
  assert.equal(result.usage.secondary.limitWindowSeconds, 7 * 24 * 60 * 60);
  assert.deepEqual(result.usage.additionalWindows.map((window) => window.usedPercent), [35, 100]);
  assert.equal(result.usage.additionalWindows[1].resetAt, 0);
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'custom');
  writeAuth(process.env.CLAUDE_CONFIG_DIR, 'override');
  assert.equal(accounts.loadClaudeAuth().oauth.accessToken, 'override');
});

test('Claude errors and invalid windows never expose credentials or invent usage', async (t) => {
  const home = tempHome(t);
  assert.match((await claudeProvider.fetch({ id: 'claude' }, config())).error, /No Claude credentials/);
  writeAuth(path.join(home, '.claude'), 'secret-token');
  for (const [status, expected] of [[401, /expired/], [403, /denied/], [429, /rate limited/], [500, /HTTP 500/]]) {
    const mock = t.mock.method(global, 'fetch', async () => ({ ok: false, status }));
    const result = await claudeProvider.fetch({ id: 'claude' }, config());
    assert.match(result.error, expected);
    assert.doesNotMatch(result.error, /secret-token/);
    mock.mock.restore();
  }
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 'wrong' }, seven_day: null }) }));
  assert.match((await claudeProvider.fetch({ id: 'claude' }, config())).error, /no subscription usage windows/);
});

test('private expired tokens renew once, preserve metadata, and leave ambient credentials untouched', async (t) => {
  const home = tempHome(t);
  const managedHome = path.join(home, '.codexbar', 'claude-accounts', 'test-account');
  writeAuth(managedHome, 'old-token', { refreshToken: 'refresh+token', expiresAt: 1, subscriptionType: 'pro' });
  const ambientHome = path.join(home, '.claude');
  const ambientFile = writeAuth(ambientHome, 'ambient', { refreshToken: 'ambient-refresh', expiresAt: 1 });
  const ambientBefore = fs.readFileSync(ambientFile, 'utf8');
  const sameEmailConfig = { ...config(), claudeAccounts: { activeAccountId: 'private', accounts: [{
    id: 'private', managedHomePath: managedHome, email: 'same@example.com', label: 'same@example.com',
  }] } };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'same@example.com' } }));
  assert.equal(accounts.resolveActiveClaudeHome(sameEmailConfig), managedHome, 'matching system email cannot override private credentials');
  let requests = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    requests++;
    assert.equal(url, 'https://platform.claude.com/v1/oauth/token');
    assert.equal(options.body.get('refresh_token'), 'refresh+token');
    await new Promise(setImmediate);
    return { ok: true, json: async () => ({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600 }) };
  });
  const auth = accounts.loadClaudeAuth(managedHome);
  const renewed = await Promise.all([accounts.refreshManagedClaudeAuth(managedHome, auth), accounts.refreshManagedClaudeAuth(managedHome, auth)]);
  assert.equal(requests, 1);
  assert.equal(renewed[0].oauth.accessToken, 'new-token');
  assert.equal(renewed[1].oauth.subscriptionType, 'pro');
  assert.equal(accounts.loadClaudeAuth(managedHome).oauth.refreshToken, 'new-refresh');
  await accounts.refreshManagedClaudeAuth(ambientHome, accounts.loadClaudeAuth(ambientHome));
  assert.equal(requests, 1);
  assert.equal(fs.readFileSync(ambientFile, 'utf8'), ambientBefore);
});

test('Claude accepts current limits arrays and ignores inactive or duplicate scoped windows', async (t) => {
  const home = tempHome(t);
  writeAuth(path.join(home, '.claude'), 'system-token');
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({
    seven_day_sonnet: { utilization: 20, resets_at: null },
    limits: [
      { kind: 'session', percent: 25 }, { kind: 'weekly', percent: 50 },
      { kind: 'weekly_scoped', group: 'weekly', percent: 20, scope: { model: { display_name: 'Sonnet' } } },
      { kind: 'weekly_scoped', group: 'weekly', percent: 30, scope: { model: { display_name: 'Fable' } } },
      { kind: 'weekly_scoped', group: 'weekly', percent: 40, is_active: false, scope: { model: { display_name: 'Inactive' } } },
    ],
  }) }));
  const result = await claudeProvider.fetch({ id: 'claude' }, config());
  assert.equal(result.usage.primary.usedPercent, 25);
  assert.equal(result.usage.secondary.usedPercent, 50);
  assert.deepEqual(result.usage.additionalWindows.map((window) => window.label), ['Weekly Sonnet', 'Weekly Fable']);
});

test('Claude login uses a fresh private directory and canceled re-auth preserves the account', async (t) => {
  const home = tempHome(t);
  const children = require('node:child_process');
  t.mock.method(children, 'execFileSync', () => 'C:\\tools\\claude.cmd\r\n');
  t.mock.method(global, 'fetch', async () => ({ ok: false }));
  let cancel = false;
  t.mock.method(children, 'spawn', (_binary, args, options) => {
    assert.notEqual(options.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'));
    const encoded = args[2].match(/EncodedCommand ([A-Za-z0-9+/=]+)/)[1];
    assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), /auth login --claudeai/);
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (!cancel) {
        writeAuth(options.env.CLAUDE_CONFIG_DIR, 'login-token');
        fs.writeFileSync(path.join(options.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'login@example.com' } }));
      }
      child.emit('exit', cancel ? 1 : 0);
    });
    return child;
  });
  const loggedIn = await accounts.loginClaudeAccount(config());
  assert.equal(loggedIn.ok, true);
  assert.equal(loggedIn.state.accounts[0].email, 'login@example.com');
  const originalHome = loggedIn.state.accounts[0].managedHomePath;
  cancel = true;
  const canceled = await accounts.loginClaudeAccount(loggedIn.config, loggedIn.state.activeAccountId);
  assert.equal(canceled.ok, false);
  assert.equal(canceled.state.accounts[0].managedHomePath, originalHome);
  assert.equal(accounts.loadClaudeAuth(originalHome).oauth.accessToken, 'login-token');
});
