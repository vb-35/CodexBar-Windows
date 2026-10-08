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
import { getClaudeAccountState, importClaudeAccount, loginClaudeAccount, removeClaudeAccount, selectClaudeAccount } from './claude-accounts';
import { promoteWithDesktopRestart } from './codex-desktop';
import { shutdownCodex } from './providers/codex';
import { getAllMetadata } from './providers/registry';
import { CodexBarConfig, ProviderDisplayData } from './providers/types';
import { RefreshManager } from './refresh';
import { getPopoverBounds, POPOVER_SIZE } from './popover-bounds';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import { isAllowedExternalUrl } from '../shared/external-url';
import { CodexAccountOperationResult } from '../shared/codex-accounts';

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let refreshManager: RefreshManager | null = null;
let currentConfig: CodexBarConfig;
let codexAccountOperationInFlight = false;

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
  const accountState = getCodexAccountState(currentConfig);
  const systemSubmenu: MenuItemConstructorOptions[] = accountState.accounts.map((account) => ({
    label: formatTrayAccountLabel(account.label, account.id === accountState.systemAccountId, account.id === accountState.activeAccountId),
    enabled: !codexAccountOperationInFlight && account.id !== accountState.systemAccountId,
    click: () => makeSystemAccount(account.id),
  }));

  if (systemSubmenu.length === 0) {
    systemSubmenu.push({ label: 'No managed accounts', enabled: false });
  }

  const activeSubmenu: MenuItemConstructorOptions[] = [
    {
      label: accountState.systemAccount ? `System: ${accountState.systemAccount.label}` : 'System account',
      type: 'radio',
      checked: !accountState.activeAccountId,
      enabled: !codexAccountOperationInFlight,
      click: () => runCodexAccountOperation(() => setActiveCodexAccount(currentConfig, undefined)),
    },
    ...accountState.accounts.map((account) => ({
      label: account.label,
      type: 'radio' as const,
      checked: account.id === accountState.activeAccountId,
      enabled: !codexAccountOperationInFlight,
      click: () => runCodexAccountOperation(() => setActiveCodexAccount(currentConfig, account.id)),
    })),
  ];

  return [
    { label: 'Show CodexBar', click: () => toggleWindow() },
    { type: 'separator' },
    { label: 'Refresh Now', click: () => refreshManager?.refresh() },
    { label: 'Open Codex Dashboard', click: () => shell.openExternal('https://chatgpt.com/codex/settings/usage') },
    { type: 'separator' },
    {
      label: 'Codex Accounts',
      submenu: [
        { label: 'Add Account...', enabled: !codexAccountOperationInFlight, click: () => runCodexAccountOperation(() => addCodexAccountViaLogin(currentConfig)) },
        { label: 'Import auth.json...', enabled: !codexAccountOperationInFlight, click: () => importCodexAccountFromPicker() },
        { type: 'separator' },
        { label: 'Use For CodexBar', submenu: activeSubmenu },
        { label: 'System Account', submenu: systemSubmenu },
      ],
    },
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

function formatTrayAccountLabel(label: string, isSystem: boolean, isActive: boolean): string {
  const tags = [isSystem ? 'system' : '', isActive ? 'active' : ''].filter(Boolean);
  return tags.length > 0 ? `${label} (${tags.join(', ')})` : label;
}

function setupIPC(): void {
  ipcMain.on(IPC_CHANNELS.REFRESH_REQUEST, () => {
    refreshManager?.refresh();
  });

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

    if (updates.remoteHistory && typeof updates.remoteHistory === 'object') {
      const remote = updates.remoteHistory as Record<string, unknown>;
      const sshTarget = typeof remote.sshTarget === 'string' ? remote.sshTarget.trim() : '';
      const codexHome = typeof remote.codexHome === 'string' && remote.codexHome.trim()
        ? remote.codexHome.trim()
        : '~/.codex';
      if (sshTarget && (sshTarget.startsWith('-') || !/^[A-Za-z0-9_.@:\[\]-]+$/.test(sshTarget))) {
        throw new Error('SSH target may contain only a host, alias, user, dots, colons, brackets, and hyphens.');
      }
      currentConfig.remoteHistory = sshTarget ? { sshTarget, codexHome } : undefined;
    }

    persistConfig();
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

  ipcMain.handle(IPC_CHANNELS.CLAUDE_ACCOUNT_ACTION, (_event, action: string, accountId?: string) => {
    if (action === 'get') return getClaudeAccountState(currentConfig);
    return runCodexAccountOperation(async () => {
      if (accountId !== undefined && typeof accountId !== 'string') throw new Error('Invalid Claude account ID.');
      switch (action) {
        case 'add': return loginClaudeAccount(currentConfig);
        case 'select': return selectClaudeAccount(currentConfig, accountId);
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
  });

  ipcMain.on(IPC_CHANNELS.OPEN_EXTERNAL, (_event, url: string) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
  });

  ipcMain.on(IPC_CHANNELS.QUIT_APP, () => {
    shutdownCodex();
    app.quit();
  });
}

function makeSystemAccount(accountId: string): Promise<CodexAccountOperationResult> {
  return runCodexAccountOperation(() => promoteWithDesktopRestart(currentConfig, accountId, async () => {
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Switch ChatGPT account',
      message: 'Are you ready to close ChatGPT?',
      detail: 'ChatGPT will be force closed to switch accounts, then reopened. Finish any ongoing work before continuing.',
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
    remoteHistory: {
      sshTarget: currentConfig.remoteHistory?.sshTarget || '',
      codexHome: currentConfig.remoteHistory?.codexHome || '~/.codex',
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

  refreshManager = new RefreshManager(
    currentConfig,
    (data) => {
      mainWindow?.webContents.send(IPC_CHANNELS.USAGE_UPDATE, data);
      updateTrayIcon(data);
    },
    () => {
      mainWindow?.webContents.send(IPC_CHANNELS.REFRESH_STARTED);
    },
    () => {
      mainWindow?.webContents.send(IPC_CHANNELS.REFRESH_COMPLETED);
    },
  );

  refreshManager.start();
});

app.on('window-all-closed', () => {
  // keep tray app alive
});

app.on('before-quit', () => {
  refreshManager?.stop();
  shutdownCodex();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) {
      toggleWindow();
    }
    mainWindow.focus();
  }
});
