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
  promoteCodexAccountToSystem,
  reauthenticateCodexAccount,
  reconcileCodexAccountsConfig,
  removeCodexAccount,
  setActiveCodexAccount,
} from './codex-accounts';
import { loadConfig, saveConfig } from './config';
import { shutdownCodex } from './providers/codex';
import { getAllMetadata } from './providers/registry';
import { CodexBarConfig, ProviderDisplayData } from './providers/types';
import { RefreshManager } from './refresh';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import { isAllowedExternalUrl } from '../shared/external-url';

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
    width: 380,
    height: 560,
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
  const windowBounds = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const workArea = display.workArea;

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);
  let y = Math.round(trayBounds.y - windowBounds.height - 4);

  if (x < workArea.x) x = workArea.x;
  if (x + windowBounds.width > workArea.x + workArea.width) {
    x = workArea.x + workArea.width - windowBounds.width;
  }
  if (y < workArea.y) {
    y = trayBounds.y + trayBounds.height + 4;
  }

  mainWindow.setPosition(x, y, false);
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
    click: () => runCodexAccountOperation(() => Promise.resolve(promoteCodexAccountToSystem(currentConfig, account.id))),
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
      click: () => runCodexAccountOperation(() => Promise.resolve(setActiveCodexAccount(currentConfig, undefined))),
    },
    ...accountState.accounts.map((account) => ({
      label: account.label,
      type: 'radio' as const,
      checked: account.id === accountState.activeAccountId,
      enabled: !codexAccountOperationInFlight,
      click: () => runCodexAccountOperation(() => Promise.resolve(setActiveCodexAccount(currentConfig, account.id))),
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
    runCodexAccountOperation(() => Promise.resolve(setActiveCodexAccount(currentConfig, accountId))));
  ipcMain.handle(IPC_CHANNELS.CODEX_ACCOUNT_PROMOTE_SYSTEM, (_event, accountId: string) =>
    runCodexAccountOperation(() => Promise.resolve(promoteCodexAccountToSystem(currentConfig, accountId))));
  ipcMain.handle(IPC_CHANNELS.CODEX_ACCOUNT_REAUTH, (_event, accountId: string) =>
    runCodexAccountOperation(() => reauthenticateCodexAccount(currentConfig, accountId)));
  ipcMain.handle(IPC_CHANNELS.CODEX_ACCOUNT_REMOVE, (_event, accountId: string) =>
    runCodexAccountOperation(() => Promise.resolve(removeCodexAccount(currentConfig, accountId))));

  ipcMain.on(IPC_CHANNELS.OPEN_EXTERNAL, (_event, url: string) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
  });

  ipcMain.on(IPC_CHANNELS.QUIT_APP, () => {
    shutdownCodex();
    app.quit();
  });
}

async function runCodexAccountOperation(
  operation: () => Promise<any>,
): Promise<any> {
  codexAccountOperationInFlight = true;
  rebuildTrayMenu();
  try {
    const result = await operation();
    if (result?.config) {
      currentConfig = reconcileCodexAccountsConfig(result.config as CodexBarConfig);
      persistConfig();
      refreshManager?.updateConfig(currentConfig);
      await refreshManager?.refresh();
      mainWindow?.webContents.send(IPC_CHANNELS.CONFIG_CHANGED, makeRendererConfigPayload());
    }
    return result;
  } finally {
    codexAccountOperationInFlight = false;
    rebuildTrayMenu();
  }
}

async function importCodexAccountFromPicker(): Promise<any> {
  const dialogOptions: OpenDialogOptions = {
    title: 'Import Codex auth.json',
    properties: ['openFile'],
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
  };
  codexAccountOperationInFlight = true;
  rebuildTrayMenu();
  try {
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

    return runCodexAccountOperation(() => Promise.resolve(importCodexAccount(currentConfig, selected.filePaths[0])));
  } finally {
    codexAccountOperationInFlight = false;
    rebuildTrayMenu();
  }
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
  };
}

app.on('ready', () => {
  currentConfig = reconcileCodexAccountsConfig(loadConfig());
  createTray();
  mainWindow = createMainWindow();
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
