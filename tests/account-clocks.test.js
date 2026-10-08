const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clockLaunch, sendInteractiveClock } = require('../dist/main/interactive-clock.js');
const { getClockTargets, startAccountClock, startClocksSequentially, confirmClock } = require('../dist/main/account-clocks.js');
const interactive = require('../dist/main/interactive-clock.js');

function fakeTerminal() {
  let onData, onExit;
  const writes = [];
  let killed = false;
  return {
    writes,
    get killed() { return killed; },
    emit: (data) => onData(data),
    exit: () => onExit({ exitCode: 1 }),
    write: (data) => writes.push(data),
    kill: () => { killed = true; },
    onData: (callback) => { onData = callback; return { dispose() {} }; },
    onExit: (callback) => { onExit = callback; return { dispose() {} }; },
  };
}

test('clock launches use isolated interactive sessions and cheaper models, with no positional prompt or inherited API auth', (t) => {
  const keys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDECODE'];
  for (const key of keys) { const old = process.env[key]; process.env[key] = 'override'; t.after(() => old === undefined ? delete process.env[key] : process.env[key] = old); }
  for (const provider of ['codex', 'claude']) {
    const launch = clockLaunch(provider, "C:\\O'Brien\\cli.cmd", 'private-home', "C:\\scratch O'Brien");
    const command = Buffer.from(launch.args.at(-1), 'base64').toString('utf16le');
    assert.match(command, /O''Brien/);
    assert.doesNotMatch(command, /Reply OK|'-p'|'--print'|'exec'/);
    assert.match(command, provider === 'codex' ? /gpt-6-luna.*model_reasoning_effort=low/ : /claude-haiku-5-5.*'low'/);
    assert.equal(launch.env[provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'], 'private-home');
    for (const key of keys) assert.equal(launch.env[key], undefined);
    if (provider === 'codex') assert.match(command, /--no-daemon.*cli_auth_credentials_store=file/);
  }
});

test('interactive runner waits for ready, types and presses Enter separately, then requires an actual reply', async () => {
  const terminal = fakeTerminal();
  const job = sendInteractiveClock('codex', 'cli', 'home', 'scratch', new AbortController().signal, () => terminal, 2000);
  terminal.emit('Loading…');
  assert.deepEqual(terminal.writes, []);
  terminal.emit('\x1b[6n');
  assert.deepEqual(terminal.writes, ['\x1b[1;1R']);
  terminal.emit('100% context left');
  assert.equal(terminal.writes.at(-1), 'Reply OK.');
  terminal.emit('› Reply OK.\n');
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal(terminal.writes.at(-1), '\r');
  assert.equal(terminal.killed, false, 'echoing the user prompt is not a reply');
  terminal.emit('\n• OK\n');
  await job;
  assert.equal(terminal.killed, true);
  assert.equal(terminal.writes.filter((data) => data === 'Reply OK.').length, 1);
});

test('Claude onboarding trusts only the scratch folder before submitting; expired logins do not receive messages', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-interactive-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const terminal = fakeTerminal();
  const job = sendInteractiveClock('claude', 'cli', 'home', cwd, new AbortController().signal, () => terminal, 2000);
  terminal.emit('Choose the text style');
  terminal.emit('Security notes');
  terminal.emit('Do you trust this folder?');
  assert.deepEqual(terminal.writes, ['\r', '\r', '\x1b[B\r']);
  terminal.emit('Select login method');
  await assert.rejects(job, /Re-authenticate/);
  assert.equal(terminal.killed, true);
  assert.equal(terminal.writes.includes('Reply OK.'), false);
});

test('timeouts, aborts and early exits clean up the interactive terminal', async () => {
  for (const mode of ['timeout', 'abort', 'exit']) {
    const terminal = fakeTerminal();
    const controller = new AbortController();
    const job = sendInteractiveClock('codex', 'cli', 'home', 'scratch', controller.signal, () => terminal, 20);
    if (mode === 'abort') controller.abort();
    if (mode === 'exit') terminal.exit();
    await assert.rejects(job, /timed out|canceled|exited/);
    assert.equal(terminal.killed, mode !== 'exit');
  }
});

test('Claude screen-reader trust and reply are recognized without mistaking the echoed message for success', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-screenreader-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const terminal = fakeTerminal();
  const job = sendInteractiveClock('claude', 'cli', 'home', cwd, new AbortController().signal, () => terminal, 2000);
  terminal.emit('Do you trust this folder?\nEnter y/n:');
  assert.deepEqual(terminal.writes, ['y\r']);
  terminal.emit('Haiku 5.5 with low effort · Claude Team\n$');
  assert.equal(terminal.writes.at(-1), 'Reply OK.');
  terminal.emit('you: Reply OK.\nHatching…');
  assert.equal(terminal.killed, false);
  terminal.emit('$\x07claude: OK\nSautéed · done');
  await job;
  assert.equal(terminal.killed, true);
});

