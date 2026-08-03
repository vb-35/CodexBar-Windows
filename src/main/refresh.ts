/**
 * Refresh loop manager — periodically fetches usage from all enabled providers.
 */

import { CodexBarConfig, ProviderDisplayData, UsageProviderId } from './providers/types';
import { getProvider, getProviderMetadata } from './providers/registry';
import { getEnabledProviders, getProviderConfig } from './config';

export type RefreshCallback = (data: Record<string, ProviderDisplayData>) => void;
export type RefreshEventCallback = () => void;

export class RefreshManager {
  private timer: NodeJS.Timeout | null = null;
  private config: CodexBarConfig;
  private latestData: Record<string, ProviderDisplayData> = {};
  private onUpdate: RefreshCallback;
  private onRefreshStarted: RefreshEventCallback;
  private onRefreshCompleted: RefreshEventCallback;
  private isRefreshing = false;

  constructor(
    config: CodexBarConfig,
    onUpdate: RefreshCallback,
    onRefreshStarted: RefreshEventCallback,
    onRefreshCompleted: RefreshEventCallback,
  ) {
    this.config = config;
    this.onUpdate = onUpdate;
    this.onRefreshStarted = onRefreshStarted;
    this.onRefreshCompleted = onRefreshCompleted;
  }

  /** Update the config (e.g., when user changes settings) */
  updateConfig(config: CodexBarConfig): void {
    this.config = config;
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

  /** Trigger an immediate refresh */
  async refresh(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    this.onRefreshStarted();

    try {
      const enabledIds = getEnabledProviders(this.config);
      const results = await Promise.allSettled(
        enabledIds.map((id) => this.fetchProvider(id)),
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          this.latestData[result.value.providerId] = result.value;
        }
      }

      // Remove providers that are no longer enabled
      const enabledSet = new Set(enabledIds as string[]);
      for (const key of Object.keys(this.latestData)) {
        if (!enabledSet.has(key)) {
          delete this.latestData[key];
        }
      }

      this.onUpdate({ ...this.latestData });
    } catch (err) {
      console.error('Refresh error:', err);
    } finally {
      this.isRefreshing = false;
      this.onRefreshCompleted();
    }
  }

  /** Get the latest cached data */
  getLatestData(): Record<string, ProviderDisplayData> {
    return { ...this.latestData };
  }

  private async fetchProvider(id: UsageProviderId): Promise<ProviderDisplayData | null> {
    const fetcher = getProvider(id);
    const meta = getProviderMetadata(id);
    if (!fetcher || !meta) return null;

    const providerConfig = getProviderConfig(this.config, id) || { id };

    try {
      const result = await fetcher.fetch(providerConfig, this.config);

      const display: ProviderDisplayData = {
        providerId: id,
        displayName: meta.displayName,
        iconColor: meta.iconColor,
      };

      if (result.error) {
        display.error = result.error;
      }

      if (result.usage) {
        display.primary = result.usage.primary;
        display.secondary = result.usage.secondary;
        display.planType = result.usage.planType;
        display.updatedAt = result.usage.updatedAt;
        display.sourceLabel = result.usage.sourceLabel;
        display.identity = result.usage.identity;
        display.history = result.usage.history;
        display.resetCredits = result.usage.resetCredits;

        if (result.usage.credits) {
          display.credits = {
            remaining: result.usage.credits.remaining,
            unlimited: result.usage.credits.unlimited,
          };
        }
      }

      return display;
    } catch (err) {
      return {
        providerId: id,
        displayName: meta.displayName,
        iconColor: meta.iconColor,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private restartTimer(): void {
    this.stop();
    const intervalMs = (this.config.refreshCadenceSeconds || 120) * 1000;
    if (intervalMs > 0) {
      this.timer = setInterval(() => this.refresh(), intervalMs);
    }
  }
}
