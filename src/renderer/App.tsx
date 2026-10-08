import React, { useEffect, useMemo, useState } from 'react';
import { ProviderCard } from './components/ProviderCard';
import { SettingsView } from './components/SettingsView';
import { AppConfig, ProviderUsageData, useUsageData } from './hooks/useUsageData';
import {
  buildAccountTabs,
  getDefaultAccountTabId,
  getProviderMetadataMap,
} from '../shared/popover-model';
import { CodexAccountOperationResult, CodexAccountState } from '../shared/codex-accounts';

type View = 'main' | 'settings';

function App() {
  const { usageData, isRefreshing, requestRefresh } = useUsageData();
  const [currentView, setCurrentView] = useState<View>('main');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    api.getConfig().then((nextConfig) => {
      setConfig(nextConfig);
    });
    return api.onConfigChanged(setConfig);
  }, []);

  const providerEntries = useMemo(() => config?.providerMetadata
    ? config.providerMetadata.filter((meta) => config.enabledProviders[meta.id]).map((meta) => usageData[meta.id] || {
      providerId: meta.id, displayName: meta.displayName, iconColor: meta.id === 'claude' ? '#d97757' : '#49a3b0',
    })
    : Object.values(usageData), [config, usageData]);
  const selectedProvider = providerEntries.find((item) => item.providerId === selectedProviderId) || providerEntries[0];
  const isClaude = selectedProvider?.providerId === 'claude';
  const accountState = config ? (isClaude ? config.claudeAccountState : config.codexAccountState) : undefined;
  const accountTabs = useMemo(() => accountState ? buildAccountTabs(accountState) : [], [accountState]);
  const providerMetadata = useMemo(
    () => getProviderMetadataMap(config?.providerMetadata),
    [config],
  );

  const selectedAccountId = accountState ? getDefaultAccountTabId(accountState) : 'system';

  useEffect(() => {
    if (providerEntries.length === 0) {
      setSelectedProviderId('');
      return;
    }

    setSelectedProviderId((current) => {
      if (current && providerEntries.some((item) => item.providerId === current)) {
        return current;
      }
      return providerEntries[0].providerId;
    });
  }, [providerEntries]);

  const selectedProviderMeta = selectedProvider ? providerMetadata[selectedProvider.providerId] : undefined;

  useEffect(() => { setAccountMessage(null); }, [selectedProvider?.providerId]);

  const runAccountAction = async (action: () => Promise<CodexAccountOperationResult>) => {
    setAccountBusy(true);
    setAccountMessage(null);

    try {
      const result = await action();
      setConfig((current) => (current ? { ...current, [isClaude ? 'claudeAccountState' : 'codexAccountState']: result.state } : current));
      setAccountMessage(result.message);
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : 'Account action failed.');
    } finally {
      setAccountBusy(false);
    }
  };

  const handleOpenExternal = (url?: string) => {
    if (url) {
      window.electronAPI?.openExternal(url);
    }
  };

  const handleQuit = () => {
    window.electronAPI?.quitApp?.();
  };

  return (
    <div className="app-shell">
      <div className="popover">
        {currentView === 'main' && selectedProvider && providerEntries.length > 1 && (
          <div className="provider-tabs">
            {providerEntries.map((provider) => (
              <button
                key={provider.providerId}
                className={`provider-tab ${selectedProvider.providerId === provider.providerId ? 'provider-tab--active' : ''}`}
                onClick={() => setSelectedProviderId(provider.providerId)}
                title={provider.displayName}
                aria-label={provider.displayName}
                aria-pressed={selectedProvider.providerId === provider.providerId}
              >
                <img src={`./provider-logos/${provider.providerId}.svg`} alt="" width={24} height={24} />
              </button>
            ))}
          </div>
        )}

        {currentView === 'main' && accountTabs.length > 0 && (
          <div className="top-strip">
            {accountTabs.map((tab) => (
              <button
                key={tab.id}
                className={`top-chip ${selectedAccountId === tab.id ? 'top-chip--active' : ''}`}
                onClick={() => {
                  if (tab.id !== selectedAccountId) {
                    void runAccountAction(() => (isClaude ? window.electronAPI.setActiveClaudeAccount : window.electronAPI.setActiveCodexAccount)(tab.id === 'system' ? undefined : tab.id));
                  }
                }}
                disabled={accountBusy}
                title={tab.label}
                aria-label={`${tab.label} (${tab.subtitle})`}
                aria-pressed={selectedAccountId === tab.id}
              >
                {Array.from(tab.label.trim())[0]?.toLocaleUpperCase() || '?'}
              </button>
            ))}
          </div>
        )}

        {currentView !== 'main' && (
          <div className="detail-header">
            <button className="detail-back-btn" onClick={() => setCurrentView('main')}>
              Back
            </button>
            <div className="detail-title">Settings</div>
          </div>
        )}

        <div className={`popover-scroll ${currentView !== 'main' ? 'popover-scroll--detail' : ''}`}>
          {currentView === 'settings' && (
            <SettingsView onBack={() => setCurrentView('main')} />
          )}

          {currentView === 'main' && (
            <>
              {selectedProvider ? (
                <ProviderCard
                  data={selectedProvider}
                  accountLabel={getSelectedAccountLabel(accountState, selectedProvider)}
                  accountKindLabel={getSelectedAccountKindLabel(accountState)}
                />
              ) : (
                <div className="sheet-card empty-sheet">
                  <div className="sheet-title">{isRefreshing ? 'Loading account usage…' : 'No usage data yet'}</div>
                  <p className="sheet-copy">{isRefreshing ? 'You can switch accounts while usage refreshes.' : 'Refresh usage or enable a provider in Settings.'}</p>
                </div>
              )}

              <section className="sheet-card">
                <div className="section-heading">Accounts</div>
                <div className="account-summary">
                  <div>
                    <div className="account-summary-title">{getSelectedAccountLabel(accountState, selectedProvider)}</div>
                    <div className="account-summary-subtitle">{getSelectedAccountKindLabel(accountState)}</div>
                  </div>
                  {isRefreshing && <div className="sheet-meta">Refreshing…</div>}
                </div>
                <div className="inline-actions">
                  <button className="pill-action" disabled={accountBusy} onClick={() => runAccountAction(() => (isClaude ? window.electronAPI.addClaudeAccount : window.electronAPI.addCodexAccount)())}>
                    Add Account
                  </button>
                  <button className="pill-action" disabled={accountBusy} onClick={() => runAccountAction(() => (isClaude ? window.electronAPI.importClaudeAccount : window.electronAPI.importCodexAccount)())}>
                    Import {isClaude ? 'credentials' : 'auth.json'}
                  </button>
                  {!isClaude && getPromotableAccountId(config) && (
                    <button
                      className="pill-action"
                      disabled={accountBusy}
                      onClick={() => runAccountAction(() => window.electronAPI.promoteCodexAccountToSystem(getPromotableAccountId(config)!))}
                    >
                      Make System
                    </button>
                  )}
                </div>
                {accountMessage && <div className="sheet-note">{accountMessage}</div>}
              </section>

              <div className="action-list">
                <ActionRow label="Usage" onClick={() => handleOpenExternal(selectedProviderMeta?.dashboardURL)} />
                <ActionRow label="Status Page" onClick={() => handleOpenExternal(selectedProviderMeta?.statusPageURL)} />
              </div>

              <div className="action-list">
                <ActionRow label="Settings" onClick={() => setCurrentView('settings')} />
                <ActionRow label="Refresh" onClick={requestRefresh} trailingLabel={isRefreshing ? 'Working' : undefined} />
                <ActionRow label="Quit" onClick={handleQuit} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionRow(
  {
    label,
    onClick,
    trailingLabel,
  }: {
    label: string;
    onClick: () => void;
    trailingLabel?: string;
  },
) {
  return (
    <button className="action-row" onClick={onClick}>
      <span>{label}</span>
      <span className="action-row-trailing">{trailingLabel || '>'}</span>
    </button>
  );
}

function getSelectedAccountLabel(state: CodexAccountState | undefined, selectedProvider?: ProviderUsageData): string {
  if (!state) return selectedProvider?.identity || 'System Account';
  if (state.activeAccountId) {
    const active = state.accounts.find((account) => account.id === state.activeAccountId);
    return active?.email || active?.label || selectedProvider?.identity || 'Managed Account';
  }

  return state.systemAccount?.email || state.systemAccount?.label || selectedProvider?.identity || 'System Account';
}

function getSelectedAccountKindLabel(state?: CodexAccountState): string {
  if (!state) return 'Account';
  if (state.activeAccountId) return 'Managed account';
  return state.systemAccount ? 'System account' : 'No ambient system auth';
}

function getPromotableAccountId(config: AppConfig | null): string | undefined {
  if (!config) return undefined;
  const activeId = config.codexAccountState.activeAccountId;
  if (!activeId || activeId === config.codexAccountState.systemAccountId) {
    return undefined;
  }
  return activeId;
}

export default App;
