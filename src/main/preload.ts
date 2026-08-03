/**
 * Preload script — exposes a safe API from the main process to the renderer.
 * Runs in the renderer's context but with access to Node.js and Electron APIs.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';

contextBridge.exposeInMainWorld('electronAPI', {
  onUsageUpdate: (callback: (data: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.USAGE_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.USAGE_UPDATE, handler);
  },

  onRefreshStarted: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.REFRESH_STARTED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.REFRESH_STARTED, handler);
  },

  onRefreshCompleted: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.REFRESH_COMPLETED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.REFRESH_COMPLETED, handler);
  },

  requestRefresh: () => {
    ipcRenderer.send(IPC_CHANNELS.REFRESH_REQUEST);
  },

  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET),
  setConfig: (config: Record<string, unknown>) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET, config),
  getCodexAccounts: () => ipcRenderer.invoke(IPC_CHANNELS.CODEX_ACCOUNTS_GET),
  addCodexAccount: () => ipcRenderer.invoke(IPC_CHANNELS.CODEX_ACCOUNT_ADD),
  importCodexAccount: () => ipcRenderer.invoke(IPC_CHANNELS.CODEX_ACCOUNT_IMPORT),
  setActiveCodexAccount: (accountId?: string) => ipcRenderer.invoke(IPC_CHANNELS.CODEX_ACCOUNT_SELECT_ACTIVE, accountId),
  promoteCodexAccountToSystem: (accountId: string) => ipcRenderer.invoke(IPC_CHANNELS.CODEX_ACCOUNT_PROMOTE_SYSTEM, accountId),
  reauthenticateCodexAccount: (accountId: string) => ipcRenderer.invoke(IPC_CHANNELS.CODEX_ACCOUNT_REAUTH, accountId),
  removeCodexAccount: (accountId: string) => ipcRenderer.invoke(IPC_CHANNELS.CODEX_ACCOUNT_REMOVE, accountId),

  openExternal: (url: string) => {
    ipcRenderer.send(IPC_CHANNELS.OPEN_EXTERNAL, url);
  },

  quitApp: () => {
    ipcRenderer.send(IPC_CHANNELS.QUIT_APP);
  },
});
