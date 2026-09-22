import type { TimelineEvent } from "../core/types";

const BUFFER_KEY = "__repro_buffer";
const SESSION_ID_KEY = "__repro_session_id";

export function readBuffer(): TimelineEvent[] | undefined {
  try {
    const raw = sessionStorage.getItem(BUFFER_KEY);
    return raw ? (JSON.parse(raw) as TimelineEvent[]) : undefined;
  } catch {
    return undefined;
  }
}

export function writeBuffer(events: TimelineEvent[]): void {
  try {
    sessionStorage.setItem(BUFFER_KEY, JSON.stringify(events));
  } catch {
    // best-effort persistence only
  }
}

export function readSessionId(): string | undefined {
  try {
    return sessionStorage.getItem(SESSION_ID_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeSessionId(id: string): void {
  try {
    sessionStorage.setItem(SESSION_ID_KEY, id);
  } catch {
    // best-effort persistence only
  }
}
