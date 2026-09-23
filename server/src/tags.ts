// Must match TAG_PATTERN and MAX_TAGS in packages/js/src/core/tags.ts. The
// client normalizes tags to this rule before sending, so a real client never
// hits the 400 that this schema produces.
export const TAG_PATTERN_SOURCE = "^[a-z0-9][a-z0-9_.:-]{0,49}$";
export const MAX_TAGS = 10;

export const tagSchema = { type: "string", pattern: TAG_PATTERN_SOURCE } as const;
