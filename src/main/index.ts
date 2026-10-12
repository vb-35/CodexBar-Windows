/**
 * CodexBar Windows — Electron main process entry point.
 * Creates the system tray, manages the popover window, and orchestrates the refresh loop.
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  OpenDialogOptions,
  screen,
  shell,
  Tray,
} from 'electron';
import * as path from 'path';
import {
  addCodexAccountViaLogin,
  getCodexAccountState,
  importCodexAccount,
  reauthenticateCodexAccount,
  reconcileCodexAccountsConfig,
  removeCodexAccount,
  setActiveCodexAccount,
} from './codex-accounts';
import { loadConfig, saveConfig } from './config';
import { getClaudeAccountState, importClaudeAccount, loginClaudeAccount, promoteClaudeAccountToSystem, removeClaudeAccount, selectClaudeAccount } from './claude-accounts';
import { buildAccountMenu } from './account-menu';
import { promoteWithDesktopRestart } from './codex-desktop';
import { shutdownCodex } from './providers/codex';
import { getAllMetadata } from './providers/registry';
import { CodexBarConfig, ProviderDisplayData } from './providers/types';
import { RefreshManager } from './refresh';
import { AccountUsagePoller } from './account-usage';
import { getPopoverBounds, POPOVER_SIZE } from './popover-bounds';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import { isAllowedExternalUrl } from '../shared/external-url';
import { CodexAccountOperationResult } from '../shared/codex-accounts';
import { ClockState, ClockTarget } from '../shared/account-clocks';
import { getClockTargets, startAccountClock, startClocksSequentially } from './account-clocks';

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let refreshManager: RefreshManager | null = null;
let accountUsagePoller: AccountUsagePoller | null = null;
let currentConfig: CodexBarConfig;
let codexAccountOperationInFlight = false;
let clockState: ClockState = { busy: false, message: '', results: [] };
let clockAbort: AbortController | undefined;
let clockJob: Promise<ClockState> | undefined;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, 'preload.js');
  const window = new BrowserWindow({
    ...POPOVER_SIZE,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    transparent: false,
    alwaysOnTop: true,
    backgroundColor: '#f3f2ef',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    window.loadURL('http://localhost:5173').catch(() => {
      window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    });
  } else {
    window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  window.on('blur', () => {
    if (!codexAccountOperationInFlight) window.hide();
  });

  return window;
}

function toggleWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }
  positionWindow();
  mainWindow.show();
  mainWindow.webContents.send(IPC_CHANNELS.USAGE_UPDATE, refreshManager?.getLatestData() || {});
  mainWindow.focus();
}

function positionWindow(): void {
  if (!mainWindow || !tray) return;

  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  mainWindow.setBounds(getPopoverBounds(trayBounds, display.workArea), false);
}

function createTrayIcon(): Electron.NativeImage {
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4, 0);
  const barColor = { r: 73, g: 163, b: 176, a: 255 };

  for (const bar of [{ x: 2, height: 10 }, { x: 6, height: 14 }, { x: 10, height: 8 }]) {
    for (let y = size - bar.height; y < size; y += 1) {
      for (let dx = 0; dx < 3; dx += 1) {
        const px = bar.x + dx;
        if (px >= size) continue;
        const offset = (y * size + px) * 4;
        canvas[offset] = barColor.r;
        canvas[offset + 1] = barColor.g;
        canvas[offset + 2] = barColor.b;
        canvas[offset + 3] = barColor.a;
      }
    }
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size, scaleFactor: 1 });
}

function updateTrayIcon(data: Record<string, ProviderDisplayData>): void {
  if (!tray) return;

  let hasError = false;
  const providers = Object.values(data);
  for (const provider of providers) {
    if (provider.error) hasError = true;
  }

  if (providers.length === 0) {
    tray.setToolTip('CodexBar - No providers enabled');
  } else if (hasError) {
    tray.setToolTip('CodexBar - Error fetching some providers');
  } else {
    const summaries = providers
      .filter((provider) => provider.primary)
      .map((provider) => `${provider.displayName}: ${provider.primary?.usedPercent}%`)
      .join(', ');
    tray.setToolTip(`CodexBar - ${summaries || 'No usage data'}`);
  }
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('CodexBar - Loading...');
  rebuildTrayMenu();
  tray.on('click', () => toggleWindow());
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
}

function buildTrayMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    { label: 'Show CodexBar', click: () => toggleWindow() },
    { type: 'separator' },
    { label: 'Refresh Now', click: refreshAll },
    { label: 'Start All Clocks', enabled: !codexAccountOperationInFlight, click: () => { void startClocks(); } },
    { label: 'Open Codex Dashboard', click: () => shell.openExternal('https://chatgpt.com/codex/settings/usage') },
    { label: 'Open Claude Dashboard', click: () => shell.openExternal('https://claude.ai/settings/usage') },
    { type: 'separator' },
    buildAccountMenu('Codex', getCodexAccountState(currentConfig), codexAccountOperationInFlight, {
      add: () => runCodexAccountOperation(() => addCodexAccountViaLogin(currentConfig)),
      import: importCodexAccountFromPicker,
      select: (id) => runCodexAccountOperation(() => setActiveCodexAccount(currentConfig, id)),
      promote: makeSystemAccount,
    }),
    buildAccountMenu('Claude', getClaudeAccountState(currentConfig), codexAccountOperationInFlight, {
      add: () => runClaudeAccountAction('add'), import: () => runClaudeAccountAction('import'),
      select: (id) => runClaudeAccountAction('select', id), promote: (id) => runClaudeAccountAction('promote', id),
    }, Boolean(currentConfig.remoteHistory?.sshTarget)),
    { type: 'separator' },
    {
      label: 'Quit CodexBar',
      click: () => {
        shutdownCodex();
        app.quit();
      },
    },
  ];
}

function setupIPC(): void {
  ipcMain.on(IPC_CHANNELS.REFRESH_REQUEST, refreshAll);
  ipcMain.handle(IPC_CHANNELS.ACCOUNT_USAGE_GET, () => accountUsagePoller?.getSummaries() || {});

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, () => makeRendererConfigPayload());

  ipcMain.handle(IPC_CHANNELS.CONFIG_SET, (_event, updates: Record<string, unknown>) => {
    if (updates.enabledProviders) {
      const enabled = updates.enabledProviders as Record<string, boolean>;
      for (const provider of currentConfig.providers) {
        if (provider.id in enabled) {
          provider.enabled = enabled[provider.id];
        }
      }
    }

    if (typeof updates.refreshIntervalMs === 'number') {
      currentConfig.refreshCadenceSeconds = Math.max(60, updates.refreshIntervalMs / 1000);
    }

    if (typeof updates.launchAtStartup === 'boolean') {
      currentConfig.launchAtStartup = updates.launchAtStartup;
      app.setLoginItemSettings({ openAtLogin: updates.launchAtStartup });
    }

    if (updates.codexAccountSwitch && typeof updates.codexAccountSwitch === 'object') {
      const options = updates.codexAccountSwitch as Record<string, unknown>;
      if (typeof options.stopVSCode !== 'boolean' || typeof options.stopT3Code !== 'boolean') {
        throw new Error('Invalid Codex account-switch options.');
      }
      currentConfig.codexAccountSwitch = { stopVSCode: options.stopVSCode, stopT3Code: options.stopT3Code };
    }

    if (updates.remoteHistory && typeof updates.remoteHistory === 'object') {
      const remote = updates.remoteHistory as Record<string, unknown>;
      const sshTarget = typeof remote.sshTarget === 'string' ? remote.sshTarget.trim() : '';
      const codexHome = typeof remote.codexHome === 'string' && remote.codexHome.trim()
        ? remote.codexHome.trim()
        : '~/.codex';
      const claudeHome = typeof remote.claudeHome === 'string' && remote.claudeHome.trim() ? remote.claudeHome.trim() : '~/.claude';
      if (sshTarget && (sshTarget.startsWith('-') || !/^[A-Za-z0-9_.@:\[\]-]+$/.test(sshTarget))) {
        throw new Error('SSH target may contain only a host, alias, user, dots, colons, brackets, and hyphens.');
      }
      currentConfig.remoteHistory = sshTarget ? { sshTarget, codexHome, claudeHome } : undefined;
    }

    persistConfig();
    // The poller must know the new selection before the refresh manager republishes cached data.
    accountUsagePoller?.updateConfig(currentConfig);
    refreshManager?.updateConfig(currentConfig);
    mainWindow?.webContents.send(IPC_CHANNELS.CONFIG_CHANGED, makeRendererConfigPayload());
  });

  ipcMain.handle(IPC_CHANNELS.CODEX_ACCOUNTS_GET, () => getCodexAccountState(currentConfig));
  ipcMain.handle(IPC_CHANNELS.CODEX_ACCOUNT_ADD, () => runCodexAccountOperation(() => addCodexAccountViaLogin(currentConfig)));
  ipcMain.handle(IPC_CHANNELS.CODEX_ACCOUNT_IMPORT, () => importCodexAccountFromPicker());
  ipcMain.handle(IPC_CHANNELS.CODEX_ACCOUNT_SELECT_ACTIVE, (_event, accountId?: string) =>
    runCodexAccountOperation(() => setActiveCodexAccount(currentConfig, accountId)));
  ipcMain.handle(IPC_CHANNELS.CODEX_ACCOUNT_PROMOTE_SYSTEM, (_event, accountId: string) =>
    makeSystemAccount(accountId));
  ipcMain.handle(IPC_CHANNELS.CODEX_ACCOUNT_REAUTH, (_event, accountId: string) =>
    runCodexAccountOperation(() => reauthenticateCodexAccount(currentConfig, accountId)));
  ipcMain.handle(IPC_CHANNELS.CODEX_ACCOUNT_REMOVE, (_event, accountId: string) =>
    runCodexAccountOperation(() => removeCodexAccount(currentConfig, accountId)));

  ipcMain.handle(IPC_CHANNELS.CLAUDE_ACCOUNT_ACTION, (_event, action: string, accountId?: string) => runClaudeAccountAction(action, accountId));
  ipcMain.handle(IPC_CHANNELS.CLOCK_STATE_GET, () => clockState);
  ipcMain.handle(IPC_CHANNELS.CLOCK_START, (_event, target?: ClockTarget) => startClocks(target));

  ipcMain.on(IPC_CHANNELS.OPEN_EXTERNAL, (_event, url: string) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
  });

  ipcMain.on(IPC_CHANNELS.QUIT_APP, () => {
    shutdownCodex();
    app.quit();
  });
}

async function startClocks(target?: ClockTarget): Promise<ClockState> {
  if (target !== undefined && (!target || !['codex', 'claude'].includes(target.provider)
    || typeof target.accountId !== 'string' || !target.accountId)) throw new Error('Invalid clock account.');
  if (codexAccountOperationInFlight) throw new Error('Another account action is in progress.');
  const all = getClockTargets(currentConfig);
  const state = target?.provider === 'claude' ? getClaudeAccountState(currentConfig) : getCodexAccountState(currentConfig);
  const targets = target ? [{ ...target, label: target.accountId === 'system'
    ? state.systemAccount?.label || 'CLI account' : all.find((item) => item.provider === target.provider && item.accountId === target.accountId)?.label || 'Account' }] : all;
  codexAccountOperationInFlight = true;
  clockAbort = new AbortController();
  const signal = clockAbort.signal;
  try {
    rebuildTrayMenu();
    clockJob = startClocksSequentially(targets, (item) => startAccountClock(currentConfig, item, signal), (next) => {
      clockState = next;
      mainWindow?.webContents.send(IPC_CHANNELS.CLOCK_STATE_CHANGED, next);
    }, signal);
    return await clockJob;
  } finally {
    clockJob = undefined;
    clockAbort = undefined;
    codexAccountOperationInFlight = false;
    rebuildTrayMenu();
    if (!signal.aborted) {
      refreshManager?.invalidateCache();
      refreshAll();
    }
  }
}

function runClaudeAccountAction(action: string, accountId?: string) {
    if (action === 'get') return getClaudeAccountState(currentConfig);
    return runCodexAccountOperation(async () => {
      if (accountId !== undefined && typeof accountId !== 'string') throw new Error('Invalid Claude account ID.');
      switch (action) {
        case 'add': return loginClaudeAccount(currentConfig);
        case 'select': return selectClaudeAccount(currentConfig, accountId);
        case 'promote':
          if (!accountId) throw new Error('Select a Claude account to make the CLI account.');
          return promoteClaudeAccountToSystem(currentConfig, accountId);
        case 'reauth':
          if (!accountId) throw new Error('Select a Claude account to re-authenticate.');
          return loginClaudeAccount(currentConfig, accountId);
        case 'remove':
          if (!accountId) throw new Error('Select a Claude account to remove.');
          return removeClaudeAccount(currentConfig, accountId);
        case 'import': {
          const options: OpenDialogOptions = { title: 'Import Claude Code .credentials.json', properties: ['openFile'],
            filters: [{ name: 'JSON Files', extensions: ['json'] }] };
          const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
          if (selected.canceled || !selected.filePaths.length) return {
            ok: false, message: 'Import canceled.', state: getClaudeAccountState(currentConfig),
          };
          return importClaudeAccount(currentConfig, selected.filePaths[0]);
        }
        default: throw new Error('Unknown Claude account action.');
      }
    }, 'claude');
}

function makeSystemAccount(accountId: string): Promise<CodexAccountOperationResult> {
  return runCodexAccountOperation(() => promoteWithDesktopRestart(currentConfig, accountId, async (clients) => {
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Switch Codex account',
      message: 'Stop the running Codex clients to switch accounts?',
      detail: `${clients.join('\n')}\n\nFinish ongoing Codex work before continuing. Codex Desktop will reopen if closed. VS Code and T3 Code stay open; reload the VS Code window or restart the T3 Code Codex session afterward if it does not reconnect.`,
      buttons: ['Yes', 'No'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const answer = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    return answer.response === 0;
  }));
}

async function runCodexAccountOperation(
  operation: () => CodexAccountOperationResult | Promise<CodexAccountOperationResult>,
  provider: 'codex' | 'claude' = 'codex',
): Promise<CodexAccountOperationResult> {
  if (codexAccountOperationInFlight) {
    return { ok: false, message: 'Another account action is in progress.', state: provider === 'claude' ? getClaudeAccountState(currentConfig) : getCodexAccountState(currentConfig) };
  }
  codexAccountOperationInFlight = true;
  rebuildTrayMenu();
  try {
    const result = await operation();
    if (result.ok && result.config) {
      currentConfig = reconcileCodexAccountsConfig(result.config as CodexBarConfig);
      persistConfig();
      // The poller must know the new selection before the refresh manager republishes cached data.
      accountUsagePoller?.updateConfig(currentConfig);
      refreshManager?.updateConfig(currentConfig);
      mainWindow?.webContents.send(IPC_CHANNELS.CONFIG_CHANGED, makeRendererConfigPayload());
      void refreshManager?.refresh(false);
    }
    return result;
  } finally {
    codexAccountOperationInFlight = false;
    rebuildTrayMenu();
  }
}

function importCodexAccountFromPicker(): Promise<CodexAccountOperationResult> {
  const dialogOptions: OpenDialogOptions = {
    title: 'Import Codex auth.json',
    properties: ['openFile'],
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
  };
  return runCodexAccountOperation(async () => {
    const selected = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (selected.canceled || selected.filePaths.length === 0) {
      return {
        ok: false,
        message: 'Import canceled.',
        state: getCodexAccountState(currentConfig),
        config: currentConfig,
      };
    }

    return importCodexAccount(currentConfig, selected.filePaths[0]);
  });
}

function refreshAll(): void {
  void refreshManager?.refresh();
  void accountUsagePoller?.refresh();
}

function persistConfig(): void {
  saveConfig(currentConfig);
}

function makeRendererConfigPayload() {
  const enabledProviders: Record<string, boolean> = {};
  for (const provider of currentConfig.providers) {
    enabledProviders[provider.id] = provider.enabled ?? false;
  }

  return {
    enabledProviders,
    refreshIntervalMs: (currentConfig.refreshCadenceSeconds || 120) * 1000,
    launchAtStartup: currentConfig.launchAtStartup ?? false,
    codexAccountSwitch: currentConfig.codexAccountSwitch ?? { stopVSCode: false, stopT3Code: false },
    remoteHistory: {
      sshTarget: currentConfig.remoteHistory?.sshTarget || '',
      codexHome: currentConfig.remoteHistory?.codexHome || '~/.codex',
      claudeHome: currentConfig.remoteHistory?.claudeHome || '~/.claude',
    },
    providerMetadata: getAllMetadata(),
    codexAccountState: getCodexAccountState(currentConfig),
    claudeAccountState: getClaudeAccountState(currentConfig),
  };
}

app.on('ready', () => {
  currentConfig = reconcileCodexAccountsConfig(loadConfig());
  createTray();
  mainWindow = createMainWindow();
  screen.on('display-added', positionWindow);
  screen.on('display-removed', positionWindow);
  screen.on('display-metrics-changed', positionWindow);
  setupIPC();

  accountUsagePoller = new AccountUsagePoller(currentConfig, (summaries) => {
    mainWindow?.webContents.send(IPC_CHANNELS.ACCOUNT_USAGE_UPDATE, summaries);
  });
  refreshManager = new RefreshManager(
    currentConfig,
    (data) => {
      mainWindow?.webContents.send(IPC_CHANNELS.USAGE_UPDATE, data);
      updateTrayIcon(data);
      accountUsagePoller?.recordActive(data);
    },
    () => {
      mainWindow?.webContents.send(IPC_CHANNELS.REFRESH_STARTED);
    },
    () => {
      mainWindow?.webContents.send(IPC_CHANNELS.REFRESH_COMPLETED);
    },
  );

  refreshManager.start();
  accountUsagePoller.start();
});

app.on('window-all-closed', () => {
  // keep tray app alive
});

app.on('before-quit', (event) => {
  refreshManager?.stop();
  accountUsagePoller?.stop();
  shutdownCodex();
  if (clockAbort && clockJob) {
    event.preventDefault();
    clockAbort.abort();
    void clockJob.then(() => app.quit(), () => app.quit());
  }
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) {
      toggleWindow();
    }
    mainWindow.focus();
  }
});
