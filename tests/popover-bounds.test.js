const test = require('node:test');
const assert = require('node:assert/strict');
const { getPopoverBounds } = require('../dist/main/popover-bounds.js');

test('popover fits each display after docking, DPI changes, and reconnecting', () => {
  const scenarios = [
    { tray: { x: 1800, y: 1040, width: 24, height: 40 }, area: { x: 0, y: 0, width: 1920, height: 1040 }, expected: { x: 1540, y: 476, width: 380, height: 560 } },
    { tray: { x: 1150, y: 680, width: 24, height: 40 }, area: { x: 0, y: 0, width: 1280, height: 680 }, expected: { x: 900, y: 116, width: 380, height: 560 } },
    { tray: { x: 700, y: 480, width: 24, height: 40 }, area: { x: 0, y: 0, width: 800, height: 480 }, expected: { x: 420, y: 0, width: 380, height: 480 } },
    { tray: { x: 260, y: 300, width: 24, height: 40 }, area: { x: 0, y: 0, width: 320, height: 300 }, expected: { x: 0, y: 0, width: 320, height: 300 } },
    { tray: { x: 1800, y: 1040, width: 24, height: 40 }, area: { x: 0, y: 0, width: 1920, height: 1040 }, expected: { x: 1540, y: 476, width: 380, height: 560 } },
  ];
  for (const { tray, area, expected } of scenarios) {
    assert.deepEqual(getPopoverBounds(tray, area), expected);
  }
});

test('popover stays inside displays with negative coordinates and taskbars on any edge', () => {
  const area = { x: -1280, y: -800, width: 1280, height: 760 };
  for (const tray of [
    { x: -1280, y: -40, width: 24, height: 40 },
    { x: -24, y: -40, width: 24, height: 40 },
    { x: -600, y: -840, width: 24, height: 40 },
    { x: -1320, y: -450, width: 40, height: 24 },
    { x: 0, y: -450, width: 40, height: 24 },
  ]) {
    const bounds = getPopoverBounds(tray, area);
    assert.equal(bounds.width, 380);
    assert.equal(bounds.height, 560);
    assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width);
    assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
  }
  assert.equal(getPopoverBounds({ x: -600, y: -840, width: 24, height: 40 }, area).y, -796);
});
