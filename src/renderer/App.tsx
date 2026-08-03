import React, { useEffect, useMemo, useState } from 'react';
import { ProviderCard } from './components/ProviderCard';
import { SettingsView } from './components/SettingsView';
import { AppConfig, ProviderUsageData, useUsageData } from './hooks/useUsageData';
import {
  buildAccountTabs,
  getDefaultAccountTabId,
  getProviderMetadataMap,
} from '../shared/popover-model';

type View = 'main' | 'settings';

function App() {
  const { usageData, isRefreshing, requestRefresh } = useUsageData();
  const [currentView, setCurrentView] = useState<View>('main');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState('system');
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    api.getConfig().then((nextConfig) => {
      setConfig(nextConfig);
    });
  }, []);

  const accountTabs = useMemo(
    () => (config ? buildAccountTabs(config.codexAccountState) : []),
    [config],
  );
  const providerEntries = useMemo(() => Object.values(usageData), [usageData]);
  const providerMetadata = useMemo(
    () => getProviderMetadataMap(config?.providerMetadata),
    [config],
  );

  useEffect(() => {
    if (!config) return;
    setSelectedAccountId(getDefaultAccountTabId(config.codexAccountState));
  }, [config]);

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

  const selectedProvider = providerEntries.find((item) => item.providerId === selectedProviderId) || providerEntries[0];
  const selectedProviderMeta = selectedProvider ? providerMetadata[selectedProvider.providerId] : undefined;

  const handleSwitchAccount = async (accountId: string) => {
    setAccountBusy(true);
    setAccountMessage(null);

    try {
      const result = await window.electronAPI.setActiveCodexAccount(accountId === 'system' ? undefined : accountId);
      setSelectedAccountId(accountId);
      setConfig((current) => (current ? { ...current, codexAccountState: result.state } : current));
      setAccountMessage(result.message);
    } finally {
      setAccountBusy(false);
    }
  };

  const runAccountAction = async (action: () => Promise<any>) => {
    setAccountBusy(true);
    setAccountMessage(null);

    try {
      const result = await action();
      if (result?.state) {
        setConfig((current) => (current ? { ...current, codexAccountState: result.state } : current));
      } else {
        const nextConfig = await window.electronAPI.getConfig();
        setConfig(nextConfig);
      }
      if (result?.message) {
        setAccountMessage(result.message);
      }
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
        {currentView === 'main' && accountTabs.length > 0 && (
          <div className="top-strip">
            {accountTabs.map((tab) => (
              <button
                key={tab.id}
                className={`top-chip ${selectedAccountId === tab.id ? 'top-chip--active' : ''}`}
                onClick={() => handleSwitchAccount(tab.id)}
                disabled={accountBusy}
                title={tab.label}
              >
                {tab.label}
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
              {selectedProvider && providerEntries.length > 1 && (
                <div className="provider-tabs">
                  {providerEntries.map((provider) => (
                    <button
                      key={provider.providerId}
                      className={`provider-tab ${selectedProvider.providerId === provider.providerId ? 'provider-tab--active' : ''}`}
                      onClick={() => setSelectedProviderId(provider.providerId)}
                    >
                      {provider.displayName}
                    </button>
                  ))}
                </div>
              )}

              {selectedProvider ? (
                <ProviderCard
                  data={selectedProvider}
                  accountLabel={getSelectedAccountLabel(config, selectedProvider)}
                  accountKindLabel={getSelectedAccountKindLabel(config)}
                />
              ) : (
                <div className="sheet-card empty-sheet">
                  <div className="sheet-title">No providers active</div>
                  <p className="sheet-copy">Enable a provider in Settings to start tracking usage here.</p>
                </div>
              )}

              <section className="sheet-card">
                <div className="section-heading">Accounts</div>
                <div className="account-summary">
                  <div>
                    <div className="account-summary-title">{getSelectedAccountLabel(config, selectedProvider)}</div>
                    <div className="account-summary-subtitle">{getSelectedAccountKindLabel(config)}</div>
                  </div>
                  {isRefreshing && <div className="sheet-meta">Refreshing…</div>}
                </div>
                <div className="inline-actions">
                  <button className="pill-action" disabled={accountBusy} onClick={() => runAccountAction(() => window.electronAPI.addCodexAccount())}>
                    Add Account
                  </button>
                  <button className="pill-action" disabled={accountBusy} onClick={() => runAccountAction(() => window.electronAPI.importCodexAccount())}>
                    Import auth.json
                  </button>
                  {getPromotableAccountId(config) && (
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

function getSelectedAccountLabel(config: AppConfig | null, selectedProvider?: ProviderUsageData): string {
  if (!config) return selectedProvider?.identity || 'System Account';

  const state = config.codexAccountState;
  if (state.activeAccountId) {
    const active = state.accounts.find((account) => account.id === state.activeAccountId);
    return active?.email || active?.label || selectedProvider?.identity || 'Managed Account';
  }

  return state.systemAccount?.email || state.systemAccount?.label || selectedProvider?.identity || 'System Account';
}

function getSelectedAccountKindLabel(config: AppConfig | null): string {
  if (!config) return 'Account';
  if (config.codexAccountState.activeAccountId) return 'Managed account';
  return config.codexAccountState.systemAccount ? 'System account' : 'No ambient system auth';
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
