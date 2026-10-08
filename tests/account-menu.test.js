const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAccountMenu } = require('../dist/main/account-menu.js');

test('both provider menus expose the same controls and dispatch their own account IDs', () => {
  for (const name of ['Codex', 'Claude']) {
    const events = [];
    const state = { accounts: [{ id: 'system-copy', label: 'CLI login' }, { id: `${name}-private`, label: 'Other login' }],
      systemAccountId: 'system-copy', activeAccountId: `${name}-private`, systemAccount: { label: 'CLI login' } };
    const actions = { add: () => events.push('add'), import: () => events.push('import'),
      select: (id) => events.push(['select', id]), promote: (id) => events.push(['promote', id]) };
    const menu = buildAccountMenu(name, state, false, actions);
    assert.equal(menu.label, `${name} Accounts`);
    assert.match(menu.submenu[1].label, name === 'Claude' ? /\.credentials\.json/ : /auth\.json/);
    menu.submenu[0].click(); menu.submenu[1].click();
    const selection = menu.submenu[3].submenu;
    assert.equal(selection.length, 2, 'the CLI copy is not offered twice');
    assert.equal(selection[1].checked, true);
    selection[0].click(); selection[1].click();
    const promotion = menu.submenu[4].submenu;
    assert.equal(promotion[0].enabled, false);
    const retry = buildAccountMenu(name, state, false, actions, true).submenu[4].submenu[0];
    assert.equal(retry.enabled, true, 'the current CLI account can retry remote synchronization');
    promotion[1].click();
    assert.deepEqual(events, ['add', 'import', ['select', undefined], ['select', `${name}-private`], ['promote', `${name}-private`]]);
    const busy = buildAccountMenu(name, state, true, actions);
    assert.equal(busy.submenu[0].enabled, false);
    assert.equal(busy.submenu[1].enabled, false);
    assert.ok(busy.submenu[3].submenu.every((entry) => !entry.enabled));
    assert.ok(busy.submenu[4].submenu.every((entry) => !entry.enabled));
    assert.ok(buildAccountMenu(name, state, true, actions, true).submenu[4].submenu.every((entry) => !entry.enabled));
  }
});
