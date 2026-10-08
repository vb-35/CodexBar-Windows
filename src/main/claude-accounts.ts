import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFile, execFileSync, spawn } from 'child_process';
import { CodexAccountState as AccountState, CodexAccountOperationResult as AccountResult, CodexStoredAccount as StoredAccount } from '../shared/codex-accounts';
import type { CodexBarConfig } from './providers/types';

export function getDefaultClaudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude');
}

function getProfilePath(home: string): string {
  return path.resolve(home) === path.resolve(getDefaultClaudeHome()) && !process.env.CLAUDE_CONFIG_DIR
    ? path.join(path.dirname(home), '.claude.json') : path.join(home, '.claude.json');
}

function getAccountsRoot(): string {
  return path.join(process.env.USERPROFILE || process.env.HOME || '', '.codexbar', 'claude-accounts');
}

const tokenRefreshes = new Map<string, Promise<NonNullable<ReturnType<typeof loadClaudeAuth>>>>();

export async function refreshManagedClaudeAuth(home: string, auth: NonNullable<ReturnType<typeof loadClaudeAuth>>, force = false) {
  if (path.dirname(path.resolve(home)) !== path.resolve(getAccountsRoot()) || path.resolve(home) === path.resolve(getDefaultClaudeHome())) return auth;
  if (!force && !(typeof auth.oauth.expiresAt === 'number' && auth.oauth.expiresAt < Date.now() + 60000)) return auth;
  if (typeof auth.oauth.refreshToken !== 'string' || !auth.oauth.refreshToken) return auth;
  const pending = tokenRefreshes.get(home);
  if (pending) return pending;
  const job = (async () => {
    // Claude Code owns the ambient credentials; only renew CodexBar's private copies.
    const current = loadClaudeAuth(home);
    if (current && current.authFingerprint !== auth.authFingerprint) return current;
    const response = await fetch('https://platform.claude.com/v1/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.oauth.refreshToken,
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' }), redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Claude token renewal failed (HTTP ${response.status}). Re-authenticate this account in Settings.`);
    const data = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== 'string' || !data.access_token.trim() || typeof data.expires_in !== 'number'
      || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Claude returned invalid renewed credentials.');
    const raw = { ...auth.raw, claudeAiOauth: { ...auth.oauth, accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : auth.oauth.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000 } };
    const temporary = path.join(home, `.credentials.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(raw, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, path.join(home, '.credentials.json'));
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return loadClaudeAuth(home)!;
  })();
  tokenRefreshes.set(home, job);
  try { return await job; } finally { tokenRefreshes.delete(home); }
}

export function loadClaudeAuth(home = getDefaultClaudeHome()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8'));
    const oauth = raw?.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken.trim()) return null;
    let profile;
    try {
      profile = JSON.parse(fs.readFileSync(getProfilePath(home), 'utf8')).oauthAccount;
    } catch { /* Credentials imports may not include profile metadata. */ }
    const email = typeof profile?.emailAddress === 'string' ? profile.emailAddress.trim().toLowerCase() : undefined;
    return {
      raw, oauth, email,
      accountId: typeof profile?.accountUuid === 'string' ? profile.accountUuid : undefined,
      label: email || 'Claude Account',
      authFingerprint: createHash('sha256').update(oauth.accessToken).digest('hex'),
    };
  } catch {
    return null;
  }
}

export function getClaudeAccountState(config: CodexBarConfig): AccountState {
  const system = loadClaudeAuth();
  const accounts = (config.claudeAccounts?.accounts || []).map((account) => {
    const auth = account.managedHomePath ? loadClaudeAuth(account.managedHomePath) : null;
    return auth ? { ...account, email: auth.email || account.email, label: auth.email || account.label, authFingerprint: auth.authFingerprint } : account;
  });
  const selected = config.claudeAccounts?.activeAccountId;
  const systemAccountId = system ? accounts.find((account) => account.authFingerprint === system.authFingerprint)?.id : undefined;
  return {
    accounts,
    // Private credentials can renew independently even when their email matches the CLI login.
    activeAccountId: selected !== systemAccountId && accounts.some((account) => account.id === selected) ? selected : undefined,
    systemAccountId,
    systemAccount: system ? { email: system.email, accountId: system.accountId, label: system.label, authFingerprint: system.authFingerprint } : undefined,
    missingSystemAuth: !system,
  };
}

export function resolveActiveClaudeHome(config?: CodexBarConfig): string {
  const state = getClaudeAccountState(config || { version: 1, providers: [] });
  return state.accounts.find((account) => account.id === state.activeAccountId)?.managedHomePath || getDefaultClaudeHome();
}

function result(config: CodexBarConfig, ok: boolean, message: string): AccountResult {
  return { ok, message, config, state: getClaudeAccountState(config) };
}

export function selectClaudeAccount(config: CodexBarConfig, accountId?: string): AccountResult {
  const state = getClaudeAccountState(config);
  if (accountId && !state.accounts.some((account) => account.id === accountId)) {
    return result(config, false, 'Claude account not found.');
  }
  return result({ ...config, claudeAccounts: { accounts: state.accounts, activeAccountId: accountId } }, true, 'Active Claude account updated.');
}

async function storeAccount(config: CodexBarConfig, home: string, preferredId?: string): Promise<AccountResult> {
  const auth = loadClaudeAuth(home);
  if (!auth) return result(config, false, 'No valid Claude Code credentials found.');
  if (!auth.email) {
    try {
      const response = await fetch('https://api.anthropic.com/api/oauth/profile', {
        headers: { Authorization: `Bearer ${auth.oauth.accessToken}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const profile = await response.json() as { account?: { email?: string; email_address?: string; emailAddress?: string; uuid?: string } };
        const email = profile.account?.email || profile.account?.email_address || profile.account?.emailAddress;
        if (typeof email === 'string' && email.trim()) auth.email = email.trim().toLowerCase();
        if (typeof profile.account?.uuid === 'string') auth.accountId = profile.account.uuid;
      }
    } catch { /* Account usage still works when profile metadata is unavailable. */ }
  }
  const accounts = getClaudeAccountState(config).accounts;
  const existing = accounts.find((account) => account.id === preferredId || account.authFingerprint === auth.authFingerprint
    || (!!auth.email && account.email === auth.email));
  const now = new Date().toISOString();
  const account: StoredAccount = {
    id: existing?.id || randomUUID(), source: 'managed', email: auth.email || existing?.email,
    accountId: auth.accountId, label: auth.email || existing?.label || `Claude ${accounts.length + 1}`,
    authFingerprint: auth.authFingerprint, managedHomePath: home, managedAuthPath: path.join(home, '.credentials.json'),
    createdAt: existing?.createdAt || now, updatedAt: now, lastAuthenticatedAt: now,
  };
  // Keep imported profile metadata alongside credentials for later CLI promotion.
  if (auth.email || auth.accountId) {
    const profilePath = getProfilePath(home);
    const profile = fs.existsSync(profilePath) ? JSON.parse(fs.readFileSync(profilePath, 'utf8')) : {};
    fs.writeFileSync(profilePath, JSON.stringify({ ...profile, oauthAccount: {
      ...profile.oauthAccount, emailAddress: auth.email, accountUuid: auth.accountId,
    } }, null, 2), { mode: 0o600 });
  }
  return result({ ...config, claudeAccounts: {
    accounts: existing ? accounts.map((item) => item.id === existing.id ? account : item) : [...accounts, account],
    activeAccountId: account.id,
  } }, true, existing ? 'Claude account updated.' : 'Claude account added.');
}

export async function importClaudeAccount(config: CodexBarConfig, filename: string): Promise<AccountResult> {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (typeof raw?.claudeAiOauth?.accessToken !== 'string' || !raw.claudeAiOauth.accessToken.trim()) throw new Error();
  } catch {
    return result(config, false, 'Select a valid Claude Code .credentials.json file.');
  }
  const home = path.join(getAccountsRoot(), randomUUID());
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify(raw, null, 2), { mode: 0o600 });
  return storeAccount(config, home);
}

