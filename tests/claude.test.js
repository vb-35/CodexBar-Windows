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

test('Claude promotion preserves the previous login and unrelated CLI settings, then selects ambient auth', async (t) => {
  const home = tempHome(t);
  const ambientHome = path.join(home, '.claude');
  const ambientFile = writeAuth(ambientHome, 'previous-token');
  const profilePath = path.join(home, '.claude.json');
  const oldProfile = { theme: 'dark', projects: { sample: { trusted: true } }, oauthAccount: {
    emailAddress: 'old@example.com', accountUuid: 'old-id', organizationUuid: 'old-org',
  } };
  fs.writeFileSync(profilePath, JSON.stringify(oldProfile));
  const previousBytes = fs.readFileSync(ambientFile, 'utf8');
  const imported = writeAuth(path.join(home, 'import'), 'new-token');
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ account: { email: 'new@example.com', uuid: 'new-id' } }) }));
  const initial = { ...config(), codexAccounts: { accounts: [], activeAccountId: 'codex-selected' } };
  const added = await accounts.importClaudeAccount(initial, imported);
  const selectedId = added.state.activeAccountId;
  const promoted = await accounts.promoteClaudeAccountToSystem(added.config, selectedId);
  assert.equal(promoted.ok, true);
  assert.equal(promoted.state.activeAccountId, undefined);
  assert.equal(promoted.state.systemAccountId, selectedId);
  assert.equal(promoted.state.systemAccount.email, 'new@example.com');
  assert.equal(promoted.config.codexAccounts.activeAccountId, 'codex-selected');
  assert.equal(accounts.resolveActiveClaudeHome(promoted.config), ambientHome);
  assert.equal(accounts.loadClaudeAuth().oauth.accessToken, 'new-token');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  assert.equal(profile.theme, 'dark');
  assert.deepEqual(profile.projects, oldProfile.projects);
  assert.equal(profile.oauthAccount.accountUuid, 'new-id');
  assert.notEqual(profile.oauthAccount.organizationUuid, 'old-org', 'old account metadata is not reused');
  const previous = promoted.state.accounts.find((account) => account.id !== selectedId);
  assert.equal(previous.email, 'old@example.com');
  assert.equal(fs.readFileSync(previous.managedAuthPath, 'utf8'), previousBytes);
  assert.equal(accounts.loadClaudeAuth(previous.managedHomePath).accountId, 'old-id');
  const second = await accounts.promoteClaudeAccountToSystem(promoted.config, selectedId);
  assert.equal(second.state.accounts.length, 2, 'repeated promotion does not duplicate the backup');
  const tabs = require('../dist/shared/popover-model.js').buildAccountTabs(promoted.state);
  assert.deepEqual(tabs.map((tab) => tab.id), ['system', previous.id]);
  assert.match(promoted.message, /Restart/);
  assert.doesNotMatch(JSON.stringify(promoted.state), /new-token|previous-token/);
});

test('Claude promotion respects custom CLI homes and rolls back both files on a failed replacement', async (t) => {
  const home = tempHome(t);
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'custom-cli');
  const ambient = writeAuth(process.env.CLAUDE_CONFIG_DIR, 'old');
  const profile = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
  fs.writeFileSync(profile, JSON.stringify({ unrelated: true, oauthAccount: { emailAddress: 'old@example.com' } }));
  const authBefore = fs.readFileSync(ambient, 'utf8'), profileBefore = fs.readFileSync(profile, 'utf8');
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ account: { email: 'new@example.com' } }) }));
  const added = await accounts.importClaudeAccount(config(), writeAuth(path.join(home, 'import'), 'new'));
  const originalRename = fs.renameSync;
  let failed = false;
  const mock = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === ambient && !failed) { failed = true; throw new Error('disk failure'); }
    return originalRename(source, destination);
  });
  const result = await accounts.promoteClaudeAccountToSystem(added.config, added.state.activeAccountId);
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(ambient, 'utf8'), authBefore);
  assert.equal(fs.readFileSync(profile, 'utf8'), profileBefore);
  mock.mock.restore();
  const success = await accounts.promoteClaudeAccountToSystem(added.config, added.state.activeAccountId);
  assert.equal(success.ok, true);
  assert.equal(accounts.loadClaudeAuth().oauth.accessToken, 'new');
  assert.equal(JSON.parse(fs.readFileSync(profile, 'utf8')).unrelated, true);
  assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);
  assert.equal((await accounts.promoteClaudeAccountToSystem(config(), 'missing')).ok, false);
});

