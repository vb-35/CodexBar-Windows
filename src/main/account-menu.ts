import type { MenuItemConstructorOptions } from 'electron';
import type { CodexAccountState } from '../shared/codex-accounts';

export function buildAccountMenu(name: string, state: CodexAccountState, busy: boolean, actions: {
  add: () => unknown;
  import: () => unknown;
  select: (id?: string) => unknown;
  promote: (id: string) => unknown;
}, remoteSyncEnabled = false): MenuItemConstructorOptions {
  return {
    label: `${name} Accounts`,
    submenu: [
      { label: 'Add Account...', enabled: !busy, click: () => { actions.add(); } },
      { label: `Import ${name === 'Claude' ? '.credentials.json' : 'auth.json'}...`, enabled: !busy, click: () => { actions.import(); } },
      { type: 'separator' },
      { label: 'Use For CodexBar', submenu: [
        { label: state.systemAccount ? `CLI: ${state.systemAccount.label}` : `${name} CLI account`, type: 'radio',
          checked: !state.activeAccountId, enabled: !busy, click: () => { actions.select(); } },
        ...state.accounts.filter((account) => account.id !== state.systemAccountId).map((account) => ({
          label: account.label, type: 'radio' as const, checked: account.id === state.activeAccountId,
          enabled: !busy, click: () => { actions.select(account.id); },
        })),
      ] },
      { label: 'Make CLI Account', submenu: state.accounts.length ? state.accounts.map((account) => ({
        label: `${account.label}${account.id === state.systemAccountId ? ' (CLI)' : ''}${account.id === state.activeAccountId ? ' (active)' : ''}`,
        enabled: !busy && (account.id !== state.systemAccountId || remoteSyncEnabled), click: () => { actions.promote(account.id); },
      })) : [{ label: 'No managed accounts', enabled: false }] },
    ],
  };
}
