const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clockLaunch } = require('../dist/main/interactive-clock.js');
const { parsePasswd, findLogins, tokenExpired, syncRenewedLogin, startLoginClock } = require('../dist/main/linux-clocks.js');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const jwt = (payload) => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

test('Linux launches exec the CLI directly with the same isolation and no positional prompt', (t) => {
  const old = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'override';
  t.after(() => old === undefined ? delete process.env.ANTHROPIC_API_KEY : process.env.ANTHROPIC_API_KEY = old);
  const launch = clockLaunch('claude', "/opt/cli/O'Brien/claude", 'private-home', '/tmp/scratch', 'linux');
  assert.equal(launch.file, "/opt/cli/O'Brien/claude");
  assert.ok(launch.args.includes('claude-haiku-5-5'));
  assert.ok(!launch.args.some((arg) => /Reply OK|^-p$|^--print$/.test(arg)));
  assert.equal(launch.env.CLAUDE_CONFIG_DIR, 'private-home');
  assert.equal(launch.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(clockLaunch('codex', 'codex', 'home', 'cwd', 'win32').file, 'powershell.exe');
});

test('passwd parsing keeps root and login users only', () => {
  const users = parsePasswd([
    'root:x:0:0:root:/root:/bin/bash',
    'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
    '# comment',
    'alice:x:1000:1000:Alice:/home/alice:/bin/bash',
    'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
    '',
  ].join('\n'));
  assert.deepEqual(users, [
    { name: 'root', uid: 0, gid: 0, home: '/root' },
    { name: 'alice', uid: 1000, gid: 1000, home: '/home/alice' },
  ]);
});

test('login discovery finds subscription logins in default CLI locations and skips API keys', (t) => {
  const home = tempDir(t, 'clock-linux-home-');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com' } }));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test' }));
  assert.deepEqual(findLogins(home).map((login) => [login.provider, login.label]), [['claude', 'alice@example.com']]);
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'a', id_token: jwt({ email: 'bob@example.com' }), refresh_token: 'r' } }));
  assert.deepEqual(findLogins(home).map((login) => [login.provider, login.label]), [['claude', 'alice@example.com'], ['codex', 'bob@example.com']]);
});

test('expired access tokens skip the usage precheck so the CLI can renew them', () => {
  const now = Date.now();
  assert.equal(tokenExpired('claude', { claudeAiOauth: { expiresAt: now - 1 } }, now), true);
  assert.equal(tokenExpired('claude', { claudeAiOauth: { expiresAt: now + 3600000 } }, now), false);
  assert.equal(tokenExpired('codex', { tokens: { access_token: jwt({ exp: now / 1000 - 10 }) } }, now), true);
  assert.equal(tokenExpired('codex', { tokens: { access_token: jwt({ exp: now / 1000 + 3600 }) } }, now), false);
  assert.equal(tokenExpired('codex', { tokens: { access_token: 'opaque' } }, now), false);
});

test('renewed tokens are saved back only when the user login is unchanged and the account matches', (t) => {
  const dir = tempDir(t, 'clock-linux-sync-');
  const source = path.join(dir, 'auth.json');
  const copy = path.join(dir, 'copy.json');
  const original = Buffer.from(JSON.stringify({ tokens: { access_token: 'old', account_id: 'acct' } }));
  const renewed = JSON.stringify({ tokens: { access_token: 'new', account_id: 'acct' } });
  const reset = () => { fs.writeFileSync(source, original); fs.writeFileSync(copy, original); };

  reset();
  assert.equal(syncRenewedLogin('codex', source, original, copy), undefined);
  assert.ok(fs.readFileSync(source).equals(original));

  reset(); fs.writeFileSync(copy, renewed);
  assert.equal(syncRenewedLogin('codex', source, original, copy), 'Renewed login saved.');
  assert.equal(fs.readFileSync(source, 'utf8'), renewed);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['auth.json', 'copy.json']);

  reset(); fs.writeFileSync(copy, renewed); fs.writeFileSync(source, '{"switched":true}');
  assert.match(syncRenewedLogin('codex', source, original, copy), /changed during the run/);
  assert.equal(fs.readFileSync(source, 'utf8'), '{"switched":true}');

  reset(); fs.writeFileSync(copy, JSON.stringify({ tokens: { access_token: 'new', account_id: 'other' } }));
  assert.match(syncRenewedLogin('codex', source, original, copy), /did not match/);
  assert.ok(fs.readFileSync(source).equals(original));
});

