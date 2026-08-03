const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const accountsModule = require('../dist/main/codex-accounts.js');

function makeConfig() {
  return {
    version: 1,
    providers: [],
    refreshCadenceSeconds: 120,
    launchAtStartup: false,
  };
}

function writeAuth(filePath, { email, accountId, accessToken = 'access', refreshToken = 'refresh' }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const idToken = encodeJwtPayload({ email });
  fs.writeFileSync(filePath, JSON.stringify({
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  }, null, 2));
}

function encodeJwtPayload(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

function withTempHome(fn) {
  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbar-accounts-'));
  process.env.USERPROFILE = tempRoot;
  process.env.HOME = tempRoot;
  try {
    return fn(tempRoot);
  } finally {
    process.env.USERPROFILE = originalUserProfile;
    process.env.HOME = originalHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('import adds first managed account and marks it active', () => withTempHome((homeRoot) => {
  const importPath = path.join(homeRoot, 'imports', 'auth.json');
  writeAuth(importPath, { email: 'alpha@example.com', accountId: 'workspace-alpha' });

  const result = accountsModule.importCodexAccount(makeConfig(), importPath);
  assert.equal(result.ok, true);
  assert.equal(result.state.accounts.length, 1);
  assert.equal(result.state.activeAccountId, result.state.accounts[0].id);
  assert.equal(result.state.accounts[0].email, 'alpha@example.com');
  assert.equal(result.state.accounts[0].accountId, 'workspace-alpha');
}));

test('dedupe re-import of same email and accountId', () => withTempHome((homeRoot) => {
  const importOne = path.join(homeRoot, 'imports', 'one.json');
  const importTwo = path.join(homeRoot, 'imports', 'two.json');
  writeAuth(importOne, { email: 'alpha@example.com', accountId: 'workspace-alpha', accessToken: 'first' });
  writeAuth(importTwo, { email: 'alpha@example.com', accountId: 'workspace-alpha', accessToken: 'second' });

  const first = accountsModule.importCodexAccount(makeConfig(), importOne);
  const second = accountsModule.importCodexAccount(first.config, importTwo);

  assert.equal(second.state.accounts.length, 1);
  assert.equal(second.state.accounts[0].id, first.state.accounts[0].id);
}));

test('same email with different accountId merges', () => withTempHome((homeRoot) => {
  const importOne = path.join(homeRoot, 'imports', 'one.json');
  const importTwo = path.join(homeRoot, 'imports', 'two.json');
  writeAuth(importOne, { email: 'alpha@example.com', accountId: 'workspace-alpha' });
  writeAuth(importTwo, { email: 'alpha@example.com', accountId: 'workspace-beta' });

  const first = accountsModule.importCodexAccount(makeConfig(), importOne);
  const second = accountsModule.importCodexAccount(first.config, importTwo);

  assert.equal(second.state.accounts.length, 1);
  assert.equal(second.state.accounts[0].id, first.state.accounts[0].id);
}));

test('different emails with the same accountId remain distinct', () => withTempHome((homeRoot) => {
  const importOne = path.join(homeRoot, 'imports', 'one.json');
  const importTwo = path.join(homeRoot, 'imports', 'two.json');
  writeAuth(importOne, { email: 'alpha@example.com', accountId: 'shared-workspace' });
  writeAuth(importTwo, { email: 'beta@example.com', accountId: 'shared-workspace' });

  const first = accountsModule.importCodexAccount(makeConfig(), importOne);
  const second = accountsModule.importCodexAccount(first.config, importTwo);

  assert.equal(second.state.accounts.length, 2);
}));

test('reconcile merges duplicate email while retaining the active copy', () => withTempHome((homeRoot) => {
  const firstHome = path.join(homeRoot, '.codexbar', 'codex-accounts', 'first');
  const activeHome = path.join(homeRoot, '.codexbar', 'codex-accounts', 'active');
  writeAuth(path.join(firstHome, 'auth.json'), { email: 'Alpha@Example.com', accountId: 'workspace-alpha' });
  writeAuth(path.join(activeHome, 'auth.json'), { email: 'alpha@example.com', accountId: 'workspace-beta' });

  const config = {
    ...makeConfig(),
    codexAccounts: {
      activeAccountId: 'active',
      accounts: [
        { id: 'first', source: 'managed', label: 'first', authFingerprint: 'old-1', managedHomePath: firstHome, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        { id: 'active', source: 'managed', label: 'active', authFingerprint: 'old-2', managedHomePath: activeHome, createdAt: '2026-01-02', updatedAt: '2026-01-02' },
      ],
    },
  };

  const reconciled = accountsModule.reconcileCodexAccountsConfig(config);

  assert.equal(reconciled.codexAccounts.accounts.length, 1);
  assert.equal(reconciled.codexAccounts.accounts[0].id, 'active');
  assert.equal(reconciled.codexAccounts.activeAccountId, 'active');
}));

test('invalid import fails without mutating store', () => withTempHome((homeRoot) => {
  const validPath = path.join(homeRoot, 'imports', 'valid.json');
  const invalidPath = path.join(homeRoot, 'imports', 'invalid.json');
  writeAuth(validPath, { email: 'alpha@example.com', accountId: 'workspace-alpha' });
  fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
  fs.writeFileSync(invalidPath, '{"bad":true}');

  const first = accountsModule.importCodexAccount(makeConfig(), validPath);
  const second = accountsModule.importCodexAccount(first.config, invalidPath);

  assert.equal(second.ok, false);
  assert.equal(second.state.accounts.length, 1);
}));

test('active managed account resolves to managed home', () => withTempHome((homeRoot) => {
  const importPath = path.join(homeRoot, 'imports', 'auth.json');
  writeAuth(importPath, { email: 'alpha@example.com', accountId: 'workspace-alpha' });

  const imported = accountsModule.importCodexAccount(makeConfig(), importPath);
  const target = accountsModule.resolveActiveCodexTarget(imported.config);

  assert.equal(target.kind, 'managed');
  assert.match(target.homePath, /codex-accounts/);
}));

test('matching ambient auth remains the default account', () => withTempHome((homeRoot) => {
  const systemAuthPath = path.join(homeRoot, '.codex', 'auth.json');
  writeAuth(systemAuthPath, { email: 'system@example.com', accountId: 'workspace-system' });

  const importPath = path.join(homeRoot, 'imports', 'auth.json');
  writeAuth(importPath, { email: 'system@example.com', accountId: 'workspace-system' });

  const imported = accountsModule.importCodexAccount(makeConfig(), importPath);
  const target = accountsModule.resolveActiveCodexTarget(imported.config);

  assert.equal(imported.state.activeAccountId, undefined);
  assert.equal(target.kind, 'system');
  assert.equal(target.authPath, systemAuthPath);
}));

test('promotion rewrites ambient auth and preserves previous system account', () => withTempHome((homeRoot) => {
  const systemAuthPath = path.join(homeRoot, '.codex', 'auth.json');
  writeAuth(systemAuthPath, { email: 'system@example.com', accountId: 'workspace-system' });

  const importPath = path.join(homeRoot, 'imports', 'auth.json');
  writeAuth(importPath, { email: 'managed@example.com', accountId: 'workspace-managed' });

  const imported = accountsModule.importCodexAccount(makeConfig(), importPath);
  const promoted = accountsModule.promoteCodexAccountToSystem(imported.config, imported.state.accounts[0].id);

  assert.equal(promoted.ok, true);
  const ambient = JSON.parse(fs.readFileSync(systemAuthPath, 'utf-8'));
  assert.equal(ambient.tokens.account_id, 'workspace-managed');
  assert.ok(promoted.state.accounts.some((account) => account.accountId === 'workspace-system'));
  assert.equal(promoted.state.systemAccountId, imported.state.accounts[0].id);
}));
