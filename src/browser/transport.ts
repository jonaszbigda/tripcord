import type { TimelinePayload } from "../core/types";

export function createSend(endpoint: string, apiKey: string): (payload: TimelinePayload) => void {
  return (payload: TimelinePayload) => {
    fetch(endpoint, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "X-Repro-Key": apiKey,
      },
      body: JSON.stringify(payload),
    }).catch((error: unknown) => {
      console.warn("[repro] failed to send timeline:", error);
    });
  };
}
