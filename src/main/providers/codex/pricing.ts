import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CodexPricing {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_cost_per_token: number | null;
  threshold_tokens?: number;
  input_cost_per_token_above_threshold?: number;
  output_cost_per_token_above_threshold?: number;
  cache_read_input_cost_per_token_above_threshold?: number | null;
}

export type CodexPricingTable = Record<string, CodexPricing>;

const PRICING_URL = 'https://developers.openai.com/api/docs/pricing.md';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

function rates(input: number, cached: number | null, output: number, long?: [number, number | null, number]): CodexPricing {
  return {
    input_cost_per_token: input / 1_000_000,
    output_cost_per_token: output / 1_000_000,
    cache_read_input_cost_per_token: cached === null ? null : cached / 1_000_000,
    ...(long ? {
      threshold_tokens: 272_000,
      input_cost_per_token_above_threshold: long[0] / 1_000_000,
      cache_read_input_cost_per_token_above_threshold: long[1] === null ? null : long[1] / 1_000_000,
      output_cost_per_token_above_threshold: long[2] / 1_000_000,
    } : {}),
  };
}

export const FALLBACK_CODEX_PRICING: CodexPricingTable = {
  'gpt-5': rates(1.25, 0.125, 10),
  'gpt-5-codex': rates(1.25, 0.125, 10),
  'gpt-5-mini': rates(0.25, 0.025, 2),
  'gpt-5-nano': rates(0.05, 0.005, 0.4),
  'gpt-5-pro': rates(15, null, 120),
  'gpt-5.1': rates(1.25, 0.125, 10),
  'gpt-5.1-codex': rates(1.25, 0.125, 10),
  'gpt-5.1-codex-max': rates(1.25, 0.125, 10),
  'gpt-5.1-codex-mini': rates(0.25, 0.025, 2),
  'gpt-5.2': rates(1.75, 0.175, 14),
  'gpt-5.2-codex': rates(1.75, 0.175, 14),
  'gpt-5.2-pro': rates(21, null, 168),
  'gpt-5.3-codex': rates(1.75, 0.175, 14),
  'gpt-5.3-codex-spark': rates(0, 0, 0),
  'gpt-5.4': rates(2.5, 0.25, 15, [5, 0.5, 22.5]),
  'gpt-5.4-mini': rates(0.75, 0.075, 4.5),
  'gpt-5.4-nano': rates(0.2, 0.02, 1.25),
  'gpt-5.4-pro': rates(30, null, 180, [60, null, 270]),
  'gpt-5.5': rates(5, 0.5, 30, [10, 1, 45]),
  'gpt-5.5-pro': rates(30, null, 180, [60, null, 270]),
  'gpt-5.6': rates(5, 0.5, 30, [10, 1, 45]),
  'gpt-5.6-sol': rates(5, 0.5, 30, [10, 1, 45]),
  'gpt-5.6-terra': rates(2, 0.2, 12, [4, 0.4, 18]),
  'gpt-5.6-luna': rates(0.2, 0.02, 1.2, [0.4, 0.04, 1.8]),
};

interface PricingCache {
  fetchedAt: number;
  pricing: CodexPricingTable;
}

interface PricingLoadOptions {
  cachePath?: string;
  fetchText?: () => Promise<string>;
  now?: number;
}

let memoryCache: { pricing: CodexPricingTable; refreshAfter: number } | null = null;

export async function loadCodexPricing(options: PricingLoadOptions = {}): Promise<CodexPricingTable> {
  const now = options.now ?? Date.now();
  const useMemory = Object.keys(options).length === 0;
  if (useMemory && memoryCache && now < memoryCache.refreshAfter) return memoryCache.pricing;

  const cachePath = options.cachePath || path.join(os.homedir(), '.codexbar', 'pricing-cache.json');
  const cached = readCache(cachePath);
  if (cached && now - cached.fetchedAt < DAY_MS) {
    const pricing = withFallback(cached.pricing);
    if (useMemory) memoryCache = { pricing, refreshAfter: cached.fetchedAt + DAY_MS };
    return pricing;
  }

  try {
    const markdown = await (options.fetchText || fetchPricingMarkdown)();
    const parsed = parseOpenAIPricingMarkdown(markdown);
    writeCache(cachePath, { fetchedAt: now, pricing: parsed });
    const pricing = withFallback(parsed);
    if (useMemory) memoryCache = { pricing, refreshAfter: now + DAY_MS };
    return pricing;
  } catch (error) {
    const pricing = withFallback(cached?.pricing || {});
    if (useMemory) memoryCache = { pricing, refreshAfter: now + RETRY_MS };
    console.warn('[Codex Pricing] Using cached/bundled pricing:', error instanceof Error ? error.message : String(error));
    return pricing;
  }
}

