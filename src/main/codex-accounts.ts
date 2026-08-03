import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  CodexAccountIdentity,
  CodexAccountOperationResult,
  CodexAccountState,
  CodexAccountsConfig,
  CodexStoredAccount,
} from '../shared/codex-accounts';
import { CodexBarConfig } from './providers/types';
import {
  deriveIdentityLabel,
  getAuthFilePath,
  getDefaultCodexHome,
  loadAuthFile,
  normalizeAccountId,
  normalizeEmail,
  writeAuthJson,
} from './providers/codex/auth';
import { resolveCodexBinary } from './providers/codex/cli';

interface ResolvedCodexAccountTarget {
  kind: 'system' | 'managed';
  homePath: string;
  authPath: string;
  accountId?: string;
}

const LOGIN_POLL_MS = 1500;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function getCodexAccountsConfig(config: CodexBarConfig): CodexAccountsConfig {
  return {
    accounts: [...(config.codexAccounts?.accounts || [])],
    activeAccountId: config.codexAccounts?.activeAccountId,
    systemAccountId: config.codexAccounts?.systemAccountId,
  };
}

export function getCodexAccountState(config: CodexBarConfig): CodexAccountState {
  const nextConfig = reconcileCodexAccountsConfig(config);
  const accountsConfig = nextConfig.codexAccounts || emptyAccountsConfig();
  const systemAccount = readSystemAccountIdentity();

  return {
    accounts: accountsConfig.accounts,
    activeAccountId: accountsConfig.activeAccountId,
    systemAccountId: accountsConfig.systemAccountId,
    systemAccount,
    missingSystemAuth: !systemAccount,
  };
}

export function reconcileCodexAccountsConfig(config: CodexBarConfig): CodexBarConfig {
  const current = getCodexAccountsConfig(config);
  const refreshedAccounts = current.accounts
    .filter((account) => isRetainableAccount(account))
    .map((account) => refreshStoredAccount(account));
  const accounts = dedupeAccounts(refreshedAccounts, current.activeAccountId);

  const systemIdentity = readSystemAccountIdentity();
  const systemAccountId = systemIdentity
    ? accounts.find((account) => sameIdentity(account, systemIdentity))?.id
    : undefined;
  const activeAccountId = current.activeAccountId
    && current.activeAccountId !== systemAccountId
    && accounts.some((account) => account.id === current.activeAccountId)
    ? current.activeAccountId
    : undefined;

  return {
    ...config,
    codexAccounts: {
      accounts,
      activeAccountId,
      systemAccountId,
    },
  };
}

function dedupeAccounts(accounts: CodexStoredAccount[], preferredId?: string): CodexStoredAccount[] {
  const deduped: CodexStoredAccount[] = [];
  for (const account of accounts) {
    const duplicateIndex = deduped.findIndex((candidate) => sameEmail(candidate, account));
    if (duplicateIndex < 0) {
      deduped.push(account);
    } else if (account.id === preferredId) {
      deduped[duplicateIndex] = account;
    }
  }
  return deduped;
}

export function resolveActiveCodexTarget(config: CodexBarConfig): ResolvedCodexAccountTarget {
  const reconciled = reconcileCodexAccountsConfig(config);
  const accountsConfig = reconciled.codexAccounts || emptyAccountsConfig();
  const activeAccount = accountsConfig.activeAccountId
    ? accountsConfig.accounts.find((account) => account.id === accountsConfig.activeAccountId)
    : undefined;

  if (activeAccount?.managedHomePath) {
    return {
      kind: 'managed',
      homePath: activeAccount.managedHomePath,
      authPath: getAuthFilePath(activeAccount.managedHomePath),
      accountId: activeAccount.id,
    };
  }

  const systemHome = getDefaultCodexHome();
  return {
    kind: 'system',
    homePath: systemHome,
    authPath: getAuthFilePath(systemHome),
  };
}

