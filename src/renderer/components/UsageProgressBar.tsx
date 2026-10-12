import React from 'react';

interface UsageProgressBarProps {
  percent: number;
  label?: string;
  thresholds?: number[];
  isRemaining?: boolean;
  leftLabel?: string;
  rightLabel?: string;
  hideLabel?: boolean;
}

export function getTone(percent: number, isRemaining: boolean): 'good' | 'warn' | 'bad' {
  if (isRemaining) {
    if (percent <= 20) return 'bad';
    if (percent <= 50) return 'warn';
    return 'good';
  }

  if (percent >= 80) return 'bad';
  if (percent >= 50) return 'warn';
  return 'good';
}

export function UsageProgressBar({
  percent,
  label,
  thresholds,
  isRemaining = false,
  leftLabel,
  rightLabel,
  hideLabel = false,
}: UsageProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const tone = getTone(clamped, isRemaining);

  return (
    <div className="usage-bar-wrapper">
      {!hideLabel && (label || leftLabel || rightLabel) && (
        <div className="usage-bar-copy">
          <span className="usage-bar-copy-left">{label || leftLabel}</span>
          {rightLabel && <span className="usage-bar-copy-right">{rightLabel}</span>}
        </div>
      )}

      <div className="usage-bar-track" role="progressbar" aria-label={label || leftLabel || 'Usage'} aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
        <div className={`usage-bar-fill usage-bar-fill--${tone}`} style={{ width: `${clamped}%` }} />
        {(thresholds || []).map((threshold) => (
          <span key={threshold} className="usage-bar-tick" style={{ left: `${threshold}%` }} />
        ))}
      </div>
    </div>
  );
}
