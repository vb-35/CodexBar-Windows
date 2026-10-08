export type CodexAccountSourceKind = 'managed' | 'system';

export interface CodexAccountSwitchOptions {
  stopVSCode: boolean;
  stopT3Code: boolean;
}

export interface CodexAccountIdentity {
  email?: string;
  accountId?: string;
  label: string;
  authFingerprint: string;
}

export interface CodexStoredAccount extends CodexAccountIdentity {
  id: string;
  source: CodexAccountSourceKind;
  managedHomePath?: string;
  managedAuthPath?: string;
  createdAt: string;
  updatedAt: string;
  lastAuthenticatedAt?: string;
}

export interface CodexAccountsConfig {
  accounts: CodexStoredAccount[];
  activeAccountId?: string;
  systemAccountId?: string;
}

export interface CodexAccountState {
  accounts: CodexStoredAccount[];
  activeAccountId?: string;
  systemAccountId?: string;
  systemAccount?: CodexAccountIdentity;
  missingSystemAuth: boolean;
}

export interface CodexAccountOperationResult {
  ok: boolean;
  message: string;
  state: CodexAccountState;
  account?: CodexStoredAccount;
  config?: unknown;
}
