const ALLOWED_EXTERNAL_HOSTS = new Set([
  'chatgpt.com',
  'codexbar.app',
  'github.com',
  'status.openai.com',
]);

export function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && ALLOWED_EXTERNAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
