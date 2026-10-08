export type ClockProvider = 'codex' | 'claude';

export interface ClockTarget {
  provider: ClockProvider;
  accountId: string;
}

export interface ClockResult extends ClockTarget {
  label: string;
  ok: boolean;
  message: string;
}

export interface ClockState {
  busy: boolean;
  message: string;
  results: ClockResult[];
}
