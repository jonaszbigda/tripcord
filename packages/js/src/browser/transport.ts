import type { TimelinePayload } from "../core/types";

export function createSend(endpoint: string, apiKey: string): (payload: TimelinePayload) => void {
  return (payload: TimelinePayload) => {
    fetch(endpoint, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "X-Tripcord-Key": apiKey,
      },
      body: JSON.stringify(payload),
    }).catch((error: unknown) => {
      console.warn("[tripcord] failed to send timeline:", error);
    });
  };
}
