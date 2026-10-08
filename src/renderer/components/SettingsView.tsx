import React, { useCallback, useEffect, useState } from 'react';
import { CodexAccountState, CodexStoredAccount } from '../../shared/codex-accounts';
import { AppConfig } from '../hooks/useUsageData';
import { Icon } from './Icon';
import { useAccountClocks } from '../hooks/useAccountClocks';
import { ClockStatus } from './ClockStatus';

interface SettingsViewProps {
  onBack: () => void;
  initialProvider: 'codex' | 'claude';
  clocks: ReturnType<typeof useAccountClocks>;
}

const REFRESH_OPTIONS = [
  { label: '1m', value: 60000 },
  { label: '2m', value: 120000 },
  { label: '5m', value: 300000 },
  { label: '15m', value: 900000 },
];

export function SettingsView({ onBack, initialProvider, clocks }: SettingsViewProps) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [accountProvider, setAccountProvider] = useState<'codex' | 'claude'>(initialProvider);
  const isClaude = accountProvider === 'claude';
  const providerName = isClaude ? 'Claude' : 'Codex';
  const accountState = (isClaude ? config?.claudeAccountState : config?.codexAccountState) || null;
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [accountActionBusy, setAccountBusy] = useState(false);
  const accountBusy = accountActionBusy || clocks.state.busy;
  const [remoteMessage, setRemoteMessage] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    api.getConfig().then((nextConfig) => {
      setConfig(nextConfig);
    });
    return api.onConfigChanged((nextConfig) => {
      setConfig((current) => current ? { ...current, codexAccountState: nextConfig.codexAccountState, claudeAccountState: nextConfig.claudeAccountState } : nextConfig);
    });
  }, []);

  const refreshAccounts = useCallback(async () => {
    const nextState = await (isClaude ? window.electronAPI.getClaudeAccounts : window.electronAPI.getCodexAccounts)();
    setConfig((current) => current ? { ...current, [isClaude ? 'claudeAccountState' : 'codexAccountState']: nextState } : current);
  }, [isClaude]);

  const runAccountAction = useCallback(async (action: () => Promise<{ ok: boolean; message: string; state: CodexAccountState }>) => {
    setAccountBusy(true);
    setAccountMessage(null);
    try {
      const result = await action();
      setConfig((current) => current ? { ...current, [isClaude ? 'claudeAccountState' : 'codexAccountState']: result.state } : current);
      setAccountMessage(result.message);
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : 'Account action failed.');
    } finally {
      setAccountBusy(false);
    }
  }, [isClaude]);

  const handleToggleProvider = useCallback(async (providerId: string, enabled: boolean) => {
    if (!config) return;

    const updated = {
      ...config,
      enabledProviders: {
        ...config.enabledProviders,
        [providerId]: enabled,
      },
    };
    setConfig(updated);

    setSaving(true);
    try {
      await window.electronAPI.setConfig({ enabledProviders: updated.enabledProviders });
      window.electronAPI.requestRefresh();
    } finally {
      setSaving(false);
    }
  }, [config]);

  const handleRefreshChange = useCallback(async (intervalMs: number) => {
    if (!config) return;

    setConfig({ ...config, refreshIntervalMs: intervalMs });

    setSaving(true);
    try {
      await window.electronAPI.setConfig({ refreshIntervalMs: intervalMs });
    } finally {
      setSaving(false);
    }
  }, [config]);

  const handleLaunchAtStartup = useCallback(async (enabled: boolean) => {
    if (!config) return;

    setConfig({ ...config, launchAtStartup: enabled });

    setSaving(true);
    try {
      await window.electronAPI.setConfig({ launchAtStartup: enabled });
    } finally {
      setSaving(false);
    }
  }, [config]);

  const handleRemoteSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setRemoteMessage(null);
    try {
      await window.electronAPI.setConfig({ remoteHistory: config.remoteHistory });
      setRemoteMessage(config.remoteHistory.sshTarget.trim() ? 'Remote history saved.' : 'Remote history disabled.');
      window.electronAPI.requestRefresh();
    } catch (error) {
      setRemoteMessage(error instanceof Error ? error.message : 'Could not save remote history.');
    } finally {
      setSaving(false);
    }
  }, [config]);

  if (!config) {
    return (
      <div className="settings-view">
        <div className="settings-header">
          <button className="settings-back-btn icon-button" title="Back" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
          <h2 className="settings-title">Settings</h2>
        </div>
        <div className="empty-state">
          <span className="text-secondary">Loading...</span>
        </div>
      </div>
    );
  }

  const codexAccounts = accountState?.accounts || [];
  const activeSelection = accountState?.activeAccountId || '';

  return (
    <div className="settings-view">
      <div className="settings-header">
        <button className="settings-back-btn icon-button" title="Back" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
        <h2 className="settings-title">Settings</h2>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{providerName} Accounts</div>
        <select className="settings-api-key-input" aria-label="Account provider" value={accountProvider} disabled={accountBusy}
          onChange={(event) => { setAccountProvider(event.target.value as 'codex' | 'claude'); setAccountMessage(null); }}>
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Active account</div>
            <div className="settings-row-sublabel">Controls which {providerName} account usage refreshes against</div>
          </div>
        </div>
        <select
          className="settings-api-key-input"
          aria-label="Active account"
          disabled={accountBusy}
          value={activeSelection}
          onChange={(event) => runAccountAction(() => (isClaude ? window.electronAPI.setActiveClaudeAccount : window.electronAPI.setActiveCodexAccount)(event.target.value || undefined))}
        >
          <option value="">{providerName} CLI account</option>
          {codexAccounts.filter((account) => account.id !== accountState?.systemAccountId).map((account) => (
            <option key={account.id} value={account.id}>{formatAccountLabel(account, accountState)}</option>
          ))}
        </select>

        <div className="settings-row">
          <div>
            <div className="settings-row-label">{providerName} CLI account</div>
            <div className="settings-row-sublabel">
              {accountState?.systemAccount ? accountState.systemAccount.label : isClaude ? 'No Claude Code login detected' : 'No ambient ~/.codex/auth.json detected'}
            </div>
          </div>
        </div>

        {accountState?.systemAccount && <button className="settings-action-btn clock-button" disabled={accountBusy}
          aria-label={`Start clock for ${accountState.systemAccount.label}`} onClick={() => clocks.start({ provider: accountProvider, accountId: 'system' })}>
          <Icon name="clock" /> Start CLI account clock
        </button>}

        <div className="settings-actions">
          <button className="settings-action-btn icon-button" title="Add account" aria-label="Add account" disabled={accountBusy} onClick={() => runAccountAction(() => (isClaude ? window.electronAPI.addClaudeAccount : window.electronAPI.addCodexAccount)())}>
            <Icon name="addAccount" />
          </button>
          <button className="settings-action-btn icon-button" title={`Import ${isClaude ? 'credentials' : 'auth.json'}`} aria-label={`Import ${isClaude ? 'credentials' : 'auth.json'}`} disabled={accountBusy} onClick={() => runAccountAction(() => (isClaude ? window.electronAPI.importClaudeAccount : window.electronAPI.importCodexAccount)())}>
            <Icon name="import" />
          </button>
          <button className="settings-action-btn settings-action-btn--secondary icon-button" title="Refresh accounts" aria-label="Refresh accounts" disabled={accountBusy} onClick={refreshAccounts}>
            <Icon name="refresh" />
          </button>
        </div>

        <div className="settings-account-list">
          {codexAccounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              accountState={accountState}
              disabled={accountBusy}
              remoteSyncEnabled={isClaude && Boolean(config.remoteHistory.sshTarget)}
              onStartClock={() => clocks.start({ provider: accountProvider, accountId: account.id })}
              onMakeSystem={() => runAccountAction(() => (isClaude ? window.electronAPI.promoteClaudeAccountToSystem : window.electronAPI.promoteCodexAccountToSystem)(account.id))}
              onReauthenticate={() => runAccountAction(() => (isClaude ? window.electronAPI.reauthenticateClaudeAccount : window.electronAPI.reauthenticateCodexAccount)(account.id))}
              onRemove={() => runAccountAction(() => (isClaude ? window.electronAPI.removeClaudeAccount : window.electronAPI.removeCodexAccount)(account.id))}
            />
          ))}
        </div>
        <ClockStatus state={clocks.state} />

        {accountState?.missingSystemAuth && (
          <div className="text-muted" style={{ marginTop: '10px', fontSize: '12px' }}>
            Ambient {providerName} auth is missing. CodexBar can still use managed accounts.
          </div>
        )}

        {accountMessage && (
          <div className="text-muted" style={{ marginTop: '10px', fontSize: '12px' }}>
            {accountMessage}
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Providers</div>
        {config.providerMetadata?.map((provider) => <div className="settings-row" key={provider.id}>
          <div className="settings-row-label">{provider.displayName}</div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label={`Enable ${provider.displayName}`}
              checked={config.enabledProviders[provider.id] ?? true}
              onChange={(event) => handleToggleProvider(provider.id, event.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>)}
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Remote history · Codex and Claude</div>
        <div className="settings-row-sublabel" style={{ marginBottom: '10px' }}>
          Uses your OpenSSH config and keys to read usage totals. Make CLI Account also copies the selected provider's credentials to this remote host, preserving the original login in backup files.
        </div>
        <input
          className="settings-api-key-input"
          aria-label="SSH target"
          placeholder="SSH target, for example user@server"
          value={config.remoteHistory.sshTarget}
          onChange={(event) => setConfig({
            ...config,
            remoteHistory: { ...config.remoteHistory, sshTarget: event.target.value },
          })}
        />
        <input
          className="settings-api-key-input settings-remote-path-input"
          aria-label="Remote Codex home"
          placeholder="Remote Codex home"
          value={config.remoteHistory.codexHome}
          onChange={(event) => setConfig({
            ...config,
            remoteHistory: { ...config.remoteHistory, codexHome: event.target.value },
          })}
        />
        <input
          className="settings-api-key-input settings-remote-path-input"
          aria-label="Remote Claude home"
          placeholder="Remote Claude home"
          value={config.remoteHistory.claudeHome}
          onChange={(event) => setConfig({ ...config, remoteHistory: { ...config.remoteHistory, claudeHome: event.target.value } })}
        />
        <div className="settings-actions settings-remote-actions">
          <button className="settings-action-btn icon-button" title="Save remote history" aria-label="Save remote history" disabled={saving} onClick={handleRemoteSave}><Icon name="save" /></button>
          <span className="settings-row-sublabel">Requires Python 3 on the remote machine; installs nothing.</span>
        </div>
        {remoteMessage && <div className="text-muted settings-message">{remoteMessage}</div>}
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Refresh Interval</div>
        <div className="radio-group">
          {REFRESH_OPTIONS.map((option) => (
            <label key={option.value} className="radio-pill">
              <input
                type="radio"
                name="refresh"
                checked={config.refreshIntervalMs === option.value}
                onChange={() => handleRefreshChange(option.value)}
              />
              <span className="radio-pill-label">{option.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">General</div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Launch at startup</div>
            <div className="settings-row-sublabel">Start CodexBar when Windows boots</div>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label="Launch at startup"
              checked={config.launchAtStartup}
              onChange={(event) => handleLaunchAtStartup(event.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      {(saving || accountBusy) && (
        <div className="text-muted" style={{ textAlign: 'center', fontSize: 'var(--font-xs)', marginTop: 'var(--space-sm)' }}>
          Working...
        </div>
      )}
    </div>
  );
}

function AccountCard(
  {
    account,
    accountState,
    disabled,
    remoteSyncEnabled,
    onMakeSystem,
    onReauthenticate,
    onRemove,
    onStartClock,
  }: {
    account: CodexStoredAccount;
    accountState: CodexAccountState | null;
    disabled: boolean;
    remoteSyncEnabled: boolean;
    onMakeSystem?: () => void;
    onReauthenticate: () => void;
    onRemove: () => void;
    onStartClock: () => void;
  },
) {
  const isSystem = accountState?.systemAccountId === account.id;
  const isActive = accountState?.activeAccountId === account.id;

  return (
    <div className="settings-account-card">
      <div className="settings-row-label settings-account-card-label">{account.label}</div>
      <div className="settings-row-sublabel">
        {isActive ? 'Active for CodexBar' : 'Stored managed account'}{isSystem ? ' • Matches system auth' : ''}
      </div>
      <div className="settings-actions settings-actions--card">
        <button className="settings-action-btn clock-button" aria-label={`Start clock for ${account.label}`} disabled={disabled} onClick={onStartClock}><Icon name="clock" /> Start clock</button>
        {onMakeSystem && <button className="settings-action-btn icon-button" title={isSystem && remoteSyncEnabled ? 'Sync remote CLI account' : 'Make CLI account'} aria-label={`Make ${account.label} the CLI account`} disabled={disabled || (isSystem && !remoteSyncEnabled)} onClick={onMakeSystem}><Icon name="system" /></button>}
        <button className="settings-action-btn settings-action-btn--secondary icon-button" title="Re-authenticate" aria-label={`Re-authenticate ${account.label}`} disabled={disabled} onClick={onReauthenticate}><Icon name="key" /></button>
        <button className="settings-action-btn settings-action-btn--danger icon-button" title="Remove account" aria-label={`Remove ${account.label}`} disabled={disabled} onClick={onRemove}><Icon name="remove" /></button>
      </div>
    </div>
  );
}

function formatAccountLabel(account: CodexStoredAccount, state: CodexAccountState | null): string {
  const suffixes: string[] = [];
  if (state?.activeAccountId === account.id) suffixes.push('active');
  if (state?.systemAccountId === account.id) suffixes.push('system');
  return suffixes.length > 0 ? `${account.label} (${suffixes.join(', ')})` : account.label;
}
