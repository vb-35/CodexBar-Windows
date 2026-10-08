/**
 * Core type definitions for CodexBar providers.
 * Ported from Swift CodexBarCore/Providers/Providers.swift
 */

/** Supported usage provider */
export type UsageProviderId = 'codex' | 'claude';

import type {
  PopoverUsageWindow as UsageWindow,
  PopoverUsageHistory as ProviderUsageHistory,
  PopoverResetCreditsInfo as ResetCreditsInfo,
} from '../../shared/popover-model';

export type {
  PopoverUsageWindow as UsageWindow,
  PopoverUsageHistoryPeriod as UsageHistoryPeriod,
  PopoverUsageHistory as ProviderUsageHistory,
  PopoverResetCredit as ResetCredit,
  PopoverResetCreditsInfo as ResetCreditsInfo,
  PopoverProviderData as ProviderDisplayData,
} from '../../shared/popover-model';

/** Credits/balance snapshot */
export interface CreditsSnapshot {
  remaining: number;
  unlimited: boolean;
  updatedAt: number;
}

/** Full usage snapshot for a single provider */
export interface UsageSnapshot {
  primary?: UsageWindow;
  secondary?: UsageWindow;
  additionalWindows?: UsageWindow[];
  credits?: CreditsSnapshot;
  resetCredits?: ResetCreditsInfo;
  planType?: string;
  identity?: string;
  updatedAt: number;
  sourceLabel: string;
  history?: ProviderUsageHistory;
}

/** Result from a provider fetch: either usage data or an error */
export interface ProviderFetchResult {
  providerId: UsageProviderId;
  usage?: UsageSnapshot;
  error?: string;
  fetchedAt: number;
}

/** Provider metadata for display */
export interface ProviderMetadata {
  id: UsageProviderId;
  displayName: string;
  sessionLabel: string;
  weeklyLabel: string;
  defaultEnabled: boolean;
  dashboardURL?: string;
  statusPageURL?: string;
  iconColor: string;
}

/** Provider config from config.json */
export interface ProviderConfig {
  id: UsageProviderId;
  enabled?: boolean;
  source?: 'auto' | 'oauth' | 'cli';
}

export interface RemoteHistoryConfig {
  sshTarget: string;
  codexHome?: string;
}

/** Full application config */
export interface CodexBarConfig {
  version: number;
  providers: ProviderConfig[];
  refreshCadenceSeconds?: number;
  launchAtStartup?: boolean;
  remoteHistory?: RemoteHistoryConfig;
  codexAccounts?: import('../../shared/codex-accounts').CodexAccountsConfig;
  claudeAccounts?: import('../../shared/codex-accounts').CodexAccountsConfig;
}

/** Provider fetch interface — all providers implement this */
export interface ProviderFetcher {
  readonly id: UsageProviderId;
  readonly metadata: ProviderMetadata;
  fetch(config: ProviderConfig, appConfig?: CodexBarConfig, onUsage?: (usage: UsageSnapshot) => void): Promise<ProviderFetchResult>;
}

/** Codex-specific OAuth credentials (from ~/.codex/auth.json) */
export interface CodexOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId?: string;
  lastRefresh?: string; // ISO8601
}

/** Codex usage API response shape */
export interface CodexUsageResponse {
  plan_type?: string;
  rate_limit?: {
    primary_window?: {
      used_percent: number;
      reset_at: number;
      limit_window_seconds: number;
    };
    secondary_window?: {
      used_percent: number;
      reset_at: number;
      limit_window_seconds: number;
    };
  };
  credits?: {
    has_credits: boolean;
    unlimited: boolean;
    balance?: number;
  };
}

/** Codex token refresh response */
export interface CodexTokenRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  error?: string | { code: string };
}
