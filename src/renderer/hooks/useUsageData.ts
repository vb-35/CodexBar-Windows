import { useCallback, useEffect, useState } from 'react';
import { CodexAccountOperationResult, CodexAccountState } from '../../shared/codex-accounts';
import { PopoverProviderMetadata } from '../../shared/popover-model';

export interface UsageWindow {
  usedPercent: number;
  resetAt: number;
  limitWindowSeconds: number;
  label: string;
}

export interface UsageHistoryPeriod {
  tokensUsed: number;
  requestsCount: number;
  estimatedCostUSD: number;
}

export interface ProviderUsageHistory {
  local?: {
    today: UsageHistoryPeriod;
    yesterday: UsageHistoryPeriod;
    week: UsageHistoryPeriod;
    month30: UsageHistoryPeriod;
  };
  remote?: {
    today: UsageHistoryPeriod;
    yesterday: UsageHistoryPeriod;
    week: UsageHistoryPeriod;
    month30: UsageHistoryPeriod;
  };
}

export interface ResetCredit {
  status: string;
  grantedAt: string;
  expiresAt: string;
  expiresAtTimestamp?: number;
}

export interface ResetCreditsInfo {
  availableCount: number;
  credits: ResetCredit[];
}

export interface ProviderUsageData {
  providerId: string;
  displayName: string;
  iconColor: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  credits?: { remaining: number; unlimited: boolean };
  resetCredits?: ResetCreditsInfo;
  planType?: string;
  error?: string;
  updatedAt?: number;
  sourceLabel?: string;
  identity?: string;
  history?: ProviderUsageHistory;
}

export interface AppConfig {
  enabledProviders: Record<string, boolean>;
  refreshIntervalMs: number;
  launchAtStartup: boolean;
  remoteHistory: {
    sshTarget: string;
    codexHome: string;
  };
  providerMetadata?: PopoverProviderMetadata[];
  codexAccountState: CodexAccountState;
}

export interface ElectronAPI {
  onUsageUpdate: (callback: (data: Record<string, ProviderUsageData>) => void) => (() => void);
  onRefreshStarted: (callback: () => void) => (() => void);
  onRefreshCompleted: (callback: () => void) => (() => void);
  requestRefresh: () => void;
  getConfig: () => Promise<AppConfig>;
  setConfig: (config: Partial<AppConfig>) => Promise<void>;
  getCodexAccounts: () => Promise<CodexAccountState>;
  addCodexAccount: () => Promise<CodexAccountOperationResult>;
  importCodexAccount: () => Promise<CodexAccountOperationResult>;
  setActiveCodexAccount: (accountId?: string) => Promise<CodexAccountOperationResult>;
  promoteCodexAccountToSystem: (accountId: string) => Promise<CodexAccountOperationResult>;
  reauthenticateCodexAccount: (accountId: string) => Promise<CodexAccountOperationResult>;
  removeCodexAccount: (accountId: string) => Promise<CodexAccountOperationResult>;
  openExternal: (url: string) => void;
  quitApp?: () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export function useUsageData() {
  const [usageData, setUsageData] = useState<Record<string, ProviderUsageData>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const unsubUsage = api.onUsageUpdate((data) => {
      setUsageData(data);
    });

    const unsubStarted = api.onRefreshStarted(() => {
      setIsRefreshing(true);
    });

    const unsubCompleted = api.onRefreshCompleted(() => {
      setIsRefreshing(false);
    });

    return () => {
      unsubUsage();
      unsubStarted();
      unsubCompleted();
    };
  }, []);

  const requestRefresh = useCallback(() => {
    window.electronAPI?.requestRefresh();
  }, []);

  return { usageData, isRefreshing, requestRefresh };
}
