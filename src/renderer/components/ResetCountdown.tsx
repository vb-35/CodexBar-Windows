import React from 'react';
import { useCountdown } from '../hooks/useCountdown';
import { Icon } from './Icon';

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
    <div className={className} title={`${label || 'Resets in'} ${isExpired ? 'now' : timeRemaining}`} aria-label={`${label || 'Resets in'} ${isExpired ? 'now' : timeRemaining}`}>
      <Icon name="clock" size={13} />
      <span>{isExpired ? 'now' : timeRemaining}</span>
    </div>
  );
}
