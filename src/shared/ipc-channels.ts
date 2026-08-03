/**
 * IPC channel names shared between main and renderer processes.
 */
export const enum IPC_CHANNELS {
  REFRESH_REQUEST = 'codexbar:refresh-request',
  USAGE_UPDATE = 'codexbar:usage-update',
  REFRESH_STARTED = 'codexbar:refresh-started',
  REFRESH_COMPLETED = 'codexbar:refresh-completed',
  CONFIG_GET = 'codexbar:config-get',
  CONFIG_SET = 'codexbar:config-set',
  CONFIG_CHANGED = 'codexbar:config-changed',
  OPEN_EXTERNAL = 'codexbar:open-external',
  QUIT_APP = 'codexbar:quit-app',
  CODEX_ACCOUNTS_GET = 'codexbar:codex-accounts-get',
  CODEX_ACCOUNT_ADD = 'codexbar:codex-account-add',
  CODEX_ACCOUNT_IMPORT = 'codexbar:codex-account-import',
  CODEX_ACCOUNT_SELECT_ACTIVE = 'codexbar:codex-account-select-active',
  CODEX_ACCOUNT_PROMOTE_SYSTEM = 'codexbar:codex-account-promote-system',
  CODEX_ACCOUNT_REAUTH = 'codexbar:codex-account-reauth',
  CODEX_ACCOUNT_REMOVE = 'codexbar:codex-account-remove',
  NAVIGATE = 'codexbar:navigate',
  WINDOW_VISIBILITY = 'codexbar:window-visibility',
}
