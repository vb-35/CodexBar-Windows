import { execFile, spawn } from 'child_process';
import { getCodexAccountState, promoteCodexAccountToSystem } from './codex-accounts';
import { CodexBarConfig } from './providers/types';
import { CodexAccountOperationResult } from '../shared/codex-accounts';

interface DesktopProcess {
  ProcessId: number;
  ParentProcessId: number;
  ExecutablePath: string;
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

async function closeDesktop(processes: DesktopProcess[]): Promise<void> {
  let remaining = processes;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3 && remaining.length; attempt++) {
    try {
      await runFile('taskkill.exe', [...remaining.flatMap((desktop) => ['/PID', String(desktop.ProcessId)]), '/F']);
    } catch (error) {
      // Helpers can exit between discovery and taskkill; retry whichever processes remain.
      lastError = error;
    }
    remaining = await findCodexDesktopProcesses();
  }
  if (remaining.length) {
    throw lastError || new Error('ChatGPT is still running. The account was not switched.');
  }
}

export async function promoteWithDesktopRestart(
  config: CodexBarConfig,
  accountId: string,
  confirmClose: () => Promise<boolean>,
): Promise<CodexAccountOperationResult> {
  let result: CodexAccountOperationResult = {
    ok: false, message: 'Account switch canceled.', state: getCodexAccountState(config), config,
  };
  const reopen = new Set<string>();
  try {
    const desktops = await findCodexDesktopProcesses();
    if (desktops.length && !await confirmClose()) return result;
    if (desktops.length) {
      for (const desktop of desktops) reopen.add(desktop.ExecutablePath);
      // Never use /T: CodexBar may itself have been launched by ChatGPT.
      await closeDesktop(desktops);
    }
    result = await promoteCodexAccountToSystem(config, accountId);
  } catch (error) {
    result.message = `Account switch failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
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
