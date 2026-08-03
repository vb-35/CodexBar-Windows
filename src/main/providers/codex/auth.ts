import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CodexOAuthCredentials } from '../types';

export interface CodexAuthFileData {
  credentials: CodexOAuthCredentials;
  raw: Record<string, unknown>;
  authPath: string;
  homePath: string;
  authFingerprint: string;
  email?: string;
  accountId?: string;
}

export function getDefaultCodexHome(): string {
  const envHome = process.env['CODEX_HOME']?.trim();
  if (envHome) return envHome;
  const userProfile = process.env['USERPROFILE'] || process.env['HOME'] || '';
  return path.join(userProfile, '.codex');
}

export function getAuthFilePath(homePath: string = getDefaultCodexHome()): string {
  return path.join(homePath, 'auth.json');
}

export function parseCredentials(json: Record<string, unknown>): CodexOAuthCredentials | null {
  const apiKey = asTrimmedString(json['OPENAI_API_KEY']);
  if (apiKey) {
    return {
      accessToken: apiKey,
      refreshToken: '',
    };
  }

  const tokens = asRecord(json['tokens']);
  if (!tokens) return null;

  const accessToken = stringValue(tokens, 'access_token', 'accessToken');
  const refreshToken = stringValue(tokens, 'refresh_token', 'refreshToken') || '';
  if (!accessToken) return null;

  return {
    accessToken,
    refreshToken,
    idToken: stringValue(tokens, 'id_token', 'idToken') || undefined,
    accountId: stringValue(tokens, 'account_id', 'accountId') || undefined,
    lastRefresh: asTrimmedString(json['last_refresh']) || undefined,
  };
}

export function loadAuthFile(authPath: string): CodexAuthFileData | null {
  if (!fs.existsSync(authPath)) return null;

  try {
    const rawText = fs.readFileSync(authPath, 'utf-8');
    const raw = JSON.parse(rawText) as Record<string, unknown>;
    const credentials = parseCredentials(raw);
    if (!credentials) return null;

    const email = extractEmail(raw, credentials.idToken);
    const accountId = normalizeAccountId(credentials.accountId);
    return {
      credentials,
      raw,
      authPath,
      homePath: path.dirname(authPath),
      authFingerprint: fingerprintAuthText(rawText),
      email: normalizeEmail(email),
      accountId,
    };
  } catch {
    return null;
  }
}

export function loadCredentials(homePath?: string): CodexOAuthCredentials | null {
  const auth = loadAuthFile(getAuthFilePath(homePath));
  return auth?.credentials || null;
}

export function saveCredentials(credentials: CodexOAuthCredentials, homePath?: string): void {
  const authPath = getAuthFilePath(homePath);
  let json: Record<string, unknown> = {};

  try {
    if (fs.existsSync(authPath)) {
      json = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    }
  } catch {
    json = {};
  }

  const tokens: Record<string, string> = {
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
  };
  if (credentials.idToken) tokens['id_token'] = credentials.idToken;
  if (credentials.accountId) tokens['account_id'] = credentials.accountId;

  json['tokens'] = tokens;
  json['last_refresh'] = new Date().toISOString();

  writeAuthJson(authPath, json);
}

export function writeAuthJson(authPath: string, json: Record<string, unknown>): void {
  const dir = path.dirname(authPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(authPath, JSON.stringify(json, null, 2), 'utf-8');
}

export function fingerprintAuthText(rawText: string): string {
  return crypto.createHash('sha256').update(rawText).digest('hex');
}

export function normalizeEmail(value?: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

export function normalizeAccountId(value?: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function deriveIdentityLabel(email?: string, accountId?: string): string {
  if (email && accountId) return `${email} - ${accountId}`;
  if (email) return email;
  if (accountId) return accountId;
  return 'Unknown Codex Account';
}

export function readAuthIdentity(authPath: string): { email?: string; accountId?: string; authFingerprint?: string } | null {
  const auth = loadAuthFile(authPath);
  if (!auth) return null;
  return {
    email: auth.email,
    accountId: auth.accountId,
    authFingerprint: auth.authFingerprint,
  };
}

function extractEmail(raw: Record<string, unknown>, idToken?: string): string | undefined {
  const topLevelEmail = asTrimmedString(raw['email']);
  if (topLevelEmail) return topLevelEmail;

  const user = asRecord(raw['user']);
  const userEmail = user ? asTrimmedString(user['email']) : undefined;
  if (userEmail) return userEmail;

  if (!idToken) return undefined;
  const payload = decodeJWTPayload(idToken);
  return asTrimmedString(payload?.['email']);
}

function decodeJWTPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringValue(obj: Record<string, unknown>, snakeKey: string, camelKey: string): string | null {
  const snake = asTrimmedString(obj[snakeKey]);
  if (snake) return snake;
  const camel = asTrimmedString(obj[camelKey]);
  return camel || null;
}
