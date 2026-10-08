import { useEffect, useState } from 'react';
import { ClockState, ClockTarget } from '../../shared/account-clocks';

export function useAccountClocks() {
  const [state, setState] = useState<ClockState>({ busy: false, message: '', results: [] });
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    const unsubscribe = api.onClockStateChanged(setState);
    api.getClockState().then(setState);
    return unsubscribe;
  }, []);
  const start = async (target?: ClockTarget) => {
    setState({ busy: true, message: 'Starting clocks…', results: [] });
    try { setState(await window.electronAPI.startClocks(target)); }
    catch (error) { setState({ busy: false, message: error instanceof Error ? error.message : 'Clock activation failed.', results: [] }); }
  };
  return { state, start };
}
