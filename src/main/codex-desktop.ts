import { execFile, spawn } from 'child_process';
import { getCodexAccountState, promoteCodexAccountToSystem } from './codex-accounts';
import { CodexBarConfig } from './providers/types';
import { CodexAccountOperationResult, CodexAccountSwitchOptions } from '../shared/codex-accounts';

interface DesktopProcess {
  ProcessId: number;
  ParentProcessId: number;
  ExecutablePath: string;
}

interface WindowsProcess {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  ExecutablePath: string | null;
  CommandLine: string | null;
}

interface CodexBackendProcess extends WindowsProcess {
  client: 'VS Code' | 'T3 Code';
}

export function selectCodexBackendProcesses(
  processes: WindowsProcess[],
  options: CodexAccountSwitchOptions,
  ownPid: number = process.pid,
): CodexBackendProcess[] {
  const byPid = new Map(processes.map((item) => [item.ProcessId, item]));
  const ancestors = (pid: number): WindowsProcess[] => {
    const chain: WindowsProcess[] = [];
    const seen = new Set<number>();
    for (let item = byPid.get(pid); item && !seen.has(item.ProcessId); item = byPid.get(item.ParentProcessId)) {
      seen.add(item.ProcessId);
      chain.push(item);
    }
    return chain;
  };
  const protectedPids = new Set(ancestors(ownPid).map((item) => item.ProcessId));
  const selected: CodexBackendProcess[] = [];
  for (const item of processes) {
    if (item.Name.toLowerCase() !== 'codex.exe'
      || !/^(?:"[^"]+"|\S+)\s+"?app-server"?(?=\s|$)/i.test(item.CommandLine || '')
      || protectedPids.has(item.ProcessId)) continue;
    const chain = ancestors(item.ParentProcessId);
    if (chain.some((parent) => parent.ProcessId === ownPid)) continue;
    // T3's managed sign-in does not use the ambient auth.json being switched.
    if (item.CommandLine?.includes('openai_token_sharing')) continue;
    const t3 = chain.some((parent) => /^(?:t3[- ]?code(?: \((?:alpha|beta|nightly)\)| (?:alpha|beta|nightly))?|t3)\.exe$/i.test(parent.Name)
      || (['node.exe', 'bun.exe'].includes(parent.Name.toLowerCase())
        && /[\\/](?:t3code|@t3tools[\\/]code|\.t3[\\/]runtime)[\\/]/i.test(parent.CommandLine || '')));
    const vscode = /^Code(?: - Insiders)?\.exe$/i.test(chain[0]?.Name || '');
    if (t3 && options.stopT3Code) selected.push({ ...item, client: 'T3 Code' });
    else if (!t3 && vscode && options.stopVSCode) selected.push({ ...item, client: 'VS Code' });
  }
  return selected;
}

async function findCodexBackendProcesses(options?: CodexAccountSwitchOptions): Promise<CodexBackendProcess[]> {
  if (!options || (!options.stopVSCode && !options.stopT3Code)) return [];
  // ponytail: native Windows processes only; WSL/remote backends need a host integration.
  const output = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress",
  ]);
  const parsed = output.trim() ? JSON.parse(output) : [];
  return selectCodexBackendProcesses(Array.isArray(parsed) ? parsed : [parsed], options);
}

function runFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

export async function findCodexDesktopProcesses(): Promise<DesktopProcess[]> {
  // Electron's app.asar distinguishes the desktop executable from the Codex CLI.
  const output = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe' OR Name = 'Codex.exe'\" | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId -and $_.ExecutablePath -and (Test-Path -LiteralPath (Join-Path (Split-Path $_.ExecutablePath) 'resources/app.asar')) } | Select-Object ProcessId, ParentProcessId, ExecutablePath | ConvertTo-Json -Compress",
  ]);
  const parsed = output.trim() ? JSON.parse(output) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function reopenDesktop(executable: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

async function closeProcesses(
  processes: { ProcessId: number }[],
  findRemaining: () => Promise<{ ProcessId: number }[]>,
): Promise<void> {
  let remaining = processes;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3 && remaining.length; attempt++) {
    try {
      await runFile('taskkill.exe', [...remaining.flatMap((desktop) => ['/PID', String(desktop.ProcessId)]), '/F']);
    } catch (error) {
      // Helpers can exit between discovery and taskkill; retry whichever processes remain.
      lastError = error;
    }
    remaining = await findRemaining();
  }
  if (remaining.length) {
    throw lastError || new Error('Codex clients are still running. The account was not switched.');
  }
}

export async function promoteWithDesktopRestart(
  config: CodexBarConfig,
  accountId: string,
  confirmClose: (clients: string[]) => Promise<boolean>,
): Promise<CodexAccountOperationResult> {
  let result: CodexAccountOperationResult = {
    ok: false, message: 'Account switch canceled.', state: getCodexAccountState(config), config,
  };
  const reopen = new Set<string>();
  const stoppedBackends = new Set<string>();
  try {
    const desktops = await findCodexDesktopProcesses();
    const backends = await findCodexBackendProcesses(config.codexAccountSwitch);
    const clients = [
      ...(desktops.length ? ['Codex Desktop (close and reopen)'] : []),
      ...new Set(backends.map((backend) => `${backend.client} (stop Codex backends only)`)),
    ];
    if (clients.length && !await confirmClose(clients)) return result;
    if (backends.length) {
      for (const backend of backends) stoppedBackends.add(backend.client);
      await closeProcesses(backends, () => findCodexBackendProcesses(config.codexAccountSwitch));
    }
    if (desktops.length) {
      for (const desktop of desktops) reopen.add(desktop.ExecutablePath);
      // Never use /T: CodexBar may itself have been launched by ChatGPT.
      await closeProcesses(desktops, findCodexDesktopProcesses);
    }
    if ((await findCodexBackendProcesses(config.codexAccountSwitch)).length) {
      throw new Error('A Codex backend restarted before the account switch. Reload its host and try again.');
    }
    result = await promoteCodexAccountToSystem(config, accountId);
  } catch (error) {
    result.message = `Account switch failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    // A standalone spawn cannot reconnect the host's private stdio pipes.
    if (stoppedBackends.has('VS Code')) result.message += ' Reload the VS Code window to reconnect Codex.';
    if (stoppedBackends.has('T3 Code')) result.message += ' Restart the T3 Code Codex session if it does not reconnect.';
    for (const executable of reopen) {
      try {
        await reopenDesktop(executable);
      } catch (error) {
        result.message += ` Could not reopen ChatGPT: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  return result;
}
