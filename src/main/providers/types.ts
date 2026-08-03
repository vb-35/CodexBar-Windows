/**
 * Core type definitions for CodexBar providers.
 * Ported from Swift CodexBarCore/Providers/Providers.swift
 */

/** Supported usage provider */
export type UsageProviderId = 'codex';

/** A single rate-limit window snapshot */
export interface UsageWindow {
  /** Percentage of the limit used (0–100) */
  usedPercent: number;
  /** Unix timestamp (seconds) when this window resets */
  resetAt: number;
  /** Duration of the limit window in seconds */
  limitWindowSeconds: number;
  /** Human label: "Session", "Weekly", etc. */
  label: string;
}

/** Credits/balance snapshot */
export interface CreditsSnapshot {
  remaining: number;
  unlimited: boolean;
  updatedAt: number;
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
  expiresAtTimestamp?: number; // unix timestamp in seconds
}

export interface ResetCreditsInfo {
  availableCount: number;
  credits: ResetCredit[];
}

/** Full usage snapshot for a single provider */
export interface UsageSnapshot {
  primary?: UsageWindow;
  secondary?: UsageWindow;
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
}

/** Data sent to the renderer for display */
export interface ProviderDisplayData {
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

/** Provider fetch interface — all providers implement this */
export interface ProviderFetcher {
  readonly id: UsageProviderId;
  readonly metadata: ProviderMetadata;
  fetch(config: ProviderConfig, appConfig?: CodexBarConfig): Promise<ProviderFetchResult>;
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
