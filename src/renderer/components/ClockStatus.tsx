import React from 'react';
import { ClockState } from '../../shared/account-clocks';

export function ClockStatus({ state }: { state: ClockState }) {
  if (!state.message) return null;
  return <div className="sheet-note" role="status" aria-live="polite">
    <div>{state.message}</div>
    {state.results.map((result) => <div key={`${result.provider}:${result.accountId}`} className={result.ok ? 'text-muted' : 'clock-error'}>
      {result.label} ({result.provider}): {result.message}
    </div>)}
  </div>;
}
