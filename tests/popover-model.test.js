const test = require('node:test');
const assert = require('node:assert/strict');

const popoverModel = require('../dist/shared/popover-model.js');

test('default tab prefers active managed account, then system', () => {
  const stateWithActive = {
    accounts: [{ id: 'managed-1', label: 'Managed One', source: 'managed' }],
    activeAccountId: 'managed-1',
    systemAccountId: undefined,
    systemAccount: { label: 'system@example.com', authFingerprint: 'sys' },
    missingSystemAuth: false,
  };

  assert.equal(popoverModel.getDefaultAccountTabId(stateWithActive), 'managed-1');

  const stateWithoutActive = {
    accounts: [],
    activeAccountId: undefined,
    systemAccountId: undefined,
    systemAccount: { label: 'system@example.com', authFingerprint: 'sys' },
    missingSystemAuth: false,
  };

  assert.equal(popoverModel.getDefaultAccountTabId(stateWithoutActive), 'system');
});

test('account tabs include system and managed accounts in order', () => {
  const tabs = popoverModel.buildAccountTabs({
    accounts: [
      { id: 'managed-1', label: 'Managed One', email: 'managed@example.com', source: 'managed' },
    ],
    activeAccountId: 'managed-1',
    systemAccountId: undefined,
    systemAccount: { label: 'system@example.com', authFingerprint: 'sys' },
    missingSystemAuth: false,
  });

  assert.deepEqual(tabs.map((tab) => tab.id), ['system', 'managed-1']);
  assert.equal(tabs[1].label, 'managed@example.com');
});

test('account tabs merge a managed account matching the system email', () => {
  const state = {
    accounts: [{ id: 'managed-1', label: 'user@example.com - workspace-wsl', email: 'user@example.com', source: 'managed' }],
    activeAccountId: 'managed-1',
    systemAccountId: 'managed-1',
    systemAccount: { label: 'user@example.com - workspace-windows', email: 'user@example.com', authFingerprint: 'sys' },
    missingSystemAuth: false,
  };

  assert.deepEqual(popoverModel.buildAccountTabs(state).map((tab) => tab.id), ['system']);
  assert.equal(popoverModel.getDefaultAccountTabId(state), 'system');
});

test('section visibility trims empty placeholders', () => {
  const empty = popoverModel.getProviderSectionVisibility({
    providerId: 'codex',
    displayName: 'Codex',
    iconColor: '#49a3b0',
  });
  assert.equal(empty.hasAnyData, false);
  assert.equal(empty.showPrimary, false);
  assert.equal(empty.showHistory, false);

  const withData = popoverModel.getProviderSectionVisibility({
    providerId: 'codex',
    displayName: 'Codex',
    iconColor: '#49a3b0',
    primary: { usedPercent: 10, resetAt: 1, limitWindowSeconds: 1, label: 'Session' },
    resetCredits: { availableCount: 2, credits: [] },
    history: {
      local: {
        today: { tokensUsed: 1, requestsCount: 1, estimatedCostUSD: 1 },
        yesterday: { tokensUsed: 1, requestsCount: 1, estimatedCostUSD: 1 },
        week: { tokensUsed: 1, requestsCount: 1, estimatedCostUSD: 1 },
        month30: { tokensUsed: 1, requestsCount: 1, estimatedCostUSD: 1 },
      },
    },
  });

  assert.equal(withData.hasAnyData, true);
  assert.equal(withData.showPrimary, true);
  assert.equal(withData.showResetCredits, true);
  assert.equal(withData.showHistory, true);
});
