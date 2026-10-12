import React, { useEffect, useMemo, useState } from 'react';
import { ProviderCard } from './components/ProviderCard';
import { SettingsView } from './components/SettingsView';
import { Icon } from './components/Icon';
import { AppConfig, ProviderUsageData, useAccountUsage, useUsageData } from './hooks/useUsageData';
import {
  buildAccountTabs,
  getDefaultAccountTabId,
  getProviderMetadataMap,
} from '../shared/popover-model';
import { CodexAccountOperationResult, CodexAccountState } from '../shared/codex-accounts';
import { useAccountClocks } from './hooks/useAccountClocks';
import { ClockStatus } from './components/ClockStatus';
import { AccountChip } from './components/AccountChip';

type View = 'main' | 'settings';

function App() {
  const { usageData, isRefreshing, requestRefresh } = useUsageData();
  const [currentView, setCurrentView] = useState<View>('main');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [accountActionBusy, setAccountBusy] = useState(false);
  const clocks = useAccountClocks();
  const accountUsage = useAccountUsage();
  const accountBusy = accountActionBusy || clocks.state.busy;
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
        {currentView === 'main' && (
          <div className="main-header">
            <div className="provider-tabs" role="group" aria-label="Providers">
              {selectedProvider && providerEntries.length > 1 && providerEntries.map((provider) => (
                <button
                  key={provider.providerId}
                  className={`provider-tab ${selectedProvider.providerId === provider.providerId ? 'provider-tab--active' : ''}`}
                  onClick={() => setSelectedProviderId(provider.providerId)}
                  title={provider.displayName}
                  aria-label={provider.displayName}
                  aria-pressed={selectedProvider.providerId === provider.providerId}
                  disabled={accountBusy}
                >
                  <img src={`./provider-logos/${provider.providerId}.svg`} alt="" width={20} height={20} />
                </button>
              ))}
            </div>
            {accountTabs.length > 0 && (
              <div className="top-strip" role="group" aria-label="Accounts">
                {accountTabs.map((tab) => (
                  <AccountChip
                    key={tab.id}
                    label={Array.from(tab.label.trim())[0]?.toLocaleUpperCase() || '?'}
                    title={`${tab.label} (${tab.subtitle})`}
                    usage={selectedProvider ? accountUsage[selectedProvider.providerId]?.[tab.id] : undefined}
                    active={selectedAccountId === tab.id}
                    disabled={accountBusy}
                    onClick={() => {
                      if (tab.id !== selectedAccountId) {
                        void runAccountAction(() => (isClaude ? window.electronAPI.setActiveClaudeAccount : window.electronAPI.setActiveCodexAccount)(tab.id === 'system' ? undefined : tab.id));
                      }
                    }}
                  />
                ))}
              </div>
            )}
            <button className="provider-tab" disabled={accountBusy} onClick={() => clocks.start()}
              title="Start all clocks: skip running clocks, start idle accounts one at a time" aria-label="Start all clocks" aria-busy={clocks.state.busy}>
              <Icon name="clock" />
            </button>
            <button
              className="provider-tab refresh-button"
              onClick={requestRefresh}
              disabled={isRefreshing}
              title={isRefreshing ? 'Refreshing…' : 'Refresh usage'}
              aria-label="Refresh usage"
              aria-busy={isRefreshing}
            >
              <Icon name="refresh" />
            </button>
          </div>
        )}

        {currentView !== 'main' && (
          <div className="detail-header">
            <button className="detail-back-btn icon-button" title="Back" aria-label="Back" onClick={() => setCurrentView('main')}>
              <Icon name="back" />
            </button>
            <div className="detail-title">Settings</div>
          </div>
        )}

        <div className={`popover-scroll ${currentView !== 'main' ? 'popover-scroll--detail' : ''}`}>
          {currentView === 'settings' && (
            <SettingsView initialProvider={isClaude ? 'claude' : 'codex'} onBack={() => setCurrentView('main')} clocks={clocks} />
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
                <div className="inline-actions" role="group" aria-label="Account actions">
                  <span className="account-actions-label">Accounts</span>
                  <button className="pill-action icon-button" disabled={accountBusy || !accountState || (!accountState.activeAccountId && !accountState.systemAccount)}
                    title="Start clock for this account" aria-label="Start clock for this account" onClick={() => clocks.start({ provider: isClaude ? 'claude' : 'codex', accountId: selectedAccountId })}>
                    <Icon name="clock" />
                  </button>
                  <button className="pill-action icon-button" title="Add account" aria-label="Add account" disabled={accountBusy} onClick={() => runAccountAction(() => (isClaude ? window.electronAPI.addClaudeAccount : window.electronAPI.addCodexAccount)())}>
                    <Icon name="addAccount" />
                  </button>
                  <button className="pill-action icon-button" title={`Import ${isClaude ? 'credentials' : 'auth.json'}`} aria-label={`Import ${isClaude ? 'credentials' : 'auth.json'}`} disabled={accountBusy} onClick={() => runAccountAction(() => (isClaude ? window.electronAPI.importClaudeAccount : window.electronAPI.importCodexAccount)())}>
                    <Icon name="import" />
                  </button>
                  {getPromotableAccountId(accountState) && (
                    <button
                      className="pill-action icon-button"
                      title={`Make ${isClaude ? 'Claude Code' : 'Codex'} CLI account`}
                      aria-label={`Make ${isClaude ? 'Claude Code' : 'Codex'} CLI account`}
                      disabled={accountBusy}
                      onClick={() => runAccountAction(() => (isClaude ? window.electronAPI.promoteClaudeAccountToSystem : window.electronAPI.promoteCodexAccountToSystem)(getPromotableAccountId(accountState)!))}
                    >
                      <Icon name="system" />
                    </button>
                  )}
                </div>
                {accountMessage && <div className="sheet-note" role="status">{accountMessage}</div>}
                <ClockStatus state={clocks.state} />
              </section>
            </>
          )}
        </div>
        {currentView === 'main' && (
          <div className="action-toolbar" role="group" aria-label="Application actions">
            <button className="icon-button" title="Usage dashboard" aria-label="Usage dashboard" disabled={!selectedProviderMeta?.dashboardURL} onClick={() => handleOpenExternal(selectedProviderMeta?.dashboardURL)}><Icon name="usage" /></button>
            <button className="icon-button" title="Status page" aria-label="Status page" disabled={!selectedProviderMeta?.statusPageURL} onClick={() => handleOpenExternal(selectedProviderMeta?.statusPageURL)}><Icon name="status" /></button>
            <button className="icon-button" title="Settings" aria-label="Settings" onClick={() => setCurrentView('settings')}><Icon name="settings" /></button>
            <button className="icon-button" title="Quit" aria-label="Quit" onClick={handleQuit}><Icon name="quit" /></button>
          </div>
        )}
      </div>
    </div>
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

function getPromotableAccountId(state?: CodexAccountState): string | undefined {
  const activeId = state?.activeAccountId;
  if (!activeId || activeId === state?.systemAccountId) {
    return undefined;
  }
  return activeId;
}

export default App;
