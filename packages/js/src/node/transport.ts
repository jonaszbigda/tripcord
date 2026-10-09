import type { TimelineEvent } from "../core/types";

/**
 * A fire-and-forget POST. It never rejects — a failed send is logged and
 * dropped, like the browser transport — but the promise is exposed so a server
 * can `flush()` and know delivery settled.
 */
export type Sender = (body: unknown) => Promise<void>;

export function createJsonSend(url: string, apiKey: string, inFlight: Set<Promise<void>>): Sender {
  return (body) => {
    const promise = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tripcord-Key": apiKey,
      },
      body: JSON.stringify(body),
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        console.warn("[tripcord] failed to send:", error);
      });
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
    return promise;
  };
}

export interface StageBody {
  sessionId: string;
  events: TimelineEvent[];
}
