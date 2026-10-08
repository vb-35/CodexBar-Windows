// Standard API-equivalent estimates, verified against Anthropic pricing on 2026-10-08.
// https://platform.claude.com/docs/en/about-claude/pricing
// ponytail: bundled rates; update this table when Anthropic changes pricing or adds models.
export interface ClaudePricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWriteHour: number;
  threshold?: number;
  longInput?: number;
  longOutput?: number;
}

function rates(input: number, output: number, cacheMultiplier = 0.1, long?: [number, number, number]): ClaudePricing {
  return { input, output, cacheRead: input * cacheMultiplier, cacheWrite: input * 1.25, cacheWriteHour: input * 2,
    ...(long ? { threshold: long[0], longInput: long[1], longOutput: long[2] } : {}) };
}

export const CLAUDE_PRICING: Record<string, ClaudePricing> = {
  'claude-fable-5-1': rates(10, 50, 0.025), 'claude-mythos-5-1': rates(10, 50, 0.025),
  'claude-fable-5': rates(10, 50), 'claude-mythos-5': rates(10, 50),
  'claude-opus-5-5': rates(4, 20, 0.05), 'claude-sonnet-5-5': rates(2, 10, 0.05),
  'claude-haiku-5-5': rates(0.1, 0.5, 0.1, [100000, 0.5, 2.5]),
  'claude-opus-5': rates(5, 25), 'claude-sonnet-5': rates(2, 10),
  'claude-opus-4-8': rates(5, 25), 'claude-opus-4-7': rates(5, 25),
  'claude-opus-4-6': rates(5, 25), 'claude-opus-4-5': rates(5, 25),
  'claude-opus-4-1': rates(15, 75), 'claude-opus-4': rates(15, 75),
  'claude-sonnet-4-6': rates(3, 15),
  'claude-sonnet-4-5': rates(3, 15, 0.1, [200000, 6, 22.5]),
  'claude-sonnet-4': rates(3, 15, 0.1, [200000, 6, 22.5]),
  'claude-haiku-4-5': rates(1, 5), 'claude-3-5-haiku': rates(0.8, 4),
};

export function normalizeClaudeModel(model: string): string {
  return model.replace(/^anthropic\//, '').replace(/-\d{8}$/, '').replace(/\./g, '-');
}