export async function addCodexAccountViaLogin(config: CodexBarConfig): Promise<CodexAccountOperationResult> {
  const binary = resolveCodexBinary();
  if (!binary) {
    return fail(config, 'Codex CLI not found. Install Codex before adding another account.');
  }

  const managedHomePath = path.join(getManagedAccountsRoot(), createAccountId());
  fs.mkdirSync(managedHomePath, { recursive: true });

  const child = launchCodexLogin(binary, managedHomePath);

  const auth = await waitForAuthFile(managedHomePath, child);
  if (!auth) {
    return fail(config, 'Codex login did not produce a valid auth.json.');
  }

  const updated = upsertManagedAccount(config, auth, managedHomePath, 'managed', true);
  return success(updated.config, updated.message, updated.account);
}

export function importCodexAccount(config: CodexBarConfig, importPath: string): CodexAccountOperationResult {
  const importedAuth = loadAuthFile(importPath);
  if (!importedAuth) {
    return fail(config, 'Selected auth.json is unreadable or invalid.');
  }

  const managedHomePath = path.join(getManagedAccountsRoot(), createAccountId());
  fs.mkdirSync(managedHomePath, { recursive: true });
  writeAuthJson(getAuthFilePath(managedHomePath), importedAuth.raw);

  const copiedAuth = loadAuthFile(getAuthFilePath(managedHomePath));
  if (!copiedAuth) {
    return fail(config, 'Imported auth.json could not be stored.');
  }

  const updated = upsertManagedAccount(config, copiedAuth, managedHomePath, 'managed', true);
  return success(updated.config, updated.message, updated.account);
}

export function setActiveCodexAccount(config: CodexBarConfig, accountId?: string): CodexAccountOperationResult {
  const reconciled = reconcileCodexAccountsConfig(config);
  if (accountId && !(reconciled.codexAccounts?.accounts || []).some((account) => account.id === accountId)) {
    return fail(reconciled, 'Selected Codex account was not found.');
  }

  const updated: CodexBarConfig = {
    ...reconciled,
    codexAccounts: {
      ...(reconciled.codexAccounts || emptyAccountsConfig()),
      activeAccountId: accountId,
    },
  };
  return success(updated, accountId ? 'Active Codex account updated.' : 'CodexBar now uses the ambient system account.');
}

export function promoteCodexAccountToSystem(config: CodexBarConfig, accountId: string): CodexAccountOperationResult {
  const reconciled = reconcileCodexAccountsConfig(config);
  const accounts = reconciled.codexAccounts?.accounts || [];
  const target = accounts.find((account) => account.id === accountId);
  if (!target?.managedHomePath) {
    return fail(reconciled, 'Only managed Codex accounts can be promoted to the system account.');
  }

  const targetAuth = loadAuthFile(getAuthFilePath(target.managedHomePath));
  if (!targetAuth) {
    return fail(reconciled, 'Managed Codex auth is unreadable. Re-authenticate it before promotion.');
  }

  const systemHome = getDefaultCodexHome();
  const systemAuthPath = getAuthFilePath(systemHome);
  const previousSystemAuth = loadAuthFile(systemAuthPath);

  fs.mkdirSync(systemHome, { recursive: true });
  const tempAuthPath = path.join(systemHome, `auth.${Date.now()}.tmp`);
  try {
    writeAuthJson(tempAuthPath, targetAuth.raw);
    fs.renameSync(tempAuthPath, systemAuthPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempAuthPath)) fs.unlinkSync(tempAuthPath);
    } catch {
      // ignore cleanup failures
    }
    return fail(reconciled, `Failed to replace ambient Codex auth: ${formatError(error)}`);
  }

  let updatedConfig = reconciled;
  if (previousSystemAuth && !sameIdentity(previousSystemAuth, targetAuth)) {
    const preservedHomePath = path.join(getManagedAccountsRoot(), createAccountId());
    fs.mkdirSync(preservedHomePath, { recursive: true });
    writeAuthJson(getAuthFilePath(preservedHomePath), previousSystemAuth.raw);
    const preservedAuth = loadAuthFile(getAuthFilePath(preservedHomePath));
    if (preservedAuth) {
      updatedConfig = upsertManagedAccount(updatedConfig, preservedAuth, preservedHomePath, 'managed', false).config;
    }
  }

  updatedConfig = reconcileCodexAccountsConfig({
    ...updatedConfig,
    codexAccounts: {
      ...(updatedConfig.codexAccounts || emptyAccountsConfig()),
      activeAccountId: target.id,
    },
  });

  return success(updatedConfig, 'Codex system account updated.', target);
}

