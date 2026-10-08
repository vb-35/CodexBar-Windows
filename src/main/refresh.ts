/**
 * Refresh loop manager — periodically fetches usage from all enabled providers.
 */

import { CodexBarConfig, ProviderDisplayData, UsageProviderId } from './providers/types';
import { getProvider, getProviderMetadata } from './providers/registry';
import { getEnabledProviders, getProviderConfig } from './config';
import { getCodexAccountState } from './codex-accounts';
import { getDefaultCodexHome } from './providers/codex/auth';
import { getClaudeAccountState, getDefaultClaudeHome } from './claude-accounts';

export type RefreshCallback = (data: Record<string, ProviderDisplayData>) => void;
export type RefreshEventCallback = () => void;

export class RefreshManager {
  private timer: NodeJS.Timeout | null = null;
  private config: CodexBarConfig;
  private latestData: Record<string, ProviderDisplayData> = {};
  private onUpdate: RefreshCallback;
  private onRefreshStarted: RefreshEventCallback;
  private onRefreshCompleted: RefreshEventCallback;
  private cache = new Map<string, { data: Record<string, ProviderDisplayData>; refreshedAt: number }>();
  private inFlight = new Map<string, Promise<void>>();
  private cacheKey: string;

  constructor(
    config: CodexBarConfig,
    onUpdate: RefreshCallback,
    onRefreshStarted: RefreshEventCallback,
    onRefreshCompleted: RefreshEventCallback,
  ) {
    this.config = structuredClone(config);
    this.cacheKey = this.getCacheKey();
    this.onUpdate = onUpdate;
    this.onRefreshStarted = onRefreshStarted;
    this.onRefreshCompleted = onRefreshCompleted;
  }

  /** Update the config (e.g., when user changes settings) */
  updateConfig(config: CodexBarConfig): void {
    this.config = structuredClone(config);
    this.cacheKey = this.getCacheKey();
    this.latestData = this.cache.get(this.cacheKey)?.data || {};
    this.onUpdate({ ...this.latestData });
    if (this.inFlight.has(this.cacheKey)) this.onRefreshStarted();
    else this.onRefreshCompleted();
    this.restartTimer();
  }

  /** Start the periodic refresh loop */
  start(): void {
    // Do an initial refresh immediately
    this.refresh();
    this.restartTimer();
  }

  /** Stop the refresh loop */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Clock activation changes usage for accounts outside the current tab. */
  invalidateCache(): void {
    for (const snapshot of this.cache.values()) snapshot.refreshedAt = 0;
  }

  /** Trigger an immediate refresh */
  async refresh(force = true): Promise<void> {
    const key = this.cacheKey;
    const config = this.config;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const cached = this.cache.get(key);
    if (!force && cached && Date.now() - cached.refreshedAt < (config.refreshCadenceSeconds || 120) * 1000) return;
    this.onRefreshStarted();

    const job = this.fetchAll(config, key);
    this.inFlight.set(key, job);
    try {
      await job;
    } finally {
      this.inFlight.delete(key);
      if (key === this.cacheKey) this.onRefreshCompleted();
    }
  }

  private async fetchAll(config: CodexBarConfig, key: string): Promise<void> {
    const data: Record<string, ProviderDisplayData> = {};
    const publish = () => {
      if (key === this.cacheKey) {
        this.latestData = { ...data };
        this.onUpdate({ ...data });
      }
    };
    try {
      const enabledIds = getEnabledProviders(config);
      const results = await Promise.allSettled(
        enabledIds.map((id) => this.fetchProvider(id, config, (partial) => {
          data[id] = { ...partial, history: this.cache.get(key)?.data[id]?.history };
          this.cache.set(key, { data: { ...data }, refreshedAt: 0 });
          publish();
        })),
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          data[result.value.providerId] = result.value;
        }
      }

      this.cache.set(key, { data, refreshedAt: Date.now() });
      // Keep only enough snapshots for the configured accounts plus system auth.
      while (this.cache.size > ((this.config.codexAccounts?.accounts.length || 0) + 1) * ((this.config.claudeAccounts?.accounts.length || 0) + 1)) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      publish();
    } catch (err) {
      console.error('Refresh error:', err);
    }
  }

  /** Get the latest cached data */
  getLatestData(): Record<string, ProviderDisplayData> {
    return { ...this.latestData };
  }

  private async fetchProvider(
    id: UsageProviderId,
    config: CodexBarConfig,
    onUsage: (data: ProviderDisplayData) => void,
  ): Promise<ProviderDisplayData | null> {
    const fetcher = getProvider(id);
    const meta = getProviderMetadata(id);
    if (!fetcher || !meta) return null;

    const providerConfig = getProviderConfig(config, id) || { id };
    const metadata = { providerId: id, displayName: meta.displayName, iconColor: meta.iconColor };

    try {
      const result = await fetcher.fetch(providerConfig, config, (usage) => onUsage({ ...metadata, ...usage }));
      return { ...metadata, ...result.usage, error: result.error };
    } catch (err) {
      return {
        providerId: id,
        displayName: meta.displayName,
        iconColor: meta.iconColor,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private getCacheKey(): string {
    const state = getCodexAccountState(this.config);
    const account = state.accounts.find((item) => item.id === state.activeAccountId);
    const claudeState = getClaudeAccountState(this.config);
    const claudeAccount = claudeState.accounts.find((item) => item.id === claudeState.activeAccountId);
    return JSON.stringify([
      account?.managedHomePath || getDefaultCodexHome(),
      account?.authFingerprint || state.systemAccount?.authFingerprint,
      claudeAccount?.managedHomePath || getDefaultClaudeHome(),
      claudeAccount?.authFingerprint || claudeState.systemAccount?.authFingerprint,
      this.config.providers,
      this.config.remoteHistory,
    ]);
  }

  private restartTimer(): void {
    this.stop();
    const intervalMs = (this.config.refreshCadenceSeconds || 120) * 1000;
    if (intervalMs > 0) {
      this.timer = setInterval(() => this.refresh(), intervalMs);
    }
  }
}