export async function loginClaudeAccount(config: CodexBarConfig, accountId?: string): Promise<AccountResult> {
  if (accountId && !getClaudeAccountState(config).accounts.some((account) => account.id === accountId)) {
    return result(config, false, 'Claude account not found.');
  }
  let binary: string | undefined;
  try {
    binary = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      .split(/\r?\n/).map((line) => line.trim()).find((line) => /\.(exe|cmd)$/i.test(line));
  } catch { /* Check the native install when it is absent from PATH. */ }
  const native = path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'bin', 'claude.exe');
  if (!binary && fs.existsSync(native)) binary = native;
  if (!binary) return result(config, false, 'Claude Code CLI not found. Install Claude Code or import .credentials.json.');

  // A fresh directory keeps a canceled re-authentication from overwriting the saved account.
  const home = path.join(getAccountsRoot(), randomUUID());
  fs.mkdirSync(home, { recursive: true });
  const encoded = Buffer.from(`& '${binary.replace(/'/g, "''")}' auth login --claudeai; exit $LASTEXITCODE`, 'utf16le').toString('base64');
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: home };
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) delete env[key];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command',
        `$p = Start-Process powershell.exe -ArgumentList '-NoProfile -EncodedCommand ${encoded}' -PassThru -Wait; exit $p.ExitCode`],
      { cwd: home, env, windowsHide: true });
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Claude login timed out.')); }, 5 * 60 * 1000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Claude login was canceled or failed.')); });
    });
    return await storeAccount(config, home, accountId);
  } catch (error) {
    return result(config, false, error instanceof Error ? error.message : 'Claude login failed.');
  }
}

