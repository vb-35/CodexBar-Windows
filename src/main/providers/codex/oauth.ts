/**
 * Codex OAuth provider — fetches usage via the ChatGPT/Codex backend API.
 * Port of CodexOAuthUsageFetcher.swift + CodexOAuthCredentials.swift + CodexTokenRefresher.swift
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import {
  CodexOAuthCredentials,
  CodexTokenRefreshResponse,
  CodexUsageResponse,
  ProviderConfig,
  ProviderFetchResult,
  ResetCredit,
  ResetCreditsInfo,
  UsageSnapshot,
} from '../types';
import { getDefaultCodexHome, loadCredentials, saveCredentials } from './auth';

const REFRESH_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api';
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

function needsRefresh(credentials: CodexOAuthCredentials): boolean {
  if (!credentials.lastRefresh) return true;
  const lastRefresh = new Date(credentials.lastRefresh).getTime();
  if (Number.isNaN(lastRefresh)) return true;
  return Date.now() - lastRefresh > EIGHT_DAYS_MS;
}

export async function refreshToken(credentials: CodexOAuthCredentials): Promise<CodexOAuthCredentials> {
  if (!credentials.refreshToken) return credentials;

  const body = JSON.stringify({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    scope: 'openid profile email',
  });

  const response = await httpPost(REFRESH_ENDPOINT, body, {
    'Content-Type': 'application/json',
  });

  if (response.statusCode !== 200) {
    const errorCode = extractErrorCode(response.body);
    if (errorCode === 'refresh_token_expired' || response.statusCode === 401) {
      throw new Error('Refresh token expired. Run `codex` to log in again.');
    }
    if (errorCode === 'refresh_token_reused') {
      throw new Error('Refresh token was already used. Run `codex` to log in again.');
    }
    if (errorCode === 'invalid_grant' || errorCode === 'refresh_token_invalidated') {
      throw new Error('Refresh token was revoked. Run `codex` to log in again.');
    }
    throw new Error(`Token refresh failed with status ${response.statusCode}`);
  }

  const data = JSON.parse(response.body) as CodexTokenRefreshResponse;
  return {
    accessToken: data.access_token || credentials.accessToken,
    refreshToken: data.refresh_token || credentials.refreshToken,
    idToken: data.id_token || credentials.idToken,
    accountId: credentials.accountId,
    lastRefresh: new Date().toISOString(),
  };
}

function extractErrorCode(body: string): string | null {
  try {
    const json = JSON.parse(body);
    if (typeof json.error === 'object' && json.error?.code) return json.error.code;
    if (typeof json.error === 'string') return json.error;
    if (json.code) return json.code;
  } catch {
    // not JSON
  }
  return null;
}

function resolveUsageURL(codexHome: string): string {
  return resolveBackendURL(codexHome, '/wham/usage', '/api/codex/usage');
}

function resolveResetCreditsURL(codexHome: string): string {
  return resolveBackendURL(codexHome, '/wham/rate-limit-reset-credits', '/api/codex/rate-limit-reset-credits');
}

function resolveBackendURL(codexHome: string, backendApiPath: string, legacyPath: string): string {
  let baseURL = DEFAULT_CHATGPT_BASE_URL;
  const configPath = path.join(codexHome, 'config.toml');

  try {
    if (fs.existsSync(configPath)) {
      const contents = fs.readFileSync(configPath, 'utf-8');
      const parsed = parseChatGPTBaseURL(contents);
      if (parsed) baseURL = parsed;
    }
  } catch {
    // use default
  }

  baseURL = baseURL.trim().replace(/\/+$/, '');
  if ((baseURL.startsWith('https://chatgpt.com') || baseURL.startsWith('https://chat.openai.com'))
    && !baseURL.includes('/backend-api')) {
    baseURL += '/backend-api';
  }

  return `${baseURL}${baseURL.includes('/backend-api') ? backendApiPath : legacyPath}`;
}

function parseChatGPTBaseURL(contents: string): string | null {
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.split('#')[0]?.trim();
    if (!line) continue;
    const parts = line.split('=');
    if (parts.length < 2) continue;
    const key = parts[0]?.trim();
    if (key !== 'chatgpt_base_url') continue;
    let value = parts.slice(1).join('=').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    return value.trim();
  }
  return null;
}

export async function fetchCodexUsage(
  credentials: CodexOAuthCredentials,
  codexHome: string,
): Promise<CodexUsageResponse> {
  const response = await httpGet(resolveUsageURL(codexHome), {
    Authorization: `Bearer ${credentials.accessToken}`,
    'User-Agent': 'CodexBar',
    Accept: 'application/json',
    ...(credentials.accountId ? { 'ChatGPT-Account-Id': credentials.accountId } : {}),
  });

  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new Error('Codex OAuth token expired or invalid. Run `codex` to re-authenticate.');
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Codex API error ${response.statusCode}: ${response.body.slice(0, 200)}`);
  }

  return JSON.parse(response.body) as CodexUsageResponse;
}

interface RawResetCredit {
  status: string;
  granted_at: string;
  expires_at: string;
}

interface RawResetCreditsResponse {
  available_count: number;
  credits?: RawResetCredit[];
}

export async function fetchCodexResetCredits(
  credentials: CodexOAuthCredentials,
  codexHome: string,
): Promise<ResetCreditsInfo | null> {
  try {
    const response = await httpGet(resolveResetCreditsURL(codexHome), {
      Authorization: `Bearer ${credentials.accessToken}`,
      'User-Agent': 'CodexBar',
      Accept: 'application/json',
      originator: 'Codex Desktop',
      'OAI-Product-Sku': 'CODEX',
      ...(credentials.accountId ? { 'ChatGPT-Account-Id': credentials.accountId } : {}),
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      console.warn(`Codex reset-credits API error ${response.statusCode}: ${response.body.slice(0, 200)}`);
      return null;
    }

    const data = JSON.parse(response.body) as RawResetCreditsResponse;
    const credits: ResetCredit[] = (data.credits || []).map((credit) => {
      const mapped: ResetCredit = {
        status: credit.status || '',
        grantedAt: credit.granted_at || '',
        expiresAt: credit.expires_at || '',
      };
      if (credit.expires_at) {
        const parsedDate = new Date(credit.expires_at).getTime();
        if (!Number.isNaN(parsedDate)) {
          mapped.expiresAtTimestamp = Math.floor(parsedDate / 1000);
        }
      }
      return mapped;
    });

    return {
      availableCount: typeof data.available_count === 'number' ? data.available_count : 0,
      credits,
    };
  } catch (error) {
    console.warn('Failed to fetch Codex reset-credits:', error);
    return null;
  }
}

function mapPlanType(raw?: string): string | undefined {
  if (!raw) return undefined;
  const names: Record<string, string> = {
    guest: 'Guest',
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    free_workspace: 'Free Workspace',
    team: 'Team',
    business: 'Business',
    education: 'Education',
    quorum: 'Quorum',
    k12: 'K-12',
    enterprise: 'Enterprise',
    edu: 'Edu',
  };
  return names[raw] || raw;
}

function windowLabel(seconds: number): string {
  const hours = seconds / 3600;
  if (hours <= 6) return 'Session';
  if (hours <= 24 * 7 + 1) return 'Weekly';
  return 'Monthly';
}

export async function fetchViaOAuth(config: ProviderConfig, codexHome?: string): Promise<ProviderFetchResult> {
  const homePath = codexHome || getDefaultCodexHome();
  let credentials = loadCredentials(homePath);
  if (!credentials) {
    return {
      providerId: 'codex',
      error: 'Codex auth.json not found. Run `codex` to log in.',
      fetchedAt: Date.now(),
    };
  }

  try {
    if (needsRefresh(credentials) && credentials.refreshToken) {
      credentials = await refreshToken(credentials);
      saveCredentials(credentials, homePath);
    }

    const response = await fetchCodexUsage(credentials, homePath);
    const resetCredits = await fetchCodexResetCredits(credentials, homePath) || undefined;
    const now = Date.now();

    const usage: UsageSnapshot = {
      updatedAt: now,
      sourceLabel: 'oauth',
      planType: mapPlanType(response.plan_type),
      resetCredits,
    };

    if (response.rate_limit?.primary_window) {
      const window = response.rate_limit.primary_window;
      usage.primary = {
        usedPercent: window.used_percent,
        resetAt: window.reset_at,
        limitWindowSeconds: window.limit_window_seconds,
        label: windowLabel(window.limit_window_seconds),
      };
    }

    if (response.rate_limit?.secondary_window) {
      const window = response.rate_limit.secondary_window;
      usage.secondary = {
        usedPercent: window.used_percent,
        resetAt: window.reset_at,
        limitWindowSeconds: window.limit_window_seconds,
        label: windowLabel(window.limit_window_seconds),
      };
    }

    if (response.credits) {
      const balance = typeof response.credits.balance === 'number'
        ? response.credits.balance
        : typeof response.credits.balance === 'string'
          ? parseFloat(response.credits.balance) || 0
          : 0;
      usage.credits = {
        remaining: balance,
        unlimited: response.credits.unlimited || false,
        updatedAt: now,
      };
    }

    return { providerId: 'codex', usage, fetchedAt: now };
  } catch (error) {
    return {
      providerId: 'codex',
      error: error instanceof Error ? error.message : String(error),
      fetchedAt: Date.now(),
    };
  }
}

interface HttpResponse {
  statusCode: number;
  body: string;
}

function httpGet(url: string, headers: Record<string, string>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers,
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

function httpPost(url: string, body: string, headers: Record<string, string>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body).toString(),
      },
      timeout: 30000,
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk: Buffer) => {
        responseBody += chunk.toString();
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body: responseBody });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.write(body);
    req.end();
  });
}
