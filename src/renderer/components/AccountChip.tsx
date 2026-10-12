import React, { useEffect, useState } from 'react';
import {
  AccountUsageSummary,
  PopoverUsageWindow,
  formatSessionCountdown,
  getRemainingPercent,
} from '../../shared/popover-model';
import { getTone } from './UsageProgressBar';

interface AccountChipProps {
  label: string;
  title: string;
  usage?: AccountUsageSummary;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}

// Outer ring tracks the 5h session, inner ring the weekly window.
const RINGS = { session: 18.3, weekly: 14.6 } as const;

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function Ring({ radius, window, now }: { radius: number; window?: PopoverUsageWindow; now: number }) {
  if (!window) return null;
  const remaining = getRemainingPercent(window, now);
  return (
    <>
      <circle className="account-ring-track" cx="20" cy="20" r={radius} />
      {remaining > 0 && (
        <circle className={`account-ring account-ring--${getTone(remaining, true)}`} cx="20" cy="20" r={radius}
          pathLength={100} strokeDasharray={`${remaining} 100`} />
      )}
    </>
  );
}

export function AccountChip({ label, title, usage, active, disabled, onClick }: AccountChipProps) {
  const now = useNow(Boolean(usage?.session || usage?.weekly));
  const countdown = formatSessionCountdown(usage?.session, now);
  const details = [
    usage?.session && `Session ${Math.round(getRemainingPercent(usage.session, now))}% left${countdown ? `, resets in ${countdown}` : ''}`,
    usage?.weekly && `Weekly ${Math.round(getRemainingPercent(usage.weekly, now))}% left`,
  ].filter(Boolean).join(' · ');
  const description = details ? `${title} — ${details}` : title;

  return (
    <div className="account-chip">
      <button
        className="account-chip-button"
        onClick={onClick}
        disabled={disabled}
        title={description}
        aria-label={description}
        aria-pressed={active}
      >
        <svg className="account-rings" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
          <Ring radius={RINGS.session} window={usage?.session} now={now} />
          <Ring radius={RINGS.weekly} window={usage?.weekly} now={now} />
        </svg>
        <span className={`top-chip ${active ? 'top-chip--active' : ''}`}>{label}</span>
      </button>
      <span className={`account-countdown ${active ? 'account-countdown--active' : ''}`} aria-hidden="true">{countdown}</span>
    </div>
  );
}
