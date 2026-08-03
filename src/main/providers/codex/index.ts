/**
 * Codex provider orchestrator.
 * Implements the fetch pipeline: OAuth -> CLI fallback.
 * Port of CodexProviderDescriptor.resolveStrategies from Swift.
 */

import { resolveActiveCodexTarget } from '../../codex-accounts';
import { CodexBarConfig, ProviderConfig, ProviderFetchResult, ProviderFetcher, ProviderMetadata } from '../types';
import { fetchViaCLI, isAvailable as isCLIAvailable, shutdown as shutdownCLI } from './cli';
import { loadCredentials } from './auth';
import { getCodexUsageHistory } from './history';
import { fetchViaOAuth } from './oauth';
import { loadCodexPricing } from './pricing';

export const codexMetadata: ProviderMetadata = {
  id: 'codex',
  displayName: 'Codex',
  sessionLabel: 'Session',
  weeklyLabel: 'Weekly',
  defaultEnabled: true,
  dashboardURL: 'https://chatgpt.com/codex/settings/usage',
  statusPageURL: 'https://status.openai.com/',
  iconColor: '#49a3b0',
};

export const codexProvider: ProviderFetcher = {
  id: 'codex',
  metadata: codexMetadata,

  async fetch(config: ProviderConfig, appConfig?: CodexBarConfig): Promise<ProviderFetchResult> {
    const sourceMode = config.source || 'auto';
    const target = resolveActiveCodexTarget(appConfig || { version: 1, providers: [] });
    const codexHome = target.homePath;
    let result: ProviderFetchResult;

    switch (sourceMode) {
      case 'oauth':
        result = await fetchViaOAuth(config, codexHome);
        break;

      case 'cli':
        result = await fetchViaCLI(config, codexHome);
        break;

      case 'auto': {
        const credentials = loadCredentials(codexHome);
        if (credentials) {
          result = await fetchViaOAuth(config, codexHome);
          if (!result.error || !isAuthError(result.error)) {
            break;
          }
        }

        if (isCLIAvailable()) {
          result = await fetchViaCLI(config, codexHome);
          break;
        }

        if (credentials) {
          result = await fetchViaOAuth(config, codexHome);
          break;
        }

        result = {
          providerId: 'codex',
          error: 'No Codex credentials found. Run `codex` to log in, or set OPENAI_API_KEY in ~/.codex/auth.json.',
          fetchedAt: Date.now(),
        };
        break;
      }

      default:
        result = {
          providerId: 'codex',
          error: `Unknown source mode: ${sourceMode}`,
          fetchedAt: Date.now(),
        };
        break;
    }

    if (result.usage) {
      try {
        const pricing = await loadCodexPricing();
        result.usage.history = await getCodexUsageHistory(codexHome, appConfig?.remoteHistory, pricing);
      } catch (error) {
        console.error('Error attaching Codex usage history:', error);
      }
    }

    return result;
  },
};

function isAuthError(error: string): boolean {
  const authPhrases = [
    'expired',
    'invalid',
    'unauthorized',
    'revoked',
    'not found',
    'auth.json not found',
    'Run `codex`',
    'missingTokens',
  ];
  const lower = error.toLowerCase();
  return authPhrases.some((phrase) => lower.includes(phrase.toLowerCase()));
}

export function shutdownCodex(): void {
  shutdownCLI();
}
