/**
 * Codex CLI provider — locates the codex binary and spawns `codex app-server`
 * to fetch usage data when OAuth is unavailable.
 * Port of CodexCLIUsageStrategy from Swift.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn, ChildProcess } from 'child_process';
import { ProviderFetchResult, ProviderConfig, UsageSnapshot } from '../types';

// ──────────────────────── Binary Location ────────────────────────

function getCodexHome(): string {
  const envHome = process.env['CODEX_HOME']?.trim();
  if (envHome) return envHome;
  const userProfile = process.env['USERPROFILE'] || process.env['HOME'] || '';
  return path.join(userProfile, '.codex');
}

function getCodexBinaryFromConfig(): string | null {
  const configPath = path.join(getCodexHome(), 'config.toml');
  if (!fs.existsSync(configPath)) return null;

  try {
    const contents = fs.readFileSync(configPath, 'utf-8');
    for (const rawLine of contents.split('\n')) {
      const line = rawLine.split('#')[0]?.trim();
      if (!line) continue;
      const parts = line.split('=');
      if (parts.length < 2) continue;
      const key = parts[0].trim();
      if (key !== 'CODEX_CLI_PATH') continue;
      let value = parts.slice(1).join('=').trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      const resolved = value.trim();
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch { /* ignore */ }
  return null;
}

function scanLocalOpenAICodexBin(): string | null {
  const localAppData = process.env['LOCALAPPDATA'];
  if (!localAppData) return null;

  const binPath = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  if (!fs.existsSync(binPath)) return null;

  try {
    const dirs = fs.readdirSync(binPath);
    for (const dir of dirs) {
      const candidate = path.join(binPath, dir, 'codex.exe');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch { /* ignore */ }
  return null;
}

export function resolveCodexBinary(): string | null {
  // 1. Check path configured in ~/.codex/config.toml
  const configPath = getCodexBinaryFromConfig();
  if (configPath) return configPath;

  // 2. Scan dynamic local appdata subfolders
  const scannedPath = scanLocalOpenAICodexBin();
  if (scannedPath) return scannedPath;

  // 3. Check PATH — prefer .cmd/.exe over extensionless bash scripts and .ps1
  try {
    const result = execSync('where codex', {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim();
    const lines = result.split('\n').map(l => l.trim()).filter(Boolean);
    // Prefer .cmd or .exe (natively spawnable on Windows)
    const preferred = lines.find(l => /\.(cmd|exe)$/i.test(l));
    const pick = preferred || lines[0];
    if (pick && fs.existsSync(pick)) return pick;
  } catch { /* not on PATH */ }

  // 4. Check common Windows install locations
  const candidatePaths = [
    path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'codex', 'codex.exe'),
    path.join(process.env['PROGRAMFILES'] || '', 'codex', 'codex.exe'),
    path.join(process.env['APPDATA'] || '', 'npm', 'codex.cmd'),
    path.join(process.env['APPDATA'] || '', 'npm', 'codex'),
    path.join(process.env['USERPROFILE'] || '', '.local', 'bin', 'codex'),
    path.join(process.env['USERPROFILE'] || '', '.local', 'bin', 'codex.exe'),
  ];

  for (const candidate of candidatePaths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  return null;
}

// ──────────────────────── JSON-RPC over stdin/stdout ────────────────────────
// The codex app-server uses newline-delimited JSON-RPC 2.0 over stdin/stdout,
// NOT an HTTP server. This matches the Swift CodexRPCClient implementation.

let rpcProcess: ChildProcess | null = null;
let rpcNextId = 1;

interface RPCResponse {
  id?: number;
  method?: string;
  result?: any;
  error?: { code?: number; message?: string; data?: any };
}

/**
 * Spawn codex app-server process for JSON-RPC communication.
 * Returns the ChildProcess with stdin/stdout piped.
 */
function spawnAppServer(binary: string, codexHome?: string): ChildProcess {
  const quotedBinary = binary.includes(' ') ? `"${binary}"` : binary;
  const child = spawn(quotedBinary, ['-s', 'read-only', '-a', 'untrusted', 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: true,
    env: { ...process.env, TERM: 'dumb', ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
  });
  return child;
}

/**
 * Send a JSON-RPC request over stdin and wait for the matching response on stdout.
 */
function rpcRequest(
  child: ChildProcess,
  method: string,
  params: Record<string, any> = {},
  timeoutMs: number = 8000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = rpcNextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Codex RPC timed out waiting for \`${method}\` reply`));
      }
    }, timeoutMs);

    const onData = (data: Buffer) => {
      buffer += data.toString();
      // Process complete newline-delimited JSON messages
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        let msg: RPCResponse;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // skip non-JSON lines
        }

        // Skip notifications (no id field)
        if (msg.id === undefined || msg.id === null) continue;
        // Skip responses for other request ids
        if (msg.id !== id) continue;

        if (!settled) {
          settled = true;
          clearTimeout(timer);
          cleanup();

          if (msg.error) {
            const errData = msg.error.data;
            reject(Object.assign(
              new Error(msg.error.message || 'RPC error'),
              { rpcErrorData: errData }
            ));
          } else {
            resolve(msg.result);
          }
        }
        return;
      }
    };

    const onError = (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error(`Codex app-server error: ${err.message}`));
      }
    };

    const onExit = (code: number | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error(`Codex app-server exited with code ${code} before responding to ${method}`));
      }
    };

    const cleanup = () => {
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };

    child.stdout?.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);

    // Send the request
    child.stdin?.write(payload);
  });
}

