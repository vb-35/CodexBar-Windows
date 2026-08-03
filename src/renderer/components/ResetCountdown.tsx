import React from 'react';
import { useCountdown } from '../hooks/useCountdown';

interface ResetCountdownProps {
  resetAt?: number;
  label?: string;
}

export function ResetCountdown({ resetAt, label }: ResetCountdownProps) {
  const { timeRemaining, isExpired, isUrgent } = useCountdown(resetAt);

  if (!resetAt || !timeRemaining) return null;

  const className = [
    'reset-countdown',
    isUrgent ? 'reset-countdown--urgent' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={className}>
      <span>{label || 'Resets in'} {isExpired ? 'now' : timeRemaining}</span>
    </div>
  );
}
