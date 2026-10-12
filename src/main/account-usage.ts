/**
 * Polls session/weekly windows for every signed-in account so the account chips can show rings.
 * The selected account of each provider is fed from the main refresh instead of being polled twice.
 */

import { AccountUsageMap, AccountUsageSummary, buildAccountTabs, getDefaultAccountTabId, summarizeAccountUsage } from '../shared/popover-model';
import { getClaudeAccountState, getDefaultClaudeHome } from './claude-accounts';
import { getCodexAccountState } from './codex-accounts';
import { getEnabledProviders, getProviderConfig } from './config';
import { fetchClaudeUsage } from './providers/claude/index';
import { getDefaultCodexHome } from './providers/codex/auth';
import { fetchViaOAuth } from './providers/codex/oauth';
import { CodexBarConfig, ProviderDisplayData, ProviderFetchResult, UsageProviderId } from './providers/types';

export interface AccountUsageTarget {
  provider: UsageProviderId;
  tabId: string;
  home: string;
}

const MIN_BACKGROUND_INTERVAL_SECONDS = 300;

function getAccountState(config: CodexBarConfig, provider: UsageProviderId) {
  return provider === 'codex' ? getCodexAccountState(config) : getClaudeAccountState(config);
}

export function getActiveAccountTabIds(config: CodexBarConfig): Partial<Record<UsageProviderId, string>> {
  return Object.fromEntries(getEnabledProviders(config).map((provider) => [provider, getDefaultAccountTabId(getAccountState(config, provider))]));
}

/** Every account tab except the selected one, which the main refresh already covers. */
export function getAccountUsageTargets(config: CodexBarConfig): AccountUsageTarget[] {
  return getEnabledProviders(config).flatMap((provider) => {
    const state = getAccountState(config, provider);
    const activeId = getDefaultAccountTabId(state);
    return buildAccountTabs(state).flatMap((tab) => {
      if (tab.id === activeId) return [];
      const home = tab.id === 'system'
        ? state.systemAccount && (provider === 'codex' ? getDefaultCodexHome() : getDefaultClaudeHome())
        : state.accounts.find((account) => account.id === tab.id)?.managedHomePath;
      return home ? [{ provider, tabId: tab.id, home }] : [];
    });
  });
}

export async function fetchAccountUsage(config: CodexBarConfig, target: AccountUsageTarget): Promise<ProviderFetchResult> {
  if (target.provider === 'claude') return fetchClaudeUsage(target.home);
  return fetchViaOAuth(getProviderConfig(config, 'codex') || { id: 'codex' }, target.home);
}

function toSummary(data: Pick<ProviderDisplayData, 'primary' | 'secondary' | 'error'> | undefined): AccountUsageSummary {
  // A failed poll hides both rings rather than showing stale numbers.
  return !data || data.error ? {} : summarizeAccountUsage(data);
}

export class AccountUsagePoller {
  private config: CodexBarConfig;
  private summaries: AccountUsageMap = {};
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    config: CodexBarConfig,
    private readonly onUpdate: (summaries: AccountUsageMap) => void,
    private readonly fetcher: typeof fetchAccountUsage = fetchAccountUsage,
  ) {
    this.config = structuredClone(config);
  }

  start(): void {
    void this.refresh();
    this.restartTimer();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSummaries(): AccountUsageMap {
    return structuredClone(this.summaries);
  }

  updateConfig(config: CodexBarConfig): void {
    this.config = structuredClone(config);
    const enabled = new Set<string>(getEnabledProviders(this.config));
    const known = new Set(buildKnownKeys(this.config));
    for (const provider of Object.keys(this.summaries)) {
      if (!enabled.has(provider)) {
        delete this.summaries[provider];
        continue;
      }
      for (const tabId of Object.keys(this.summaries[provider])) {
        if (!known.has(`${provider}:${tabId}`)) delete this.summaries[provider][tabId];
      }
    }
    this.publish();
    this.restartTimer();
    if (getAccountUsageTargets(this.config).some((target) => !this.summaries[target.provider]?.[target.tabId])) void this.refresh();
  }

  /** Records the main refresh result for each provider's selected account. */
  recordActive(data: Record<string, ProviderDisplayData>): void {
    let changed = false;
    for (const [provider, tabId] of Object.entries(getActiveAccountTabIds(this.config))) {
      const entry = data[provider];
      if (!entry || !tabId || (!entry.error && !entry.primary && !entry.secondary)) continue;
      (this.summaries[provider] ||= {})[tabId] = toSummary(entry);
      changed = true;
    }
    if (changed) this.publish();
  }

  /** Polls the non-selected accounts one at a time; overlapping calls share the running pass. */
  refresh(): Promise<void> {
    if (this.running) return this.running;
    const job = (async () => {
      for (const target of getAccountUsageTargets(this.config)) {
        let result: ProviderFetchResult;
        try {
          result = await this.fetcher(this.config, target);
        } catch (error) {
          result = { providerId: target.provider, fetchedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
        }
        // Skip results for accounts that were removed or became selected while polling.
        if (!getAccountUsageTargets(this.config).some((item) =>
          item.provider === target.provider && item.tabId === target.tabId && item.home === target.home)) continue;
        (this.summaries[target.provider] ||= {})[target.tabId] = toSummary({ ...result.usage, error: result.error });
        this.publish();
      }
    })();
    this.running = job.finally(() => { this.running = null; });
    return this.running;
  }

  private publish(): void {
    this.onUpdate(this.getSummaries());
  }

  private restartTimer(): void {
    this.stop();
    const seconds = Math.max(this.config.refreshCadenceSeconds || 120, MIN_BACKGROUND_INTERVAL_SECONDS);
    this.timer = setInterval(() => { void this.refresh(); }, seconds * 1000);
  }
}

function buildKnownKeys(config: CodexBarConfig): string[] {
  return getEnabledProviders(config).flatMap((provider) =>
    buildAccountTabs(getAccountState(config, provider)).map((tab) => `${provider}:${tab.id}`));
}