export async function reauthenticateCodexAccount(config: CodexBarConfig, accountId: string): Promise<CodexAccountOperationResult> {
  const reconciled = reconcileCodexAccountsConfig(config);
  const target = reconciled.codexAccounts?.accounts.find((account) => account.id === accountId);
  if (!target?.managedHomePath) {
    return fail(reconciled, 'Only managed Codex accounts can be re-authenticated.');
  }

  const binary = resolveCodexBinary();
  if (!binary) {
    return fail(reconciled, 'Codex CLI not found. Install Codex before re-authenticating.');
  }

  const child = launchCodexLogin(binary, target.managedHomePath);

  const auth = await waitForAuthFile(target.managedHomePath, child);
  if (!auth) {
    return fail(reconciled, 'Codex re-authentication did not produce a valid auth.json.');
  }

  const updated = upsertManagedAccount(reconciled, auth, target.managedHomePath, 'managed', false, target.id);
  return success(updated.config, 'Codex account re-authenticated.', updated.account);
}

export function removeCodexAccount(config: CodexBarConfig, accountId: string): CodexAccountOperationResult {
  const reconciled = reconcileCodexAccountsConfig(config);
  const accounts = reconciled.codexAccounts?.accounts || [];
  const target = accounts.find((account) => account.id === accountId);
  if (!target) {
    return fail(reconciled, 'Codex account not found.');
  }
  if (target.source !== 'managed') {
    return fail(reconciled, 'System account records cannot be removed.');
  }

  const filtered = accounts.filter((account) => account.id !== accountId);
  const updated: CodexBarConfig = {
    ...reconciled,
    codexAccounts: {
      accounts: filtered,
      activeAccountId: reconciled.codexAccounts?.activeAccountId === accountId ? undefined : reconciled.codexAccounts?.activeAccountId,
      systemAccountId: reconciled.codexAccounts?.systemAccountId === accountId ? undefined : reconciled.codexAccounts?.systemAccountId,
    },
  };

  if (target.managedHomePath && fs.existsSync(target.managedHomePath)) {
    try {
      fs.rmSync(target.managedHomePath, { recursive: true, force: true });
    } catch {
      // leave config updated even if cleanup fails
    }
  }

  return success(updated, 'Codex account removed.');
}

function upsertManagedAccount(
  config: CodexBarConfig,
  auth: ReturnType<typeof loadAuthFile> extends infer T ? T : never,
  managedHomePath?: string,
  source: 'managed' | 'system' = 'managed',
  selectActive: boolean = false,
  preferredId?: string,
): { config: CodexBarConfig; account: CodexStoredAccount; message: string } {
  if (!auth) {
    throw new Error('Auth is required.');
  }

  const reconciled = reconcileCodexAccountsConfig(config);
  const accounts = [...(reconciled.codexAccounts?.accounts || [])];
  const now = new Date().toISOString();
  const existing = accounts.find((account) =>
    account.id === preferredId ||
    account.authFingerprint === auth.authFingerprint ||
    sameIdentity(account, auth)
  );

  const account: CodexStoredAccount = {
    id: existing?.id || preferredId || createAccountId(),
    source,
    email: normalizeEmail(auth.email),
    accountId: normalizeAccountId(auth.accountId),
    label: deriveIdentityLabel(normalizeEmail(auth.email), normalizeAccountId(auth.accountId)),
    authFingerprint: auth.authFingerprint,
    managedHomePath: managedHomePath || existing?.managedHomePath,
    managedAuthPath: managedHomePath ? getAuthFilePath(managedHomePath) : existing?.managedAuthPath,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastAuthenticatedAt: now,
  };

  const nextAccounts = existing
    ? accounts.map((item) => item.id === existing.id ? account : item)
    : [...accounts, account];

  const nextConfig: CodexBarConfig = reconcileCodexAccountsConfig({
    ...reconciled,
    codexAccounts: {
      accounts: nextAccounts,
      activeAccountId: selectActive ? account.id : reconciled.codexAccounts?.activeAccountId,
      systemAccountId: reconciled.codexAccounts?.systemAccountId,
    },
  });

  return {
    config: nextConfig,
    account,
    message: existing ? 'Existing Codex account updated.' : 'Codex account added.',
  };
}

