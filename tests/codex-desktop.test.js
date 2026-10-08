const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const accounts = require('../dist/main/codex-accounts.js');
const desktop = require('../dist/main/codex-desktop.js');

const windowsProcess = (pid, parent, name, command = null) => ({
  ProcessId: pid, ParentProcessId: parent, Name: name,
  ExecutablePath: `C:\\Apps\\${name}`, CommandLine: command,
});

test('backend discovery scopes clients, excludes CLI work and protects CodexBar', () => {
  const processes = [
    windowsProcess(10, 1, 'Code.exe'),
    windowsProcess(11, 10, 'codex.exe', '"C:\\Codex CLI\\codex.exe" app-server'),
    windowsProcess(12, 10, 'codex.exe', 'codex.exe exec "app-server"'),
    windowsProcess(13, 10, 'powershell.exe'),
    windowsProcess(14, 13, 'codex.exe', 'codex.exe app-server'),
    windowsProcess(20, 1, 'T3 Code (Alpha).exe'),
    windowsProcess(21, 20, 'node.exe'),
    windowsProcess(22, 21, 'codex.exe', 'codex.exe app-server --listen stdio://'),
    windowsProcess(23, 21, 'codex.exe', 'codex.exe app-server -c model_provider="openai_token_sharing"'),
    windowsProcess(30, 10, 'node.exe', 'node.exe C:\\tools\\t3code\\apps\\server\\index.mjs'),
    windowsProcess(31, 30, 'codex.exe', 'codex.exe "app-server"'),
    windowsProcess(40, 1, 'node.exe'),
    windowsProcess(41, 40, 'codex.exe', 'codex.exe app-server'),
    windowsProcess(50, 11, 'CodexBar.exe'),
    windowsProcess(51, 50, 'codex.exe', 'codex.exe app-server'),
    windowsProcess(60, 10, 'CODEX.EXE', 'codex.exe app-server'),
    windowsProcess(61, 10, 'codex.exe', null),
    windowsProcess(70, 1, 'Code - Insiders.exe'),
    windowsProcess(71, 70, 'codex.exe', 'codex.exe app-server'),
    windowsProcess(80, 1, 'node.exe', 'node.exe C:\\Users\\user\\.t3\\runtime\\versions\\server.mjs'),
    windowsProcess(81, 80, 'codex.exe', 'codex.exe app-server'),
    windowsProcess(90, 91, 'node.exe'),
    windowsProcess(91, 90, 'node.exe'),
    windowsProcess(92, 90, 'codex.exe', 'codex.exe app-server'),
  ];
  const select = (stopVSCode, stopT3Code) => desktop.selectCodexBackendProcesses(processes, { stopVSCode, stopT3Code }, 50)
    .map((item) => [item.ProcessId, item.client]);
  assert.deepEqual(select(false, false), []);
  assert.deepEqual(select(true, false), [[60, 'VS Code'], [71, 'VS Code']]);
  assert.deepEqual(select(false, true), [[22, 'T3 Code'], [31, 'T3 Code'], [81, 'T3 Code']]);
  assert.deepEqual(select(true, true), [[22, 'T3 Code'], [31, 'T3 Code'], [60, 'VS Code'], [71, 'VS Code'], [81, 'T3 Code']]);
});