export function parseOpenAIPricingMarkdown(markdown: string): CodexPricingTable {
  if (!markdown || markdown.length > 2_000_000) throw new Error('Invalid pricing document size');

  const pricing: CodexPricingTable = {};
  const standardRows = tableAfter(markdown, '### Standard pricing data');
  for (const cells of standardRows) {
    if (cells.length < 9 || cells[0] === 'Model') continue;
    const model = cells[0].replace(/\s+\([^)]*context length\)\s*$/i, '').trim();
    const shortInput = pricePerToken(cells[1]);
    const shortCached = pricePerToken(cells[2]);
    const shortOutput = pricePerToken(cells[4]);
    if (!model || shortInput === null || shortOutput === null) continue;

    pricing[model] = {
      input_cost_per_token: shortInput,
      output_cost_per_token: shortOutput,
      cache_read_input_cost_per_token: shortCached,
    };

    const longInput = pricePerToken(cells[5]);
    const longCached = pricePerToken(cells[6]);
    const longOutput = pricePerToken(cells[8]);
    const threshold = cells[0].match(/<(\d+)K\s+context/i);
    if (longInput !== null && longOutput !== null) {
      Object.assign(pricing[model], {
        threshold_tokens: threshold ? Number(threshold[1]) * 1_000 : 272_000,
        input_cost_per_token_above_threshold: longInput,
        output_cost_per_token_above_threshold: longOutput,
        cache_read_input_cost_per_token_above_threshold: longCached,
      });
    }
  }

  const specializedStart = markdown.indexOf('## Specialized models');
  if (specializedStart >= 0) {
    const specialized = markdown.slice(specializedStart);
    for (const cells of tableAfter(specialized, '### Grouped Pricing Table data')) {
      if (cells.length < 5 || cells[0] !== 'Codex') continue;
      const input = pricePerToken(cells[2]);
      const cached = pricePerToken(cells[3]);
      const output = pricePerToken(cells[4]);
      if (cells[1] && input !== null && output !== null) {
        pricing[cells[1]] = {
          input_cost_per_token: input,
          output_cost_per_token: output,
          cache_read_input_cost_per_token: cached,
        };
      }
    }
  }

  if (Object.keys(pricing).filter((model) => model.startsWith('gpt-')).length < 3) {
    throw new Error('Official pricing table format was not recognized');
  }
  return pricing;
}

async function fetchPricingMarkdown(): Promise<string> {
  const response = await fetch(PRICING_URL, {
    headers: { Accept: 'text/markdown' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`OpenAI pricing request failed (${response.status})`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('Pricing response was too large');
  return text;
}

function tableAfter(markdown: string, heading: string): string[][] {
  const headingIndex = markdown.indexOf(heading);
  if (headingIndex < 0) return [];
  const lines = markdown.slice(headingIndex + heading.length).split(/\r?\n/);
  const tableStart = lines.findIndex((line) => line.trim().startsWith('|'));
  if (tableStart < 0) return [];

  const rows: string[][] = [];
  for (const line of lines.slice(tableStart)) {
    if (!line.trim().startsWith('|')) break;
    const cells = line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
    if (!cells.every((cell) => /^:?-+:?$/.test(cell))) rows.push(cells);
  }
  return rows;
}

function pricePerToken(cell: string): number | null {
  if (cell.trim().toLowerCase() === 'free') return 0;
  const match = cell.replace(/,/g, '').match(/\$([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const value = Number(match[1]) / 1_000_000;
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function readCache(cachePath: string): PricingCache | null {
  try {
    if (!fs.existsSync(cachePath) || fs.statSync(cachePath).size > 2_000_000) return null;
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as PricingCache;
    const pricing = sanitizePricingTable(cache.pricing);
    return Number.isFinite(cache.fetchedAt) && pricing ? { fetchedAt: cache.fetchedAt, pricing } : null;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, cache: PricingCache): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
  } catch (error) {
    console.warn('[Codex Pricing] Could not save pricing cache:', error instanceof Error ? error.message : String(error));
  }
}

function sanitizePricingTable(value: unknown): CodexPricingTable | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const clean: CodexPricingTable = {};
  for (const [model, raw] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(model) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Partial<CodexPricing>;
    if (!validRate(item.input_cost_per_token) || !validRate(item.output_cost_per_token)) continue;
    if (item.cache_read_input_cost_per_token !== null && !validRate(item.cache_read_input_cost_per_token)) continue;
    const entry: CodexPricing = {
      input_cost_per_token: item.input_cost_per_token,
      output_cost_per_token: item.output_cost_per_token,
      cache_read_input_cost_per_token: item.cache_read_input_cost_per_token,
    };
    if (
      Number.isInteger(item.threshold_tokens) && item.threshold_tokens! > 0 && item.threshold_tokens! <= 10_000_000 &&
      validRate(item.input_cost_per_token_above_threshold) && validRate(item.output_cost_per_token_above_threshold) &&
      (item.cache_read_input_cost_per_token_above_threshold === null || validRate(item.cache_read_input_cost_per_token_above_threshold))
    ) {
      entry.threshold_tokens = item.threshold_tokens;
      entry.input_cost_per_token_above_threshold = item.input_cost_per_token_above_threshold;
      entry.output_cost_per_token_above_threshold = item.output_cost_per_token_above_threshold;
      entry.cache_read_input_cost_per_token_above_threshold = item.cache_read_input_cost_per_token_above_threshold;
    }
    clean[model] = entry;
  }
  return Object.keys(clean).length ? clean : null;
}

function validRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function withFallback(pricing: CodexPricingTable): CodexPricingTable {
  const merged: CodexPricingTable = { ...FALLBACK_CODEX_PRICING };
  for (const [model, item] of Object.entries(pricing)) {
    merged[model] = { ...(merged[model] || {}), ...item } as CodexPricing;
  }
  return merged;
}
