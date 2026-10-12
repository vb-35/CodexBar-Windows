/**
 * Headless clock starter for Linux machines with several local users.
 *
 * Run as root, it starts one worker per user with that user's uid/gid, so credentials are only ever read and
 * written by their owner. Each login is copied into a throwaway profile; the user's own CLI files are never
 * opened for writing except to save tokens the CLI renewed during the run.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import type { ClockProvider } from '../shared/account-clocks';
import { runClockSession } from './account-clocks';
import { loadAuthFile } from './providers/codex/auth';
import * as pty from 'node-pty';
import type { sendInteractiveClock } from './interactive-clock';

type Spawn = NonNullable<Parameters<typeof sendInteractiveClock>[5]>;

export const OPT_OUT_FILE = '.codexbar-no-clock';

export interface LocalUser { name: string; uid: number; gid: number; home: string }

export interface LocalLogin { provider: ClockProvider; label: string; credentials: string; profile?: string }

export interface LoginResult { provider?: ClockProvider; label: string; ok: boolean; message: string }

/** Root and regular login accounts (uid 1000–59999); system accounts and nobody are skipped. */
export function parsePasswd(text: string): LocalUser[] {
  return text.split('\n').flatMap((line) => {
    const [name, , uid, gid, , home] = line.trim().split(':');
    const id = Number(uid);
    if (!name || name.startsWith('#') || !home || !Number.isInteger(id) || !(id === 0 || (id >= 1000 && id < 60000))) return [];
    return [{ name, uid: id, gid: Number(gid), home }];
  });
}

/** Directory-service users are often not enumerable, so local /home folders are added by owner. */
export function listLocalUsers(): LocalUser[] {
  let passwd: string;
  try { passwd = execFileSync('getent', ['passwd'], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 * 1024 }); }
  catch { passwd = fs.readFileSync('/etc/passwd', 'utf8'); }
  const users = parsePasswd(passwd);
  const homes = new Set(users.map((user) => path.resolve(user.home)));
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync('/home', { withFileTypes: true }); } catch { /* No /home on this machine. */ }
  for (const entry of entries) {
    const home = path.join('/home', entry.name);
    if (!entry.isDirectory() || homes.has(home)) continue;
    const stat = fs.statSync(home);
    if (stat.uid >= 1000 && stat.uid < 60000) users.push({ name: entry.name, uid: stat.uid, gid: stat.gid, home });
  }
  return users.filter((user) => { try { return fs.statSync(user.home).isDirectory(); } catch { return false; } });
}

function readJson(filename: string): any {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return undefined; }
}

/** Subscription logins in the CLIs' default locations; API-key logins cannot start subscription clocks. */
export function findLogins(home: string): LocalLogin[] {
  const logins: LocalLogin[] = [];
  const claude = path.join(home, '.claude', '.credentials.json');
  const token = readJson(claude)?.claudeAiOauth?.accessToken;
  if (typeof token === 'string' && token.trim()) {
    const profile = path.join(home, '.claude.json');
    const email = readJson(profile)?.oauthAccount?.emailAddress;
    logins.push({ provider: 'claude', label: typeof email === 'string' && email ? email : 'Claude', credentials: claude, profile });
  }
  const codex = loadAuthFile(path.join(home, '.codex', 'auth.json'));
  if (codex?.raw.tokens && !codex.raw.OPENAI_API_KEY) logins.push({ provider: 'codex', label: codex.email || 'Codex', credentials: codex.authPath });
  return logins;
}

/** Expired tokens cannot check usage; the CLI renews them itself when it starts. */
export function tokenExpired(provider: ClockProvider, raw: any, now = Date.now()): boolean {
  if (provider === 'claude') {
    const expiresAt = raw?.claudeAiOauth?.expiresAt;
    return typeof expiresAt === 'number' && expiresAt < now + 60000;
  }
  try {
    const exp = JSON.parse(Buffer.from(String(raw?.tokens?.access_token).split('.')[1], 'base64url').toString('utf8')).exp;
    return typeof exp === 'number' && exp * 1000 < now + 60000;
  } catch {
    return false;
  }
}

/**
 * Saves tokens the CLI renewed in the private copy back to the user's login. Providers can rotate refresh
 * tokens, so discarding a renewal could sign the user out. The login is only replaced when it is unchanged
 * since it was copied, so a switch or re-login during the run always wins.
 */