test('backend switches keep host apps open and handle cancellation, retries and respawns', async (t) => {
  for (const scenario of ['yes', 'cancel', 'partial-exit', 'already-exited', 'still-running', 'respawn', 'discovery-fails', 'switch-fails', 'empty']) {
    await t.test(scenario, async (t) => {
      const events = [];
      let queries = 0;
      let kills = 0;
      const processes = [
        windowsProcess(10, 1, 'Code.exe'),
        windowsProcess(11, 10, 'codex.exe', 'codex.exe app-server'),
        windowsProcess(20, 1, 'T3 Code.exe'),
        windowsProcess(21, 20, 'codex.exe', 'codex.exe app-server'),
      ];
      t.mock.method(accounts, 'getCodexAccountState', () => ({ accounts: [] }));
      t.mock.method(accounts, 'promoteCodexAccountToSystem', async () => {
        events.push('switch');
        return { ok: scenario !== 'switch-fails', message: 'switch result', config: {}, state: { accounts: [] } };
      });
      t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
        assert.equal(options.windowsHide, true);
        if (file === 'powershell.exe') {
          if (args.at(-1).includes('-Filter')) return callback(null, '', '');
          assert.match(args.at(-1), /SessionId -eq/);
          if (scenario === 'discovery-fails') return callback(new Error('discovery failed'), '', '');
          queries++;
          let running = queries === 1 || scenario === 'still-running' || (scenario === 'respawn' && queries === 3) ? processes : [];
          if (scenario === 'partial-exit' && queries === 2) running = processes.slice(2);
          if (scenario === 'empty') running = [];
          return callback(null, JSON.stringify(running), '');
        }
        assert.equal(file, 'taskkill.exe');
        assert.deepEqual(args, scenario === 'partial-exit' && kills ? ['/PID', '21', '/F'] : ['/PID', '11', '/PID', '21', '/F']);
        assert.equal(args.includes('/T'), false);
        kills++;
        events.push('kill');
        callback(scenario === 'already-exited' ? new Error('already exited') : null, '', '');
      });
      t.mock.method(childProcess, 'spawn', () => assert.fail('Host backends must not be detached from their stdio owner'));
      const result = await desktop.promoteWithDesktopRestart({ codexAccountSwitch: { stopVSCode: true, stopT3Code: true } }, 'account', async (clients) => {
        assert.deepEqual(clients, ['VS Code (stop Codex backends only)', 'T3 Code (stop Codex backends only)']);
        events.push('confirm');
        return scenario !== 'cancel';
      });
      assert.equal(result.ok, ['yes', 'partial-exit', 'already-exited', 'empty'].includes(scenario));
      if (['cancel', 'discovery-fails'].includes(scenario)) assert.deepEqual(events, scenario === 'cancel' ? ['confirm'] : []);
      else if (scenario === 'still-running') assert.deepEqual(events, ['confirm', 'kill', 'kill', 'kill']);
      else if (scenario === 'respawn') assert.deepEqual(events, ['confirm', 'kill']);
      else if (scenario === 'partial-exit') assert.deepEqual(events, ['confirm', 'kill', 'kill', 'switch']);
      else if (scenario === 'empty') assert.deepEqual(events, ['switch']);
      else assert.deepEqual(events, ['confirm', 'kill', 'switch']);
      if (kills) {
        assert.match(result.message, /Reload the VS Code window/);
        assert.match(result.message, /Restart the T3 Code Codex session/);
      }
    });
  }
});

test('desktop account switch handles closed, cancel, confirm, and failure paths', async (t) => {
  for (const scenario of ['closed', 'cancel', 'yes', 'already-exited', 'partial-exit', 'kill-fails', 'still-running', 'switch-fails', 'reopen-fails']) {
    await t.test(scenario, async (t) => {
      const events = [];
      const executable = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe';
      const processes = [
        { ProcessId: 100, ParentProcessId: 1, ExecutablePath: executable },
        { ProcessId: 101, ParentProcessId: 100, ExecutablePath: executable },
      ];
      let queries = 0;
      t.mock.method(accounts, 'getCodexAccountState', () => ({ accounts: [] }));
      t.mock.method(accounts, 'promoteCodexAccountToSystem', async () => {
        events.push('switch');
        return { ok: scenario !== 'switch-fails', message: 'switch result', config: {}, state: { accounts: [] } };
      });
      t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
        assert.equal(options.windowsHide, true);
        if (file === 'powershell.exe') {
          queries++;
          const running = scenario === 'closed' || (queries > 1 && !['still-running', 'kill-fails', 'partial-exit'].includes(scenario))
            ? [] : scenario === 'partial-exit' ? (queries === 1 ? processes : queries === 2 ? [processes[0]] : []) : processes;
          callback(null, running.length ? JSON.stringify(running) : '', '');
        } else {
          assert.equal(file, 'taskkill.exe');
          // Kill only the desktop PIDs, never descendants such as CodexBar.
          assert.deepEqual(args, scenario === 'partial-exit' && events.includes('kill')
            ? ['/PID', '100', '/F'] : ['/PID', '100', '/PID', '101', '/F']);
          assert.equal(args.includes('/T'), false);
          events.push('kill');
          callback(['kill-fails', 'already-exited'].includes(scenario) || (scenario === 'partial-exit' && events.length === 2)
            ? new Error('taskkill failed') : null, '', '');
        }
      });
      t.mock.method(childProcess, 'spawn', (file, args, options) => {
        assert.equal(file, executable);
        assert.deepEqual(args, []);
        assert.equal(options.detached, true);
        events.push('reopen');
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => scenario === 'reopen-fails'
          ? child.emit('error', new Error('launch failed')) : child.emit('spawn'));
        return child;
      });
      const result = await desktop.promoteWithDesktopRestart({}, 'account', async () => {
        events.push('confirm');
        return scenario !== 'cancel';
      });
      const expected = scenario === 'closed' ? ['switch']
        : scenario === 'cancel' ? ['confirm']
        : scenario === 'partial-exit' ? ['confirm', 'kill', 'kill', 'switch', 'reopen']
        : ['kill-fails', 'still-running'].includes(scenario) ? ['confirm', 'kill', 'kill', 'kill', 'reopen']
        : ['confirm', 'kill', 'switch', 'reopen'];
      assert.deepEqual(events, expected);
      assert.equal(result.ok, ['closed', 'yes', 'already-exited', 'partial-exit', 'reopen-fails'].includes(scenario));
      if (scenario === 'reopen-fails') assert.match(result.message, /Could not reopen ChatGPT/);
    });
  }
});
