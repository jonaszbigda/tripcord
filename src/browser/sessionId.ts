import { readSessionId, writeSessionId } from "./storage";

export function getOrCreateSessionId(): string {
  const existing = readSessionId();
  if (existing) return existing;
  const id = crypto.randomUUID();
  writeSessionId(id);
  return id;
}
