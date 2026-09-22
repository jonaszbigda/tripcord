import type { TimelineEvent } from "./types";

export interface TimelineBuffer {
  // eslint-disable-next-line no-unused-vars
  push(event: TimelineEvent): void;
  getAll(): TimelineEvent[];
}

export function createBuffer(maxEvents: number, seedEvents: TimelineEvent[] = []): TimelineBuffer {
  let events: TimelineEvent[] = seedEvents.slice(-maxEvents);

  return {
    push(event: TimelineEvent) {
      events = [...events, event].slice(-maxEvents);
    },
    getAll() {
      return events;
    },
  };
}