function fakeTerminal() {
  let onData, onExit;
  const writes = [];
  return {
    writes,
    emit: (data) => onData(data),
    write: (data) => writes.push(data),
    kill: () => onExit?.({ exitCode: 0 }),
    onData: (callback) => { onData = callback; return { dispose() {} }; },
    onExit: (callback) => { onExit = callback; return { dispose() {} }; },
  };
}

test('a login clock runs from a private copy with a throwaway HOME and keeps renewed tokens', async (t) => {
  const home = tempDir(t, 'clock-linux-user-');
  fs.mkdirSync(path.join(home, '.claude'));
  const credentials = path.join(home, '.claude', '.credentials.json');
  fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1 } }));
  const profile = JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com' }, projects: { keep: true } });
  fs.writeFileSync(path.join(home, '.claude.json'), profile);
  const [login] = findLogins(home);

  const tokens = [];
  t.mock.method(global, 'fetch', async (_url, options) => {
    tokens.push(options.headers.Authorization);
    return { ok: true, json: async () => ({ five_hour: { resets_at: new Date(Date.now() + 60000).toISOString() } }) };
  });
  let launched;
  const spawn = (file, args, options) => {
    launched = { file, options };
    const config = options.env.CLAUDE_CONFIG_DIR;
    assert.equal(JSON.parse(fs.readFileSync(path.join(config, '.claude.json'), 'utf8')).oauthAccount.emailAddress, 'alice@example.com');
    // The CLI renews the expired token inside its private profile.
    fs.writeFileSync(path.join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + 3600000 } }));
    const terminal = fakeTerminal();
    setTimeout(() => terminal.emit('Haiku 5.5 with low effort'), 10);
    setTimeout(() => terminal.emit('\n⏺ OK\n'), 300);
    return terminal;
  };

  const message = await startLoginClock(login, '/opt/codexbar-clocks/cli/node_modules/.bin/claude', new AbortController().signal, spawn);
  assert.equal(message, 'Clock running. Renewed login saved.');
  assert.deepEqual(tokens, ['Bearer new'], 'an expired token skips the precheck; verification uses the renewed copy');
  assert.equal(launched.file, process.platform === 'win32' ? 'powershell.exe' : '/opt/codexbar-clocks/cli/node_modules/.bin/claude');
  assert.notEqual(launched.options.env.HOME, home);
  assert.equal(launched.options.env.DISABLE_AUTOUPDATER, '1');
  assert.ok(!fs.existsSync(path.dirname(launched.options.env.HOME)), 'the private profile is removed');
  assert.equal(JSON.parse(fs.readFileSync(credentials, 'utf8')).claudeAiOauth.refreshToken, 'r2');
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), profile, 'the user profile is never written');
});

test('a running clock is skipped without launching the CLI or touching the login', async (t) => {
  const home = tempDir(t, 'clock-linux-running-');
  fs.mkdirSync(path.join(home, '.codex'));
  const auth = JSON.stringify({ tokens: { access_token: jwt({ exp: Date.now() / 1000 + 3600 }), refresh_token: 'r' } });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), auth);
  t.mock.method(require('../dist/main/providers/codex/oauth.js'), 'fetchCodexUsage', async () => ({
    rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: Date.now() / 1000 + 600 } },
  }));
  const message = await startLoginClock(findLogins(home)[0], undefined, new AbortController().signal, () => assert.fail('CLI must not start'));
  assert.equal(message, 'Already running; skipped.');
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'), auth);
});
