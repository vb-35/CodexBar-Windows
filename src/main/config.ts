/**
 * Configuration store — reads/writes ~/.codexbar/config.json
 * Same format as the macOS version for config compatibility.
 */

import * as fs from 'fs';
import * as path from 'path';
import { reconcileCodexAccountsConfig } from './codex-accounts';
import { getDefaultEnabledProviders, getAllProviderIds } from './providers/registry';
import { CodexBarConfig, ProviderConfig, UsageProviderId } from './providers/types';

const CONFIG_VERSION = 1;

function getConfigDir(): string {
  const userProfile = process.env['USERPROFILE'] || process.env['HOME'] || '';
  return path.join(userProfile, '.codexbar');
}

function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): CodexBarConfig {
  const configPath = getConfigPath();

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      return normalizeConfig(JSON.parse(raw) as CodexBarConfig);
    }
  } catch {
    // fall through to default
  }

  return makeDefaultConfig();
}

export function saveConfig(config: CodexBarConfig): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

function makeDefaultConfig(): CodexBarConfig {
  const defaults = getDefaultEnabledProviders();
  const providers: ProviderConfig[] = getAllProviderIds().map((id) => ({
    id,
    enabled: defaults[id] ?? false,
  }));

  return reconcileCodexAccountsConfig({
    version: CONFIG_VERSION,
    providers,
    refreshCadenceSeconds: 120,
    launchAtStartup: false,
  });
}

function normalizeConfig(config: CodexBarConfig): CodexBarConfig {
  const allIds = getAllProviderIds();
  const defaults = getDefaultEnabledProviders();
  const seen = new Set<string>();
  const normalized: ProviderConfig[] = [];

  for (const provider of config.providers || []) {
    if (!seen.has(provider.id) && allIds.includes(provider.id as UsageProviderId)) {
      seen.add(provider.id);
      normalized.push(provider);
    }
  }

  for (const id of allIds) {
    if (!seen.has(id)) {
      normalized.push({
        id,
        enabled: defaults[id] ?? false,
      });
    }
  }

  return reconcileCodexAccountsConfig({
    version: CONFIG_VERSION,
    providers: normalized,
    refreshCadenceSeconds: config.refreshCadenceSeconds ?? 120,
    launchAtStartup: config.launchAtStartup ?? false,
    remoteHistory: config.remoteHistory,
    codexAccounts: config.codexAccounts,
    claudeAccounts: config.claudeAccounts,
  });
}

export function getEnabledProviders(config: CodexBarConfig): UsageProviderId[] {
  const defaults = getDefaultEnabledProviders();
  return config.providers
    .filter((provider) => provider.enabled ?? defaults[provider.id] ?? false)
    .map((provider) => provider.id);
}

export function getProviderConfig(config: CodexBarConfig, id: UsageProviderId): ProviderConfig | undefined {
  return config.providers.find((provider) => provider.id === id);
}

export function setProviderConfig(config: CodexBarConfig, updated: ProviderConfig): CodexBarConfig {
  const providers = config.providers.map((provider) => (provider.id === updated.id ? updated : provider));
  return { ...config, providers };
}
