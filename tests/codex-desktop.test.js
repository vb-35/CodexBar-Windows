const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const accounts = require('../dist/main/codex-accounts.js');
const desktop = require('../dist/main/codex-desktop.js');

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