export function removeClaudeAccount(config: CodexBarConfig, accountId: string): AccountResult {
  const state = getClaudeAccountState(config);
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return result(config, false, 'Claude account not found.');
  if (account.managedHomePath) {
    const home = path.resolve(account.managedHomePath);
    if (path.dirname(home) !== path.resolve(getAccountsRoot())) return result(config, false, 'Refusing to delete credentials outside the managed Claude accounts directory.');
    fs.rmSync(home, { recursive: true, force: true });
  }
  return result({ ...config, claudeAccounts: {
    accounts: state.accounts.filter((item) => item.id !== accountId),
    activeAccountId: state.activeAccountId === accountId ? undefined : state.activeAccountId,
  } }, true, 'Claude account removed.');
}

function replaceFile(filename: string, data: Buffer | string): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

const REMOTE_AUTH_SYNC_SCRIPT = String.raw`import json, os, shutil, sys, tempfile
payload=json.load(sys.stdin)
auth=payload.get("credentials")
if not isinstance(auth,dict) or not isinstance(auth.get("claudeAiOauth"),dict) or not isinstance(auth["claudeAiOauth"].get("accessToken"),str) or not auth["claudeAiOauth"]["accessToken"].strip():
 raise ValueError("Invalid credentials")
account=payload.get("oauthAccount")
if not isinstance(account,dict): raise ValueError("Invalid account metadata")
home=os.path.abspath(os.path.expanduser(sys.argv[1]))
profile=os.path.join(os.path.dirname(home),".claude.json") if os.path.normcase(home)==os.path.normcase(os.path.abspath(os.path.expanduser("~/.claude"))) else os.path.join(home,".claude.json")
credentials=os.path.join(home,".credentials.json")
os.makedirs(home,mode=0o700,exist_ok=True)
def read(filename):
 return open(filename,"rb").read() if os.path.exists(filename) else None
def replace(filename,data):
 fd,temporary=tempfile.mkstemp(prefix=".codexbar-",suffix=".tmp",dir=os.path.dirname(filename))
 try:
  with os.fdopen(fd,"wb") as handle: handle.write(data)
  os.chmod(temporary,0o600)
  os.replace(temporary,filename)
 finally:
  if os.path.exists(temporary): os.unlink(temporary)
previous={profile:read(profile),credentials:read(credentials)}
settings=json.loads(previous[profile]) if previous[profile] is not None else {}
if not isinstance(settings,dict): raise ValueError("Invalid CLI settings")
settings["oauthAccount"]=account
for filename,data in previous.items():
 backup=filename+".codexbar-backup"
 if data is not None and not os.path.exists(backup):
  shutil.copy2(filename,backup)
  os.chmod(backup,0o600)
try:
 replace(profile,json.dumps(settings,indent=2).encode())
 replace(credentials,json.dumps(auth,indent=2).encode())
except BaseException:
 for filename,data in previous.items():
  try:
   if data is not None: replace(filename,data)
   elif os.path.exists(filename): os.unlink(filename)
  except OSError: pass
 raise
`;

