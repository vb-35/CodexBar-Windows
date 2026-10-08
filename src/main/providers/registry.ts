/**
 * Provider registry — maps provider IDs to fetch implementations and metadata.
 * Port of ProviderDescriptorRegistry from Swift.
 */

import { UsageProviderId, ProviderFetcher, ProviderMetadata } from './types';
import { codexProvider, codexMetadata } from './codex/index';
import { claudeProvider, claudeMetadata } from './claude/index';

/** All registered provider fetchers */
const providers: Map<UsageProviderId, ProviderFetcher> = new Map([
  ['codex', codexProvider],
  ['claude', claudeProvider],
]);

/** All registered provider metadata */
const metadata: Map<UsageProviderId, ProviderMetadata> = new Map([
  ['codex', codexMetadata],
  ['claude', claudeMetadata],
]);

/** Get the fetcher for a provider ID */
export function getProvider(id: UsageProviderId): ProviderFetcher | undefined {
  return providers.get(id);
}

/** Get metadata for a provider ID */
export function getProviderMetadata(id: UsageProviderId): ProviderMetadata | undefined {
  return metadata.get(id);
}

/** Get all registered provider IDs */
export function getAllProviderIds(): UsageProviderId[] {
  return Array.from(providers.keys());
}

/** Get all registered metadata */
export function getAllMetadata(): ProviderMetadata[] {
  return Array.from(metadata.values());
}

/** Get the default enabled state for all providers */
export function getDefaultEnabledProviders(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const [id, meta] of metadata) {
    result[id] = meta.defaultEnabled;
  }
  return result;
}
