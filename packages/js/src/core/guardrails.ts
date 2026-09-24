const RISKY_KEYS = ["password", "token", "secret", "apiKey", "ssn", "creditCard"];

export function warnOnRiskyKeys(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (RISKY_KEYS.includes(key)) {
      console.warn(
        `[tripcord] event data includes a field called "${key}" — double-check this isn't sensitive before sending it.`
      );
    }
  }
}
