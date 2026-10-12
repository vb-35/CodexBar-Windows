import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ClockProvider, ClockResult, ClockState, ClockTarget } from '../shared/account-clocks';
import { CodexAccountState } from '../shared/codex-accounts';
import { getCodexAccountState } from './codex-accounts';
import { getClaudeAccountState, getDefaultClaudeHome, getProfilePath, loadClaudeAuth, refreshManagedClaudeAuth, resolveClaudeBinary } from './claude-accounts';
import { getDefaultCodexHome, loadAuthFile, loadCredentials } from './providers/codex/auth';
import { resolveCodexBinary } from './providers/codex/cli';
import { fetchCodexUsage } from './providers/codex/oauth';
import { CodexBarConfig } from './providers/types';
import { sendInteractiveClock } from './interactive-clock';

function matchingSystemId(state: CodexAccountState): string | undefined {
  return state.systemAccountId || state.accounts.find((account) => state.systemAccount?.email
    && account.email === state.systemAccount.email)?.id;
}

export function getClockTargets(config: CodexBarConfig): (ClockTarget & { label: string })[] {
  return (['codex', 'claude'] as const).flatMap((provider) => {
    const state = provider === 'codex' ? getCodexAccountState(config) : getClaudeAccountState(config);
    const targets = state.accounts.map((account) => ({ provider, accountId: account.id, label: account.label }));
    if (state.systemAccount && !matchingSystemId(state)) targets.push({ provider, accountId: 'system', label: state.systemAccount.label });
    return targets;
  });
}

export async function confirmClock(provider: ClockProvider, home: string, signal: AbortSignal, attempts = 4): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal.throwIfAborted();
    if (provider === 'codex') {
      const auth = loadCredentials(home);
      if (!auth) throw new Error('Account credentials are missing.');
      let usage;
      try { usage = await fetchCodexUsage(auth, home); }
      catch { throw new Error('Could not check Codex usage. Refresh usage or re-authenticate this account.'); }
      const window = usage.rate_limit?.primary_window;
      if (!window) throw new Error('Codex did not report a subscription session window.');
      if (window && window.reset_at > Date.now() / 1000
        && (window.used_percent > 0 || window.reset_at - Date.now() / 1000 < window.limit_window_seconds - 3)) return true;
    } else {
      const auth = loadClaudeAuth(home);
      if (!auth) throw new Error('Account credentials are missing.');
      const renewed = await refreshManagedClaudeAuth(home, auth);
      const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${renewed.oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) throw new Error(`Usage verification failed (HTTP ${response.status}).`);
      const data = await response.json() as { five_hour?: { resets_at?: string }; limits?: { kind?: string; is_active?: boolean; resets_at?: string }[] };
      if (!data || (!('five_hour' in data) && !Array.isArray(data.limits))) throw new Error('Claude did not report a subscription session window.');
      const reset = data.five_hour?.resets_at || data.limits?.find((limit) => limit.kind === 'session' && limit.is_active !== false)?.resets_at;
      if (reset && !Number.isFinite(Date.parse(reset))) throw new Error('Claude reported an invalid session reset.');
      if (reset && Date.parse(reset) > Date.now()) return true;
    }
    if (attempt < attempts - 1) await delay(2500, undefined, { signal });
  }
  return false;
}

