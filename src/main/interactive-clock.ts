import { stripVTControlCharacters } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import * as pty from 'node-pty';
import type { ClockProvider } from '../shared/account-clocks';

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

export function clockLaunch(provider: ClockProvider, binary: string, home: string, cwd: string) {
  const args = provider === 'codex'
    ? ['--no-daemon', '--no-alt-screen', '-m', 'gpt-6-luna', '-s', 'read-only', '-C', cwd,
      '-c', 'model_reasoning_effort=low', '-c', 'cli_auth_credentials_store=file', '-c', 'check_for_update_on_startup=false']
    : ['--model', 'claude-haiku-5-5', '--effort', 'low', '--ax-screen-reader', '--tools', '',
      '--settings', path.join(cwd, 'clock-settings.json'), '--strict-mcp-config', '--mcp-config', path.join(cwd, 'clock-mcp.json')];
  const command = `& ${[binary, ...args].map(quote).join(' ')}; exit $LASTEXITCODE`;
  const env = { ...process.env, TERM: 'xterm-256color', [provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: home };
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_OAUTH_TOKEN.*|CLAUDE_CODE_USE_.*|CLAUDECODE|ELECTRON_RUN_AS_NODE|CI)$/i.test(key)) delete env[key];
  }
  return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], env, cwd };
}

// A PTY is required: positional prompts and print/exec modes do not start subscription windows.
export function sendInteractiveClock(
  provider: ClockProvider, binary: string, home: string, cwd: string, signal: AbortSignal,
  spawn: typeof pty.spawn = pty.spawn, timeoutMs = 120000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Clock activation canceled.')); return; }
    if (provider === 'claude') {
      // Files avoid Windows PowerShell stripping quotes from JSON command-line arguments.
      fs.writeFileSync(path.join(cwd, 'clock-settings.json'), '{"disableAllHooks":true}', { mode: 0o600 });
      fs.writeFileSync(path.join(cwd, 'clock-mcp.json'), '{"mcpServers":{}}', { mode: 0o600 });
    }
    const launch = clockLaunch(provider, binary, home, cwd);
    const terminal = spawn(launch.file, launch.args, { env: launch.env, cwd, cols: 120, rows: 40, name: 'xterm-256color' });
    let output = '';
    let sent = false;
    let finished = false;
    let exited = false;
    const answered = new Set<string>();
    let settle: ReturnType<typeof setTimeout> | undefined;
    let enter: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout); clearTimeout(settle); clearTimeout(enter);
      signal.removeEventListener('abort', cancel);
      data.dispose();
      const closed = () => {
        // node-pty drains ConPTY output for one second before reporting exit.
        setTimeout(() => {
          exit.dispose();
          try { if (!exited) terminal.kill(); } catch { /* The CLI may have already exited. */ }
          error ? reject(error) : resolve();
        }, process.platform === 'win32' && terminal.pid > 0 ? 1500 : 500);
      };
      // ConPTY alone can leave the CLI child holding its scratch directory open.
      if (!exited && process.platform === 'win32' && terminal.pid > 0) {
        execFile('taskkill.exe', ['/PID', String(terminal.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, closed);
      } else closed();
    };
    const cancel = () => finish(new Error('Clock activation canceled.'));
    const timeout = setTimeout(() => finish(new Error('Interactive CLI timed out. Re-authenticate the account or check the CLI installation.')), timeoutMs);
    const exit = terminal.onExit(() => { exited = true; finish(new Error('Interactive CLI exited before replying. Check the account login and model availability.')); });
    const data = terminal.onData((chunk) => {
      if (finished) return;
      if (chunk.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
      output = stripVTControlCharacters(output + chunk).slice(-24000);
      if (/not logged in|please log in|select login method|login expired|refresh token.{0,40}(expired|reused)|authentication failed/i.test(output)) {
        finish(new Error('CLI login needs attention. Re-authenticate this account in Settings.')); return;
      }
      if (sent) {
        if (/(?:^|[\r\n\x07])\s*(?:[•⏺●]\s*|claude:\s*)?OK\s*(?:[\r\n]|$)/m.test(output)) {
          clearTimeout(settle);
          settle = setTimeout(() => finish(), 300);
        }
        return;
      }
      const answer = (key: string, pattern: RegExp, input: string) => {
        if (answered.has(key) || !pattern.test(output)) return false;
        answered.add(key); output = ''; terminal.write(input); return true;
      };
      if (answer('theme', /choose.{0,30}(text style|theme)|select.{0,30}theme/i, '\r')
        // Trust only the empty scratch directory created for this job.
        || answer('trust-text', /Enter y\/n|Please answer y or n/i, 'y\r')
        || answer('trust', /trust.{0,50}(folder|directory)|trust this workspace/i, provider === 'claude' ? '\x1b[B\r' : '\r')
        || answer('security', /security notes|press enter to continue/i, '\r')) return;
      const ready = provider === 'codex' ? /context left|GPT-6-Luna low|Try "|for shortcuts/.test(output)
        : /Haiku 5\.5 with low effort|❯|for shortcuts|Try "/.test(output);
      if (ready) {
        sent = true; output = '';
        terminal.write('Reply OK.');
        // Separate typing and Enter, as in a physical interactive terminal.
        enter = setTimeout(() => { if (!finished) terminal.write('\r'); }, 250);
      }
    });
    signal.addEventListener('abort', cancel, { once: true });
  });
}