test('Windows cleanup stops only the launched process tree and waits for ConPTY exit', { skip: process.platform !== 'win32' }, async (t) => {
  const terminal = Object.assign(fakeTerminal(), { pid: 12345 });
  t.mock.method(require('node:child_process'), 'execFile', (file, args, options, callback) => {
    assert.equal(file, 'taskkill.exe');
    assert.deepEqual(args, ['/PID', '12345', '/T', '/F']);
    assert.equal(options.windowsHide, true);
    callback(null);
    setTimeout(() => terminal.exit(), 1000);
  });
  const job = sendInteractiveClock('codex', 'cli', 'home', 'scratch', new AbortController().signal, () => terminal, 20);
  await assert.rejects(job, /timed out/);
  assert.equal(terminal.killed, false, 'an exited process must not be killed again');
});

function managedClaude(t) {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-managed-'));
  for (const key of ['USERPROFILE', 'HOME', 'CLAUDE_CONFIG_DIR']) {
    const old = process.env[key];
    if (key === 'CLAUDE_CONFIG_DIR') delete process.env[key]; else process.env[key] = user;
    t.after(() => old === undefined ? delete process.env[key] : process.env[key] = old);
  }
  t.after(() => fs.rmSync(user, { recursive: true, force: true }));
  const home = path.join(user, '.codexbar', 'claude-accounts', 'private');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'private' } }));
  const config = { version: 1, providers: [], claudeAccounts: { accounts: [{ id: 'private', source: 'managed', label: 'Private', managedHomePath: home }] } };
  return { home, config, target: { provider: 'claude', accountId: 'private' } };
}

test('an already-running clock is skipped before resolving or launching the CLI', async (t) => {
  const { config, target } = managedClaude(t);
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ five_hour: { resets_at: new Date(Date.now() + 60000).toISOString() } }) }));
  t.mock.method(interactive, 'sendInteractiveClock', () => assert.fail('Running clock must not receive a message'));
  t.mock.method(require('../dist/main/claude-accounts.js'), 'resolveClaudeBinary', () => assert.fail('Running clock does not need a CLI'));
  assert.equal(await startAccountClock(config, target, new AbortController().signal), 'Already running; skipped.');
});

test('idle clocks receive one interactive message and are verified afterward; failed checks send none', async (t) => {
  const { config, target, home } = managedClaude(t);
  let requests = 0, messages = 0;
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ five_hour: { resets_at: ++requests === 1 ? null : new Date(Date.now() + 60000).toISOString() } }) }));
  t.mock.method(require('../dist/main/claude-accounts.js'), 'resolveClaudeBinary', () => 'claude.exe');
  t.mock.method(interactive, 'sendInteractiveClock', async (provider, _binary, privateHome, cwd) => {
    assert.equal(provider, 'claude'); assert.equal(privateHome, home);
    assert.notEqual(cwd, home); assert.equal(fs.existsSync(cwd), true);
    messages++;
  });
  assert.equal(await startAccountClock(config, target, new AbortController().signal), 'Clock running.');
  assert.equal(messages, 1); assert.equal(requests, 2);
  t.mock.method(global, 'fetch', async () => ({ ok: false, status: 429 }));
  await assert.rejects(startAccountClock(config, target, new AbortController().signal), /HTTP 429/);
  assert.equal(messages, 1);
});

