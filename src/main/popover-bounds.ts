import type { Rectangle } from 'electron';

export const POPOVER_SIZE = { width: 380, height: 560 };

export function getPopoverBounds(trayBounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(POPOVER_SIZE.width, workArea.width);
  const height = Math.min(POPOVER_SIZE.height, workArea.height);
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  let y = Math.round(trayBounds.y - height - 4);

  if (y < workArea.y) {
    y = trayBounds.y + trayBounds.height + 4;
  }

  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height));

  return { x, y, width, height };
}
