// The tag rule. The server's ingest schema has its own copy (server/src/tags.ts)
// and the two must match: a tag the client sends but the server rejects loses the
// whole timeline, because the transport never reads the response.
export const TAG_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,49}$/;
export const MAX_TAGS = 10;

/**
 * Trims, lowercases and de-duplicates tags, keeping first-seen order. Invalid
 * tags are dropped and anything past MAX_TAGS is cut, each with a console
 * warning. Never throws.
 */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    console.warn("[tripcord] tags must be an array of strings.");
    return [];
  }
  const result: string[] = [];
  for (const raw of tags) {
    const tag = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!TAG_PATTERN.test(tag)) {
      console.warn(`[tripcord] dropping invalid tag ${JSON.stringify(raw)}: tags must match ${TAG_PATTERN}.`);
      continue;
    }
    if (!result.includes(tag)) {
      result.push(tag);
    }
  }
  if (result.length > MAX_TAGS) {
    console.warn(`[tripcord] a timeline carries at most ${MAX_TAGS} tags; keeping the first ${MAX_TAGS}.`);
    return result.slice(0, MAX_TAGS);
  }
  return result;
}
