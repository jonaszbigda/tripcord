const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * Parses a duration like "30s", "15m", "24h" or "7d" into milliseconds. Throws
 * on anything else, so a misconfigured `STAGING_TTL` fails at startup.
 */
export function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration "${value}" (expected e.g. "30s", "15m", "24h", "7d")`);
  }
  return Number(match[1]) * UNITS[match[2] as keyof typeof UNITS];
}
