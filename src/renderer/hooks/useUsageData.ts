import { useCallback, useEffect, useState } from 'react';
import { CodexAccountOperationResult, CodexAccountState, CodexAccountSwitchOptions } from '../../shared/codex-accounts';
import { ClockState, ClockTarget } from '../../shared/account-clocks';
import type { AccountUsageMap, PopoverProviderMetadata, PopoverProviderData as ProviderUsageData } from '../../shared/popover-model';
export type { PopoverProviderData as ProviderUsageData } from '../../shared/popover-model';

export interface AppConfig {
  enabledProviders: Record<string, boolean>;
  refreshIntervalMs: number;
  launchAtStartup: boolean;
  codexAccountSwitch: CodexAccountSwitchOptions;
  remoteHistory: {
    sshTarget: string;
    codexHome: string;
    claudeHome: string;
  };
  providerMetadata?: PopoverProviderMetadata[];
  codexAccountState: CodexAccountState;
  claudeAccountState: CodexAccountState;
}

export interface ElectronAPI {
  startClocks: (target?: ClockTarget) => Promise<ClockState>;
  getClockState: () => Promise<ClockState>;
  onClockStateChanged: (callback: (state: ClockState) => void) => (() => void);
  onUsageUpdate: (callback: (data: Record<string, ProviderUsageData>) => void) => (() => void);
  getAccountUsage: () => Promise<AccountUsageMap>;
  onAccountUsageUpdate: (callback: (summaries: AccountUsageMap) => void) => (() => void);
  onRefreshStarted: (callback: () => void) => (() => void);
  onRefreshCompleted: (callback: () => void) => (() => void);
  requestRefresh: () => void;
  getConfig: () => Promise<AppConfig>;
  onConfigChanged: (callback: (config: AppConfig) => void) => (() => void);
  setConfig: (config: Partial<AppConfig>) => Promise<void>;
  getCodexAccounts: () => Promise<CodexAccountState>;
  addCodexAccount: () => Promise<CodexAccountOperationResult>;
  importCodexAccount: () => Promise<CodexAccountOperationResult>;
  setActiveCodexAccount: (accountId?: string) => Promise<CodexAccountOperationResult>;
  promoteCodexAccountToSystem: (accountId: string) => Promise<CodexAccountOperationResult>;
  reauthenticateCodexAccount: (accountId: string) => Promise<CodexAccountOperationResult>;
  removeCodexAccount: (accountId: string) => Promise<CodexAccountOperationResult>;
  getClaudeAccounts: () => Promise<CodexAccountState>;
  addClaudeAccount: () => Promise<CodexAccountOperationResult>;
  importClaudeAccount: () => Promise<CodexAccountOperationResult>;
  setActiveClaudeAccount: (accountId?: string) => Promise<CodexAccountOperationResult>;
  promoteClaudeAccountToSystem: (accountId: string) => Promise<CodexAccountOperationResult>;
  reauthenticateClaudeAccount: (accountId: string) => Promise<CodexAccountOperationResult>;
  removeClaudeAccount: (accountId: string) => Promise<CodexAccountOperationResult>;
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

export function useAccountUsage(): AccountUsageMap {
  const [summaries, setSummaries] = useState<AccountUsageMap>({});

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    let awaitingInitial = true;
    const unsubscribe = api.onAccountUsageUpdate((next) => {
      awaitingInitial = false;
      setSummaries(next);
    });
    // A push that arrives first is newer than the initial snapshot.
    void api.getAccountUsage().then((initial) => { if (awaitingInitial) setSummaries(initial); });
    return unsubscribe;
  }, []);

  return summaries;
}