test('Codex idle sliding resets are not treated as running, while pinned resets count even at zero usage', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-codex-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'private', refresh_token: 'refresh' } }));
  let reset = Date.now() / 1000 + 18000;
  t.mock.method(require('../dist/main/providers/codex/oauth.js'), 'fetchCodexUsage', async () => ({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: reset } } }));
  const signal = new AbortController().signal;
  assert.equal(await confirmClock('codex', home, signal, 1), false);
  reset -= 60;
  assert.equal(await confirmClock('codex', home, signal, 1), true);
  reset = Date.now() / 1000 - 1;
  assert.equal(await confirmClock('codex', home, signal, 1), false);
});

test('global clock activation runs sequentially and continues after an account fails', async () => {
  const targets = ['a', 'b', 'c'].map((accountId) => ({ provider: 'codex', accountId, label: accountId }));
  let running = 0;
  const completed = [];
  const updates = [];
  const state = await startClocksSequentially(targets, async (target) => {
    assert.equal(running++, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(target.accountId); running--;
    if (target.accountId === 'b') throw new Error('Login expired.');
    return 'Clock running.';
  }, (state) => updates.push(state), new AbortController().signal);
  assert.deepEqual(completed, ['a', 'b', 'c']);
  assert.deepEqual(state.results.map((result) => result.ok), [true, false, true]);
  assert.equal(state.message, '2 started · 0 already running · 1 failed.');
  assert.equal(updates.at(-1).busy, false);
  assert.equal(updates[0].results.length, 0, 'progress snapshots do not mutate later');
});

test('global activation covers both providers and avoids sending twice to the ambient account', (t) => {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-accounts-'));
  for (const key of ['USERPROFILE', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
    const old = process.env[key];
    if (key.endsWith('_DIR') || key === 'CODEX_HOME') delete process.env[key]; else process.env[key] = user;
    t.after(() => old === undefined ? delete process.env[key] : process.env[key] = old);
  }
  t.after(() => fs.rmSync(user, { recursive: true, force: true }));
  fs.mkdirSync(path.join(user, '.claude'));
  fs.writeFileSync(path.join(user, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'ambient' } }));
  fs.writeFileSync(path.join(user, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'same@example.com' } }));
  const config = { version: 1, providers: [], codexAccounts: { accounts: [{ id: 'codex', label: 'Codex A' }] },
    claudeAccounts: { accounts: [{ id: 'claude', label: 'Claude A', email: 'same@example.com', authFingerprint: 'private' }] } };
  assert.deepEqual(getClockTargets(config).map((target) => [target.provider, target.accountId]), [['codex', 'codex'], ['claude', 'claude']]);
});

test('clock activation rejects unknown accounts before creating a terminal', async () => {
  await assert.rejects(startAccountClock({ version: 1, providers: [] }, { provider: 'claude', accountId: 'unknown' }, new AbortController().signal), /not found/);
});

test('Claude confirms an actual future subscription reset and surfaces verification failures', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-confirm-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'private-token' } }));
  t.mock.method(global, 'fetch', async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer private-token');
    return { ok: true, json: async () => ({ limits: [{ kind: 'session', resets_at: new Date(Date.now() + 60000).toISOString() }] }) };
  });
  assert.equal(await confirmClock('claude', home, new AbortController().signal), true);
  t.mock.method(global, 'fetch', async () => ({ ok: false, status: 429 }));
  await assert.rejects(confirmClock('claude', home, new AbortController().signal), /HTTP 429/);
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ unexpected: true }) }));
  await assert.rejects(confirmClock('claude', home, new AbortController().signal), /did not report/);
});