export async function syncRemoteClaudeAuth(remote: NonNullable<CodexBarConfig['remoteHistory']>, home: string): Promise<void> {
  if (!remote.sshTarget || remote.sshTarget.startsWith('-') || !/^[A-Za-z0-9_.@:\[\]-]+$/.test(remote.sshTarget)) {
    throw new Error('Invalid SSH target.');
  }
  const auth = loadClaudeAuth(home);
  if (!auth) throw new Error('Claude credentials are unreadable.');
  const profile = getProfilePath(home);
  const oauthAccount = fs.existsSync(profile) ? JSON.parse(fs.readFileSync(profile, 'utf8')).oauthAccount
    : { emailAddress: auth.email, accountUuid: auth.accountId };
  const payload = JSON.stringify({ credentials: auth.raw, oauthAccount: oauthAccount || {} });
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error('Remote Claude login sync failed. Check SSH access, Python 3, and permissions; verify the remote CLI login before retrying.'));
    const child = execFile('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', remote.sshTarget,
      `python3 -c ${quote(REMOTE_AUTH_SYNC_SCRIPT)} ${quote(remote.claudeHome || '~/.claude')}`],
    { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }, (error) => { if (error) failed(); else resolve(); });
    if (!child.stdin) { failed(); return; }
    child.stdin.once('error', failed);
    child.stdin.end(payload);
  });
}

export async function promoteClaudeAccountToSystem(config: CodexBarConfig, accountId: string): Promise<AccountResult> {
  const state = getClaudeAccountState(config);
  const target = state.accounts.find((account) => account.id === accountId);
  if (!target?.managedHomePath || path.dirname(path.resolve(target.managedHomePath)) !== path.resolve(getAccountsRoot())) {
    return result(config, false, 'Select a managed Claude account to make the CLI account.');
  }
  let auth = loadClaudeAuth(target.managedHomePath);
  if (!auth) return result(config, false, 'Managed Claude credentials are unreadable. Re-authenticate before switching.');
  const systemHome = getDefaultClaudeHome();
  const authPath = path.join(systemHome, '.credentials.json');
  const profilePath = getProfilePath(systemHome);
  try {
    auth = await refreshManagedClaudeAuth(target.managedHomePath, auth);
    const previousAuth = fs.existsSync(authPath) ? fs.readFileSync(authPath) : undefined;
    const previousProfile = fs.existsSync(profilePath) ? fs.readFileSync(profilePath) : undefined;
    const profile = previousProfile ? JSON.parse(previousProfile.toString('utf8')) : {};
    const managedProfilePath = getProfilePath(target.managedHomePath);
    const managedProfile = fs.existsSync(managedProfilePath) ? JSON.parse(fs.readFileSync(managedProfilePath, 'utf8')).oauthAccount : undefined;
    const oauthAccount = managedProfile || { emailAddress: target.email || auth.email, accountUuid: target.accountId || auth.accountId };
    const previous = loadClaudeAuth(systemHome);
    const accounts = [...state.accounts];
    if (previous && previous.authFingerprint !== auth.authFingerprint && !accounts.some((item) => item.authFingerprint === previous.authFingerprint)) {
      const id = randomUUID();
      const home = path.join(getAccountsRoot(), id);
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, '.credentials.json'), previousAuth!, { mode: 0o600 });
      if (previousProfile) fs.writeFileSync(path.join(home, '.claude.json'), previousProfile, { mode: 0o600 });
      const now = new Date().toISOString();
      accounts.push({ id, source: 'managed', email: previous.email, accountId: previous.accountId, label: previous.label,
        authFingerprint: previous.authFingerprint, managedHomePath: home, managedAuthPath: path.join(home, '.credentials.json'),
        createdAt: now, updatedAt: now, lastAuthenticatedAt: now });
    }
    fs.mkdirSync(systemHome, { recursive: true });
    try {
      replaceFile(profilePath, JSON.stringify({ ...profile, oauthAccount }, null, 2));
      replaceFile(authPath, JSON.stringify(auth.raw, null, 2));
    } catch (error) {
      if (previousProfile) replaceFile(profilePath, previousProfile);
      else if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
      if (previousAuth) replaceFile(authPath, previousAuth);
      else if (fs.existsSync(authPath)) fs.unlinkSync(authPath);
      throw error;
    }
    let message = 'Claude CLI account updated locally.';
    if (config.remoteHistory?.sshTarget) {
      try {
        await syncRemoteClaudeAuth(config.remoteHistory, systemHome);
        message = 'Claude CLI account updated locally and remotely.';
      } catch {
        message += ' Remote login sync failed. Check SSH access, Python 3, and permissions; verify the remote CLI login before retrying.';
      }
    }
    return result({ ...config, claudeAccounts: { accounts, activeAccountId: undefined } }, true,
      `${message} Restart running Claude Code sessions.`);
  } catch {
    return result(config, false, 'Could not switch the Claude CLI account. Check the CLI login before retrying.');
  }
}