/**
 * Send a JSON-RPC notification (no id, no response expected).
 */
function rpcNotify(child: ChildProcess, method: string, params: Record<string, any> = {}): void {
  const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
  child.stdin?.write(payload);
}

function killAppServer(): void {
  if (rpcProcess && !rpcProcess.killed) {
    try { rpcProcess.kill(); } catch { /* ignore */ }
  }
  rpcProcess = null;
}

// ──────────────────────── Usage Fetch via CLI ────────────────────────

export async function fetchViaCLI(config: ProviderConfig, codexHome?: string): Promise<ProviderFetchResult> {
  const binary = resolveCodexBinary();
  if (!binary) {
    return {
      providerId: 'codex',
      error: 'Codex CLI not found. Install it from https://github.com/openai/codex',
      fetchedAt: Date.now(),
    };
  }

  let child: ChildProcess | null = null;
  try {
    child = spawnAppServer(binary, codexHome);

    // 1. Initialize (matches Swift: clientName + clientVersion)
    await rpcRequest(child, 'initialize', {
      clientInfo: { name: 'codexbar-windows', version: '1.0.0' },
    }, 15000);

    // Send "initialized" notification (required by the protocol)
    rpcNotify(child, 'initialized');

    // 2. Fetch rate limits
    const limitsResult = await rpcRequest(child, 'account/rateLimits/read', {}, 10000);
    const rateLimits = limitsResult?.rateLimits;

    // 3. Fetch account info (best-effort, don't fail if it errors)
    let accountResult: any = null;
    try {
      accountResult = await rpcRequest(child, 'account/read', {}, 5000);
    } catch { /* optional */ }

    const now = Date.now();
    const usage: UsageSnapshot = {
      updatedAt: now,
      sourceLabel: 'codex-cli',
    };

    // Parse rate limits from JSON-RPC response
    if (rateLimits) {
      if (rateLimits.primary) {
        usage.primary = {
          usedPercent: rateLimits.primary.usedPercent ?? 0,
          resetAt: rateLimits.primary.resetsAt ?? 0,
          limitWindowSeconds: (rateLimits.primary.windowDurationMins ?? 300) * 60,
          label: 'Session',
        };
      }
      if (rateLimits.secondary) {
        usage.secondary = {
          usedPercent: rateLimits.secondary.usedPercent ?? 0,
          resetAt: rateLimits.secondary.resetsAt ?? 0,
          limitWindowSeconds: (rateLimits.secondary.windowDurationMins ?? 10080) * 60,
          label: 'Weekly',
        };
      }

      if (rateLimits.credits) {
        const balance = typeof rateLimits.credits.balance === 'string'
          ? parseFloat(rateLimits.credits.balance) || 0
          : (rateLimits.credits.balance ?? 0);
        usage.credits = {
          remaining: balance,
          unlimited: rateLimits.credits.unlimited || false,
          updatedAt: now,
        };
      }

      if (rateLimits.planType) {
        usage.planType = rateLimits.planType;
      }
    }

    // Parse account identity
    if (accountResult?.account) {
      const acct = accountResult.account;
      if (acct.type === 'chatgpt' && acct.email) {
        usage.identity = acct.email;
      }
      if (!usage.planType && acct.planType) {
        usage.planType = acct.planType;
      }
    }

    return { providerId: 'codex', usage, fetchedAt: now };
  } catch (err) {
    // Try to extract usage from RPC error data (matches Swift recoverUsageFromRPCError)
    const rpcData = (err as any)?.rpcErrorData;
    if (rpcData) {
      const now = Date.now();
      const usage: UsageSnapshot = {
        updatedAt: now,
        sourceLabel: 'codex-cli',
      };
      if (rpcData.email) usage.identity = rpcData.email;
      if (rpcData.plan_type) usage.planType = rpcData.plan_type;
      if (rpcData.rate_limit) {
        const rl = rpcData.rate_limit;
        if (rl.primary_window) {
          usage.primary = {
            usedPercent: rl.primary_window.used_percent ?? 0,
            resetAt: rl.primary_window.reset_at ?? 0,
            limitWindowSeconds: rl.primary_window.limit_window_seconds ?? 18000,
            label: 'Session',
          };
        }
      }
      return { providerId: 'codex', usage, fetchedAt: now };
    }

    return {
      providerId: 'codex',
      error: err instanceof Error ? err.message : String(err),
      fetchedAt: Date.now(),
    };
  } finally {
    if (child && !child.killed) {
      try { child.kill(); } catch { /* ignore */ }
    }
  }
}

/** Check if the codex binary exists on this system */
export function isAvailable(): boolean {
  return resolveCodexBinary() !== null;
}

/** Clean up resources on app shutdown */
export function shutdown(): void {
  killAppServer();
}