function emptyAccountsConfig(): CodexAccountsConfig {
  return {
    accounts: [],
  };
}

function readSystemAccountIdentity(): CodexAccountIdentity | undefined {
  const auth = loadAuthFile(getAuthFilePath(getDefaultCodexHome()));
  if (!auth) return undefined;
  return {
    email: auth.email,
    accountId: auth.accountId,
    label: deriveIdentityLabel(auth.email, auth.accountId),
    authFingerprint: auth.authFingerprint,
  };
}

function refreshStoredAccount(account: CodexStoredAccount): CodexStoredAccount {
  if (!account.managedHomePath) return account;
  const auth = loadAuthFile(getAuthFilePath(account.managedHomePath));
  if (!auth) return account;

  return {
    ...account,
    email: normalizeEmail(auth.email),
    accountId: normalizeAccountId(auth.accountId),
    label: deriveIdentityLabel(auth.email, auth.accountId),
    authFingerprint: auth.authFingerprint,
    managedAuthPath: getAuthFilePath(account.managedHomePath),
    updatedAt: new Date().toISOString(),
  };
}

function isRetainableAccount(account: CodexStoredAccount): boolean {
  if (account.source !== 'managed') return true;
  if (!account.managedHomePath) return false;
  return fs.existsSync(getAuthFilePath(account.managedHomePath));
}

function sameIdentity(
  left: Pick<CodexStoredAccount, 'email' | 'accountId' | 'authFingerprint'> | CodexAccountIdentity,
  right: Pick<CodexStoredAccount, 'email' | 'accountId' | 'authFingerprint'> | CodexAccountIdentity,
): boolean {
  const leftEmail = normalizeEmail(left.email);
  const rightEmail = normalizeEmail(right.email);
  if (leftEmail || rightEmail) return leftEmail === rightEmail;
  if (left.authFingerprint && right.authFingerprint && left.authFingerprint === right.authFingerprint) {
    return true;
  }
  return false;
}

function sameEmail(left: Pick<CodexAccountIdentity, 'email'>, right: Pick<CodexAccountIdentity, 'email'>): boolean {
  const email = normalizeEmail(left.email);
  return !!email && email === normalizeEmail(right.email);
}

function getManagedAccountsRoot(): string {
  const userProfile = process.env['USERPROFILE'] || process.env['HOME'] || '';
  return path.join(userProfile, '.codexbar', 'codex-accounts');
}

function createAccountId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function success(config: CodexBarConfig, message: string, account?: CodexStoredAccount): CodexAccountOperationResult {
  const reconciled = reconcileCodexAccountsConfig(config);
  return {
    ok: true,
    message,
    state: getCodexAccountState(reconciled),
    account,
    config: reconciled,
  };
}

function fail(config: CodexBarConfig, message: string): CodexAccountOperationResult {
  return {
    ok: false,
    message,
    state: getCodexAccountState(config),
    config,
  };
}

async function waitForAuthFile(homePath: string, child: ReturnType<typeof spawn>): Promise<ReturnType<typeof loadAuthFile>> {
  const authPath = getAuthFilePath(homePath);
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const auth = loadAuthFile(authPath);
    if (auth) return auth;
    if (child.exitCode !== null && child.exitCode !== 0) {
      break;
    }
    await delay(LOGIN_POLL_MS);
  }

  return loadAuthFile(authPath);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function launchCodexLogin(binary: string, codexHome: string) {
  const command = [
    'Start-Process',
    '-FilePath', `'cmd.exe'`,
    '-ArgumentList', `'/k ""${escapeForCmd(binary)}" login"'`,
    '-WorkingDirectory', `'${escapeForPowerShell(codexHome)}'`,
    '-Wait',
    '-WindowStyle', 'Normal',
  ].join(' ');

  return spawn('powershell.exe', ['-NoProfile', '-Command', command], {
    cwd: codexHome,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
    },
    windowsHide: false,
  });
}

function escapeForCmd(value: string): string {
  return value.replace(/"/g, '""');
}

function escapeForPowerShell(value: string): string {
  return value.replace(/'/g, "''");
}