export async function startAccountClock(config: CodexBarConfig, target: ClockTarget, signal: AbortSignal): Promise<string> {
  const { provider } = target;
  const state = provider === 'codex' ? getCodexAccountState(config) : getClaudeAccountState(config);
  const id = target.accountId === 'system' ? matchingSystemId(state) : target.accountId;
  const account = state.accounts.find((item) => item.id === id);
  if (!account && (target.accountId !== 'system' || !state.systemAccount)) throw new Error('Account not found.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-clock-'));
  try {
    const cwd = path.join(scratch, 'workspace');
    fs.mkdirSync(cwd);
    let home = account?.managedHomePath;
    if (account) {
      const root = path.resolve(process.env.USERPROFILE || process.env.HOME || '', '.codexbar', `${provider}-accounts`);
      if (!home || path.dirname(path.resolve(home)).toLowerCase() !== root.toLowerCase()) throw new Error('Account has no isolated CLI profile. Import or re-authenticate it first.');
    } else {
      // The ambient account gets a temporary profile; desktop credentials/settings are never written.
      home = path.join(scratch, 'profile');
      fs.mkdirSync(home);
      const ambient = provider === 'codex' ? getDefaultCodexHome() : getDefaultClaudeHome();
      const filename = provider === 'codex' ? 'auth.json' : '.credentials.json';
      fs.copyFileSync(path.join(ambient, filename), path.join(home, filename));
      if (provider === 'claude' && fs.existsSync(getProfilePath(ambient))) fs.copyFileSync(getProfilePath(ambient), path.join(home, '.claude.json'));
    }
    const codexAuth = provider === 'codex' ? loadAuthFile(path.join(home!, 'auth.json')) : null;
    if (provider === 'codex' ? !codexAuth?.raw.tokens || !!codexAuth.raw.OPENAI_API_KEY : !loadClaudeAuth(home)) {
      throw new Error('A subscription login is required. Re-authenticate this account in Settings.');
    }
    return await runClockSession(provider, home!, cwd, () => provider === 'codex' ? resolveCodexBinary() : resolveClaudeBinary(), signal);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

/** Skips running clocks, then messages the isolated CLI profile and verifies the clock with the provider. */
export async function runClockSession(
  provider: ClockProvider, home: string, cwd: string, resolveBinary: () => string | null | undefined, signal: AbortSignal,
  options: { precheck?: boolean; spawn?: Parameters<typeof sendInteractiveClock>[5] } = {},
): Promise<string> {
  if (options.precheck !== false && await confirmClock(provider, home, signal, 1)) return 'Already running; skipped.';
  signal.throwIfAborted();
  const binary = resolveBinary();
  if (!binary) throw new Error(`${provider === 'codex' ? 'Codex' : 'Claude Code'} CLI is not installed.`);
  try {
    await sendInteractiveClock(provider, binary, home, cwd, signal, options.spawn);
  } catch (error) {
    signal.throwIfAborted();
    // A missed terminal reply must not report failure when the clock actually started.
    if (await confirmClock(provider, home, signal, 1).catch(() => false)) return 'Clock running.';
    throw error;
  }
  try {
    if (await confirmClock(provider, home, signal)) return 'Clock running.';
    throw new Error('The provider has not reported an active clock yet.');
  } catch (error) {
    throw new Error(`Message delivered; clock could not be verified. ${error instanceof Error ? error.message : 'Refresh usage to check.'}`);
  }
}

export async function startClocksSequentially(
  targets: (ClockTarget & { label: string })[],
  run: (target: ClockTarget) => Promise<string>,
  update: (state: ClockState) => void,
  signal: AbortSignal,
): Promise<ClockState> {
  const results: ClockResult[] = [];
  for (const [index, target] of targets.entries()) {
    if (signal.aborted) break;
    update({ busy: true, message: `Checking ${index + 1}/${targets.length}: ${target.label} (${target.provider})…`, results: [...results] });
    try {
      results.push({ ...target, ok: true, message: await run(target) });
    } catch (error) {
      results.push({ ...target, ok: false, message: error instanceof Error ? error.message : 'Clock activation failed.' });
    }
  }
  const successful = results.filter((result) => result.ok).length;
  const skipped = results.filter((result) => result.ok && result.message === 'Already running; skipped.').length;
  const state = { busy: false, message: signal.aborted ? 'Clock activation canceled.' : targets.length
    ? `${successful - skipped} started · ${skipped} already running · ${results.length - successful} failed.` : 'No signed-in accounts found.', results };
  update(state);
  return state;
}
