import { CodexAccountState, CodexStoredAccount } from './codex-accounts';

export interface PopoverUsageWindow {
  usedPercent: number;
  resetAt: number;
  limitWindowSeconds: number;
  label: string;
}

export interface PopoverUsageHistoryPeriod {
  tokensUsed: number;
  requestsCount: number;
  estimatedCostUSD: number;
}

export interface PopoverUsageHistory {
  local?: {
    today: PopoverUsageHistoryPeriod;
    yesterday: PopoverUsageHistoryPeriod;
    week: PopoverUsageHistoryPeriod;
    month30: PopoverUsageHistoryPeriod;
  };
  remote?: {
    today: PopoverUsageHistoryPeriod;
    yesterday: PopoverUsageHistoryPeriod;
    week: PopoverUsageHistoryPeriod;
    month30: PopoverUsageHistoryPeriod;
  };
}

export interface PopoverCredits {
  remaining: number;
  unlimited: boolean;
}

export interface PopoverResetCredit {
  status: string;
  grantedAt: string;
  expiresAt: string;
  expiresAtTimestamp?: number;
}

export interface PopoverResetCreditsInfo {
  availableCount: number;
  credits: PopoverResetCredit[];
}

export interface PopoverProviderData {
  providerId: string;
  displayName: string;
  iconColor: string;
  primary?: PopoverUsageWindow;
  secondary?: PopoverUsageWindow;
  additionalWindows?: PopoverUsageWindow[];
  credits?: PopoverCredits;
  resetCredits?: PopoverResetCreditsInfo;
  planType?: string;
  error?: string;
  updatedAt?: number;
  sourceLabel?: string;
  identity?: string;
  history?: PopoverUsageHistory;
}

export interface PopoverProviderMetadata {
  id: string;
  displayName: string;
  dashboardURL?: string;
  statusPageURL?: string;
}

export interface AccountTab {
  id: string;
  label: string;
  subtitle?: string;
  isSystem: boolean;
}

export interface ProviderSectionVisibility {
  hasAnyData: boolean;
  showPrimary: boolean;
  showSecondary: boolean;
  showResetCredits: boolean;
  showCredits: boolean;
  showHistory: boolean;
}

export function buildAccountTabs(accountState: CodexAccountState): AccountTab[] {
  const tabs: AccountTab[] = [];

  if (accountState.systemAccount || accountState.missingSystemAuth) {
    tabs.push({
      id: 'system',
      label: accountState.systemAccount?.label || 'System Account',
      subtitle: 'System',
      isSystem: true,
    });
  }

  for (const account of accountState.accounts) {
    if (account.id === accountState.systemAccountId) continue;
    tabs.push({
      id: account.id,
      label: getAccountLabel(account),
      subtitle: account.source === 'system' ? 'System' : 'Managed',
      isSystem: false,
    });
  }

  return tabs;
}

export function getDefaultAccountTabId(accountState: CodexAccountState): string {
  if (accountState.activeAccountId && accountState.activeAccountId !== accountState.systemAccountId) {
    return accountState.activeAccountId;
  }

  const tabs = buildAccountTabs(accountState);
  if (tabs.length === 0) {
    return 'system';
  }

  return tabs[0].id;
}

export function getProviderSectionVisibility(data?: PopoverProviderData): ProviderSectionVisibility {
  if (!data) {
    return {
      hasAnyData: false,
      showPrimary: false,
      showSecondary: false,
      showResetCredits: false,
      showCredits: false,
      showHistory: false,
    };
  }

  const showPrimary = Boolean(data.primary);
  const showSecondary = Boolean(data.secondary);
  const showResetCredits = Boolean(data.resetCredits && data.resetCredits.availableCount > 0);
  const showCredits = Boolean(data.credits);
  const showHistory = Boolean(data.history && (data.history.local || data.history.remote));

  return {
    hasAnyData: Boolean(data.error || showPrimary || showSecondary || data.additionalWindows?.length || showResetCredits || showCredits || showHistory),
    showPrimary,
    showSecondary,
    showResetCredits,
    showCredits,
    showHistory,
  };
}

export function getProviderMetadataMap(
  providerMetadata: PopoverProviderMetadata[] | undefined,
): Record<string, PopoverProviderMetadata> {
  const entries = providerMetadata || [];
  return Object.fromEntries(entries.map((item) => [item.id, item]));
}

function getAccountLabel(account: CodexStoredAccount): string {
  return account.email || account.label || account.accountId || 'Managed Account';
}
