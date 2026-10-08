import { getClaudeAccountState, loadClaudeAuth, refreshManagedClaudeAuth, resolveActiveClaudeHome } from '../../claude-accounts';
import { ProviderFetcher, ProviderMetadata, UsageWindow, UsageSnapshot } from '../types';
import { getClaudeUsageHistory } from './history';

export const claudeMetadata: ProviderMetadata = {
  id: 'claude', displayName: 'Claude', sessionLabel: 'Session', weeklyLabel: 'Weekly',
  defaultEnabled: true, dashboardURL: 'https://claude.ai/settings/usage',
  statusPageURL: 'https://status.claude.com/', iconColor: '#d97757',
};

function usageWindow(value: unknown, label: string, seconds: number): UsageWindow | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const window = value as { utilization?: unknown; resets_at?: unknown };
  if (typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) return undefined;
  const reset = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) / 1000 : 0;
  return { usedPercent: Math.max(0, Math.min(100, window.utilization)), resetAt: Number.isFinite(reset) ? reset : 0,
    limitWindowSeconds: seconds, label };
}

export const claudeProvider: ProviderFetcher = {
  id: 'claude', metadata: claudeMetadata,
  async fetch(_config, appConfig, onUsage) {
    const fetchedAt = Date.now();
    const home = resolveActiveClaudeHome(appConfig);
    let auth = loadClaudeAuth(home);
    if (!auth) return { providerId: 'claude', fetchedAt, error: 'No Claude credentials found. Add a Claude account or sign in with `claude auth login`.' };
    try {
      auth = await refreshManagedClaudeAuth(home, auth);
      const requestUsage = (token: string) => fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      let response = await requestUsage(auth.oauth.accessToken);
      if (response.status === 401) {
        const renewed = await refreshManagedClaudeAuth(home, auth, true);
        if (renewed.authFingerprint !== auth.authFingerprint) {
          auth = renewed;
          response = await requestUsage(auth.oauth.accessToken);
        }
      }
      if (response.status === 401) throw new Error('Claude login expired. Re-authenticate this account in Settings, or run `claude auth login` for the system account.');
      if (response.status === 403) throw new Error('Claude usage access denied. Sign in with a Claude subscription account using `claude auth login`.');
      if (response.status === 429) throw new Error('Claude usage is rate limited. Wait a few minutes before refreshing.');
      if (!response.ok) throw new Error(`Claude usage request failed (HTTP ${response.status}).`);
      const data = await response.json() as Record<string, unknown>;
      const limits = Array.isArray(data.limits) ? data.limits.filter((limit) => limit && typeof limit === 'object' && limit.is_active !== false) : [];
      const fromLimit = (limit: Record<string, unknown> | undefined, label: string, seconds: number) =>
        usageWindow(limit && { utilization: limit.percent, resets_at: limit.resets_at }, label, seconds);
      const primary = usageWindow(data.five_hour, 'Session', 5 * 60 * 60)
        || fromLimit(limits.find((limit) => limit.kind === 'session'), 'Session', 5 * 60 * 60);
      const secondary = usageWindow(data.seven_day, 'Weekly', 7 * 24 * 60 * 60)
        || fromLimit(limits.find((limit) => limit.kind === 'weekly'), 'Weekly', 7 * 24 * 60 * 60);
      const additionalWindows = [usageWindow(data.seven_day_sonnet, 'Weekly Sonnet', 7 * 24 * 60 * 60),
        usageWindow(data.seven_day_opus, 'Weekly Opus', 7 * 24 * 60 * 60)].filter((window): window is UsageWindow => !!window);
      for (const limit of limits) {
        const model = limit.scope?.model?.display_name;
        if (limit.group !== 'weekly' || typeof model !== 'string' || !model.trim()) continue;
        const label = `Weekly ${model.trim()}`;
        const window = fromLimit(limit, label, 7 * 24 * 60 * 60);
        if (window && !additionalWindows.some((item) => item.label === label)) additionalWindows.push(window);
      }
      if (!primary && !secondary && !additionalWindows.length) throw new Error('Claude returned no subscription usage windows.');
      const state = appConfig ? getClaudeAccountState(appConfig) : undefined;
      const account = state?.accounts.find((item) => item.id === state.activeAccountId);
      const usage: UsageSnapshot = { primary, secondary, additionalWindows,
        planType: typeof auth.oauth.subscriptionType === 'string' ? auth.oauth.subscriptionType : undefined,
        identity: account?.email || auth.email || account?.label, updatedAt: fetchedAt, sourceLabel: 'OAuth' };
      onUsage?.(usage);
      usage.history = await getClaudeUsageHistory(home, appConfig?.remoteHistory);
      return { providerId: 'claude', fetchedAt, usage };
    } catch (error) {
      return { providerId: 'claude', fetchedAt, error: error instanceof Error ? error.message : 'Could not fetch Claude usage.' };
    }
  },
};
