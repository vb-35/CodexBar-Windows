import React, { useCallback, useEffect, useState } from 'react';
import { CodexAccountState, CodexStoredAccount } from '../../shared/codex-accounts';
import { AppConfig } from '../hooks/useUsageData';

interface SettingsViewProps {
  onBack: () => void;
}

const REFRESH_OPTIONS = [
  { label: '1m', value: 60000 },
  { label: '2m', value: 120000 },
  { label: '5m', value: 300000 },
  { label: '15m', value: 900000 },
];

export function SettingsView({ onBack }: SettingsViewProps) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [accountState, setAccountState] = useState<CodexAccountState | null>(null);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [remoteMessage, setRemoteMessage] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    api.getConfig().then((nextConfig) => {
      setConfig(nextConfig);
      setAccountState(nextConfig.codexAccountState);
    });
  }, []);

  const refreshAccounts = useCallback(async () => {
    const nextState = await window.electronAPI.getCodexAccounts();
    setAccountState(nextState);
    setConfig((current) => current ? { ...current, codexAccountState: nextState } : current);
  }, []);

  const runAccountAction = useCallback(async (action: () => Promise<{ ok: boolean; message: string; state: CodexAccountState }>) => {
    setAccountBusy(true);
    setAccountMessage(null);
    try {
      const result = await action();
      setAccountState(result.state);
      setConfig((current) => current ? { ...current, codexAccountState: result.state } : current);
      setAccountMessage(result.message);
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : 'Account action failed.');
    } finally {
      setAccountBusy(false);
    }
  }, []);

  const handleToggleProvider = useCallback(async (enabled: boolean) => {
    if (!config) return;

    const updated = {
      ...config,
      enabledProviders: {
        ...config.enabledProviders,
        codex: enabled,
      },
    };
    setConfig(updated);

    setSaving(true);
    try {
      await window.electronAPI.setConfig({ enabledProviders: updated.enabledProviders });
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
          <button className="settings-back-btn" onClick={onBack}>←</button>
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
        <button className="settings-back-btn" onClick={onBack}>←</button>
        <h2 className="settings-title">Settings</h2>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Codex Accounts</div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Active account</div>
            <div className="settings-row-sublabel">Controls which Codex account usage refreshes against</div>
          </div>
        </div>
        <select
          className="settings-api-key-input"
          disabled={accountBusy}
          value={activeSelection}
          onChange={(event) => runAccountAction(() => window.electronAPI.setActiveCodexAccount(event.target.value || undefined))}
        >
          <option value="">Ambient system account</option>
          {codexAccounts.filter((account) => account.id !== accountState?.systemAccountId).map((account) => (
            <option key={account.id} value={account.id}>{formatAccountLabel(account, accountState)}</option>
          ))}
        </select>

        <div className="settings-row" style={{ marginTop: '12px' }}>
          <div>
            <div className="settings-row-label">System account</div>
            <div className="settings-row-sublabel">
              {accountState?.systemAccount ? accountState.systemAccount.label : 'No ambient ~/.codex/auth.json detected'}
            </div>
          </div>
        </div>

        <div className="settings-actions">
          <button className="settings-action-btn" disabled={accountBusy} onClick={() => runAccountAction(() => window.electronAPI.addCodexAccount())}>
            Add Account
          </button>
          <button className="settings-action-btn" disabled={accountBusy} onClick={() => runAccountAction(() => window.electronAPI.importCodexAccount())}>
            Import auth.json
          </button>
          <button className="settings-action-btn settings-action-btn--secondary" disabled={accountBusy} onClick={refreshAccounts}>
            Refresh
          </button>
        </div>

        <div className="settings-account-list">
          {codexAccounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              accountState={accountState}
              disabled={accountBusy}
              onMakeSystem={() => runAccountAction(() => window.electronAPI.promoteCodexAccountToSystem(account.id))}
              onReauthenticate={() => runAccountAction(() => window.electronAPI.reauthenticateCodexAccount(account.id))}
              onRemove={() => runAccountAction(() => window.electronAPI.removeCodexAccount(account.id))}
            />
          ))}
        </div>

        {accountState?.missingSystemAuth && (
          <div className="text-muted" style={{ marginTop: '10px', fontSize: '12px' }}>
            Ambient Codex auth is missing. CodexBar can still use managed accounts.
          </div>
        )}

        {accountMessage && (
          <div className="text-muted" style={{ marginTop: '10px', fontSize: '12px' }}>
            {accountMessage}
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Provider</div>
        <div className="settings-row">
          <div className="settings-row-label">Codex</div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={config.enabledProviders.codex ?? true}
              onChange={(event) => handleToggleProvider(event.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Remote history</div>
        <div className="settings-row-sublabel" style={{ marginBottom: '10px' }}>
          Uses your OpenSSH config and keys. Leave the target blank to disable it.
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
        <div className="settings-actions settings-remote-actions">
          <button className="settings-action-btn" disabled={saving} onClick={handleRemoteSave}>Save</button>
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
    onMakeSystem,
    onReauthenticate,
    onRemove,
  }: {
    account: CodexStoredAccount;
    accountState: CodexAccountState | null;
    disabled: boolean;
    onMakeSystem: () => void;
    onReauthenticate: () => void;
    onRemove: () => void;
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
        <button className="settings-action-btn" disabled={disabled || isSystem} onClick={onMakeSystem}>Make System</button>
        <button className="settings-action-btn settings-action-btn--secondary" disabled={disabled} onClick={onReauthenticate}>Re-authenticate</button>
        <button className="settings-action-btn settings-action-btn--danger" disabled={disabled} onClick={onRemove}>Remove</button>
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
