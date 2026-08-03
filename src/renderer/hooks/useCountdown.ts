import { useState, useEffect } from 'react';

function formatRemaining(diffMs: number): string {
  if (diffMs <= 0) return 'Expired';

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
  return '< 1m';
}

export function useCountdown(resetAtTimestamp: number | undefined) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (resetAtTimestamp === undefined) return;

    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, [resetAtTimestamp]);

  if (resetAtTimestamp === undefined) {
    return { timeRemaining: '', isExpired: false, isUrgent: false };
  }

  const resetAtMs = resetAtTimestamp * 1000;
  const diffMs = resetAtMs - now;
  const isExpired = diffMs <= 0;
  const isUrgent = !isExpired && diffMs < 30 * 60 * 1000; // < 30 minutes

  return {
    timeRemaining: formatRemaining(diffMs),
    isExpired,
    isUrgent,
  };
}
