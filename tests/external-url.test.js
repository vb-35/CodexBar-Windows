const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isAllowedExternalUrl } = require('../dist/shared/external-url');

test('external links allow known HTTPS hosts only', () => {
  assert.equal(isAllowedExternalUrl('https://github.com/openai/codex'), true);
  assert.equal(isAllowedExternalUrl('http://github.com/openai/codex'), false);
  assert.equal(isAllowedExternalUrl('https://github.com@example.com/'), false);
  assert.equal(isAllowedExternalUrl('file:///C:/Windows/System32/calc.exe'), false);
  assert.equal(isAllowedExternalUrl('https://example.com/'), false);
});

test('production renderer has a strict local-only content security policy', () => {
  const html = fs.readFileSync(path.join(__dirname, '../dist/renderer/index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
});

test('sandboxed preload has no relative runtime imports', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../dist/main/preload.js'), 'utf8');
  assert.doesNotMatch(preload, /require\(["']\.\.?\//);
  assert.match(preload, /codexbar:codex-account-import/);
});