export function syncRenewedLogin(provider: ClockProvider, source: string, original: Buffer, copy: string): string | undefined {
  let renewed: Buffer;
  try { renewed = fs.readFileSync(copy); } catch { return undefined; }
  if (renewed.equals(original)) return undefined;
  let next, previous;
  try { next = JSON.parse(renewed.toString('utf8')); previous = JSON.parse(original.toString('utf8')); }
  catch { return 'Renewed login was unreadable; original kept.'; }
  const valid = provider === 'claude'
    ? typeof next?.claudeAiOauth?.accessToken === 'string' && !!next.claudeAiOauth.accessToken
    : typeof next?.tokens?.access_token === 'string' && !next.OPENAI_API_KEY
      && (!next.tokens.account_id || !previous?.tokens?.account_id || next.tokens.account_id === previous.tokens.account_id);
  if (!valid) return 'Renewed login did not match the original account; original kept.';
  let current: Buffer;
  try { current = fs.readFileSync(source); } catch { return 'Login was removed during the run; not restored.'; }
  if (!current.equals(original)) return 'Login changed during the run; left untouched.';
  const temporary = path.join(path.dirname(source), `.${path.basename(source)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, renewed, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(temporary, fs.statSync(source).mode & 0o777);
    fs.renameSync(temporary, source);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return 'Renewed login saved.';
}

/** Starts one login's clock from a private copy; the CLI also gets a throwaway HOME so it cannot touch user files. */
export async function startLoginClock(login: LocalLogin, binary: string | undefined, signal: AbortSignal, spawn?: Spawn): Promise<string> {
  const original = fs.readFileSync(login.credentials);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-clock-'));
  const home = path.join(scratch, 'home');
  const config = path.join(scratch, 'config');
  const cwd = path.join(scratch, 'workspace');
  for (const dir of [home, config, cwd]) fs.mkdirSync(dir, { mode: 0o700 });
  const copy = path.join(config, path.basename(login.credentials));
  fs.writeFileSync(copy, original, { mode: 0o600 });
  if (login.profile && fs.existsSync(login.profile)) fs.copyFileSync(login.profile, path.join(config, '.claude.json'));
  const pids: number[] = [];
  const isolated: Spawn = (file, args, options) => {
    const terminal = (spawn || pty.spawn)(file, args,
      { ...options, env: { ...options?.env, HOME: home, DISABLE_AUTOUPDATER: '1' } });
    if (terminal.pid > 0) pids.push(terminal.pid);
    return terminal;
  };
  const finish = () => {
    // The PTY leads its own process group; stop anything the CLI left behind before saving its tokens.
    for (const pid of pids) try { process.kill(-pid, 'SIGKILL'); } catch { /* Already exited. */ }
    return syncRenewedLogin(login.provider, login.credentials, original, copy);
  };
  try {
    let raw;
    try { raw = JSON.parse(original.toString('utf8')); } catch { throw new Error('Login file is not valid JSON.'); }
    const message = await runClockSession(login.provider, config, cwd, () => binary, signal,
      { precheck: !tokenExpired(login.provider, raw), spawn: isolated });
    const note = finish();
    return note ? `${message} ${note}` : message;
  } catch (error) {
    const note = finish();
    const message = error instanceof Error ? error.message : 'Clock activation failed.';
    throw new Error(note ? `${message} ${note}` : message);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

function cliBinary(provider: ClockProvider): string | undefined {
  const configured = process.env[provider === 'codex' ? 'CODEXBAR_CODEX_BIN' : 'CODEXBAR_CLAUDE_BIN'];
  // The installer pins private CLI copies next to dist/, so user installs and updates never affect them.
  const pinned = path.resolve(__dirname, '..', '..', 'cli', 'node_modules', '.bin', provider === 'codex' ? 'codex' : 'claude');
  return configured || (fs.existsSync(pinned) ? pinned : undefined);
}

async function worker(dryRun: boolean): Promise<LoginResult[]> {
  const home = process.env.HOME || os.homedir();
  if (fs.existsSync(path.join(home, OPT_OUT_FILE))) return [{ label: '-', ok: true, message: `Opted out (~/${OPT_OUT_FILE}).` }];
  const results: LoginResult[] = [];
  for (const login of findLogins(home)) {
    const result = { provider: login.provider, label: login.label };
    if (dryRun) { results.push({ ...result, ok: true, message: 'Found.' }); continue; }
    try {
      results.push({ ...result, ok: true, message: await startLoginClock(login, cliBinary(login.provider), AbortSignal.timeout(5 * 60000)) });
    } catch (error) {
      results.push({ ...result, ok: false, message: error instanceof Error ? error.message : 'Clock activation failed.' });
    }
  }
  return results;
}

function runWorker(user: LocalUser, switchUser: boolean, dryRun: boolean): Promise<LoginResult[]> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      HOME: user.home, USER: user.name, LOGNAME: user.name, LANG: 'C.UTF-8', TMPDIR: os.tmpdir(),
      // npm CLI shims start with `#!/usr/bin/env node`.
      PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    };
    for (const key of ['CODEXBAR_CODEX_BIN', 'CODEXBAR_CLAUDE_BIN']) if (process.env[key]) env[key] = process.env[key];
    let results: LoginResult[] | undefined;
    const child = fork(__filename, ['--worker', ...(dryRun ? ['--dry-run'] : [])], {
      cwd: '/', env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], ...(switchUser ? { uid: user.uid, gid: user.gid } : {}),
    });
    child.on('message', (message) => { results = message as LoginResult[]; });
    child.on('error', (error) => resolve([{ label: '-', ok: false, message: `Worker failed: ${error.message}` }]));
    child.on('exit', (code) => resolve(results || [{ label: '-', ok: false, message: `Worker exited with code ${code}.` }]));
  });
}

async function main(args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const only = args.flatMap((arg, index) => args[index - 1] === '--user' ? [arg] : []);
  if (process.platform === 'win32' || !process.getuid) { console.error('This script runs on Linux.'); return 2; }
  const root = process.getuid() === 0;
  // Without root, only the current user's logins are readable.
  const users = listLocalUsers().filter((user) => (root || user.uid === process.getuid!()) && (!only.length || only.includes(user.name)));
  let started = 0, running = 0, failed = 0;
  for (const user of users) {
    for (const result of await runWorker(user, root, dryRun)) {
      console.log(`${user.name} · ${result.provider || '-'} · ${result.label}: ${result.ok ? '' : 'FAILED: '}${result.message}`);
      if (!result.ok) failed++;
      else if (result.message.startsWith('Already running')) running++;
      else if (result.provider && !dryRun) started++;
    }
  }
  if (!dryRun) console.log(`${started} started · ${running} already running · ${failed} failed.`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  if (process.argv.includes('--worker')) {
    worker(process.argv.includes('--dry-run'))
      .catch((error) => [{ label: '-', ok: false, message: error instanceof Error ? error.message : String(error) }])
      // node-pty can hold handles open, so exit once the parent has the results.
      .then((results) => process.send!(results, () => process.exit(0)));
  } else {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
  }
}