test('viewing a Claude account never changes CLI credentials or connects over SSH', async (t) => {
  const home = tempHome(t);
  const ambient = writeAuth(path.join(home, '.claude'), 'ambient');
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ account: { email: 'private@example.com' } }) }));
  const added = await accounts.importClaudeAccount(config(), writeAuth(path.join(home, 'import'), 'private'));
  const children = require('node:child_process');
  const ssh = t.mock.method(children, 'execFile', () => { throw new Error('Unexpected SSH'); });
  const selected = accounts.selectClaudeAccount({ ...added.config, remoteHistory: { sshTarget: 'example.test' } }, added.state.activeAccountId);
  assert.equal(selected.ok, true);
  assert.equal(accounts.loadClaudeAuth().oauth.accessToken, 'ambient');
  assert.equal(fs.readFileSync(ambient, 'utf8').includes('private'), false);
  assert.equal(ssh.mock.callCount(), 0);
});

test('Claude remote sync sends credentials on stdin, preserves profiles and original backups, and restores failed writes', async (t) => {
  const home = tempHome(t), children = require('node:child_process');
  const python = ['python3', 'python'].find((binary) => children.spawnSync(binary, ['--version'], { windowsHide: true }).status === 0);
  if (!python) return t.skip('Python is required to exercise the remote script');
  const source = path.join(home, 'managed');
  writeAuth(source, 'new-remote-token');
  fs.writeFileSync(path.join(source, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'new@example.com', accountUuid: 'new-id' } }));
  const remoteUser = path.join(home, 'remote-user');
  let remoteHome, failReplacement = false;
  t.mock.method(children, 'execFile', (binary, args, options, callback) => {
    assert.equal(binary, 'ssh');
    assert.equal(args.at(-2), 'remote-alias');
    assert.equal(options.windowsHide, true);
    assert.ok(args.includes('BatchMode=yes'));
    const command = args.at(-1);
    assert.doesNotMatch(command, /new-remote-token/);
    const script = command.slice("python3 -c '".length, command.lastIndexOf("' '")).replaceAll("'\"'\"'", "'");
    if (remoteHome.includes("'")) assert.ok(command.endsWith("'/srv/Claude'\"'\"'s home'"));
    const failure = String.raw`import os
original_replace=os.replace
failed=False
def injected_replace(src,dst):
 global failed
 if not failed and dst.endswith(".credentials.json"):
  failed=True
  raise OSError("injected write failure")
 original_replace(src,dst)
os.replace=injected_replace
`;
    return { stdin: { once() {}, end(input) {
      const payload = JSON.parse(input);
      assert.equal(payload.credentials.claudeAiOauth.accessToken, 'new-remote-token');
      assert.equal(payload.oauthAccount.accountUuid, 'new-id');
      const result = children.spawnSync(python, ['-c', (failReplacement ? failure : '') + script, remoteHome], {
        input, encoding: 'utf8', windowsHide: true, env: { ...process.env, HOME: remoteUser, USERPROFILE: remoteUser },
      });
      callback(result.status === 0 ? null : new Error('remote script failed'), result.stdout, result.stderr);
    } } };
  });
  for (const custom of [false, true]) {
    remoteHome = custom ? path.join(remoteUser, "Claude's home") : path.join(remoteUser, '.claude');
    const credentialFile = writeAuth(remoteHome, 'original-remote-token');
    const profileFile = custom ? path.join(remoteHome, '.claude.json') : path.join(remoteUser, '.claude.json');
    const profile = { theme: 'dark', oauthAccount: { emailAddress: 'old@example.com', organizationUuid: 'old-org' } };
    fs.writeFileSync(profileFile, JSON.stringify(profile));
    const beforeAuth = fs.readFileSync(credentialFile, 'utf8'), beforeProfile = fs.readFileSync(profileFile, 'utf8');
    const config = { sshTarget: 'remote-alias', ...(custom ? { claudeHome: '/srv/Claude\'s home' } : {}) };
    const authFile = path.join(remoteHome, '.credentials.json');
    const configFile = custom ? path.join(remoteHome, '.claude.json') : profileFile;
    await accounts.syncRemoteClaudeAuth(config, source);
    assert.equal(accounts.loadClaudeAuth(remoteHome).oauth.accessToken, 'new-remote-token');
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { theme: 'dark', oauthAccount: { emailAddress: 'new@example.com', accountUuid: 'new-id' } });
    assert.equal(fs.readFileSync(authFile + '.codexbar-backup', 'utf8'), beforeAuth);
    assert.equal(fs.readFileSync(configFile + '.codexbar-backup', 'utf8'), beforeProfile);
    await accounts.syncRemoteClaudeAuth(config, source);
    assert.equal(fs.readFileSync(authFile + '.codexbar-backup', 'utf8'), beforeAuth);
    fs.writeFileSync(authFile, beforeAuth);
    fs.writeFileSync(configFile, beforeProfile);
    failReplacement = true;
    await assert.rejects(accounts.syncRemoteClaudeAuth(config, source), /verify the remote CLI login/);
    failReplacement = false;
    assert.equal(fs.readFileSync(authFile, 'utf8'), beforeAuth);
    assert.equal(fs.readFileSync(configFile, 'utf8'), beforeProfile);
    assert.equal(fs.readdirSync(remoteHome).some((name) => name.endsWith('.tmp')), false);
    if (process.platform !== 'win32') for (const file of [authFile, configFile, authFile + '.codexbar-backup', configFile + '.codexbar-backup']) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  }
  remoteHome = path.join(remoteUser, 'fresh');
  failReplacement = true;
  await assert.rejects(accounts.syncRemoteClaudeAuth({ sshTarget: 'remote-alias', claudeHome: '/fresh' }, source), /sync failed/);
  assert.deepEqual(fs.readdirSync(remoteHome), [], 'a failed first sync leaves no partial login');
  failReplacement = false;
  await accounts.syncRemoteClaudeAuth({ sshTarget: 'remote-alias', claudeHome: '/fresh' }, source);
  assert.equal(accounts.loadClaudeAuth(remoteHome).oauth.accessToken, 'new-remote-token');
});

