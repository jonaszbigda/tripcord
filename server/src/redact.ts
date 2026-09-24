// Invite (tpi_) and password-reset (tpr_) tokens travel in URLs, and a leaked
// log line must not be a working link. API keys (tpk_) never should, but are
// covered by the same pattern.
const TOKEN = /\btp[a-z]_[A-Za-z0-9_-]+/g;

export function redactTokens(url: string): string {
  return url.replace(TOKEN, (token) => `${token.slice(0, 4)}[redacted]`);
}
