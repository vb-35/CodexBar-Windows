import React from 'react';

const paths = {
  back: 'M19 12H5m7-7-7 7 7 7',
  refresh: 'M21 3v5h-5M21 8a9 9 0 1 0 0 8',
  addAccount: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m11-3v6m-3-3h6',
  import: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  system: 'M3 3h18v14H3zM8 21h8m-4-4v4',
  usage: 'M4 20h16M7 16v-5m5 5V4m5 12V8',
  status: 'M2 12h5l3-8 4 16 3-8h5',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  quit: 'M12 2v10m-6-7a9 9 0 1 0 12 0',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 4v5l3 2',
  key: 'M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8m3 7 11 11m-3-3 3-3m-6 0 3-3',
  remove: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  save: 'M20 21H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h13l4 4v13a1 1 0 0 1-1 1M7 3v6h10V3M7 21v-8h10v8',
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={paths[name]} />
    </svg>
  );
}