test('Claude promotion syncs the configured host after the local switch and reports SSH failures without exposing secrets', async (t) => {
  const home = tempHome(t), children = require('node:child_process');
  writeAuth(path.join(home, '.claude'), 'previous');
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ account: { email: 'new@example.com' } }) }));
  const added = await accounts.importClaudeAccount(config(), writeAuth(path.join(home, 'import'), 'selected-secret'));
  let fail = false;
  const mock = t.mock.method(children, 'execFile', (_binary, args, _options, callback) => {
    assert.equal(args.at(-2), 'remote-alias');
    assert.equal(accounts.loadClaudeAuth().oauth.accessToken, 'selected-secret', 'local switch finishes before SSH');
    return { stdin: { once() {}, end(input) {
      assert.equal(JSON.parse(input).credentials.claudeAiOauth.accessToken, 'selected-secret');
      callback(fail ? new Error('selected-secret') : null, '', 'selected-secret');
    } } };
  });
  const remoteConfig = { ...added.config, remoteHistory: { sshTarget: 'remote-alias', claudeHome: '~/.claude' } };
  const success = await accounts.promoteClaudeAccountToSystem(remoteConfig, added.state.activeAccountId);
  assert.equal(success.ok, true);
  assert.match(success.message, /locally and remotely/);
  assert.equal(mock.mock.callCount(), 1);
  fail = true;
  const failed = await accounts.promoteClaudeAccountToSystem(success.config, added.state.activeAccountId);
  assert.equal(failed.ok, true);
  assert.equal(failed.state.systemAccountId, added.state.activeAccountId);
  assert.match(failed.message, /updated locally.*Remote login sync failed/);
  assert.doesNotMatch(failed.message, /selected-secret/);
});

test('Claude remote sync rejects invalid destinations and unreadable credentials before starting SSH', async (t) => {
  const home = tempHome(t), children = require('node:child_process');
  const mock = t.mock.method(children, 'execFile', () => { throw new Error('Unexpected SSH'); });
  await assert.rejects(accounts.syncRemoteClaudeAuth({ sshTarget: '-oProxyCommand=bad' }, home), /Invalid SSH target/);
  await assert.rejects(accounts.syncRemoteClaudeAuth({ sshTarget: 'remote-alias' }, home), /unreadable/);
  assert.equal(mock.mock.callCount(), 0);
});

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
