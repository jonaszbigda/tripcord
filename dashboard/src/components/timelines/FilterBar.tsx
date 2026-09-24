import { REASON_LABELS } from "../../format";
import { RANGES, REASON_TYPES, type TimelineFilters } from "../../timelineFilters";
import type { ReasonType, TagCount, TopReason } from "../../types";
import { SERIES_COLORS } from "../charts/series";
import { Chip, Segmented, Swatch } from "../ui";
import { TagPicker } from "./TagPicker";
import { reasonText } from "./TopReasons";

export function FilterBar({
  filters,
  onChange,
  tags,
  selectedReason,
}: {
  filters: TimelineFilters;
  onChange: (changes: Partial<TimelineFilters>) => void;
  tags: TagCount[];
  /** The top reason matching filters.reason, if it's in the current top 10. */
  selectedReason: TopReason | undefined;
}) {
  const toggleType = (type: ReasonType) => {
    const next = filters.reasonTypes.includes(type)
      ? filters.reasonTypes.filter((t) => t !== type)
      : [...filters.reasonTypes, type];
    // All three is the same as none; keep one URL for it.
    onChange({ reasonTypes: next.length === REASON_TYPES.length ? [] : REASON_TYPES.filter((t) => next.includes(t)) });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Time range"
          options={RANGES.map((range) => [range, range] as const)}
          value={filters.range}
          onChange={(range) => onChange({ range })}
        />
        <div role="group" aria-label="Reason types" className="flex flex-wrap gap-1">
          {REASON_TYPES.map((type) => {
            const on = filters.reasonTypes.includes(type);
            return (
              <button
                key={type}
                type="button"
                aria-pressed={on}
                onClick={() => toggleType(type)}
                className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-sm transition ${on ? "border-fg/30 bg-raised font-medium text-fg" : "border-border bg-surface text-muted hover:text-fg"}`}
              >
                <Swatch color={SERIES_COLORS[type]} />
                {REASON_LABELS[type]}
              </button>
            );
          })}
        </div>
        <TagPicker tags={tags} selected={filters.tags} onChange={(next) => onChange({ tags: next })} />
      </div>
      {(filters.reason || filters.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {filters.reason && (
            <Chip onRemove={() => onChange({ reason: null })} removeLabel="Clear reason filter">
              <span className="max-w-64 truncate">Reason: {selectedReason ? reasonText(selectedReason) : "selected"}</span>
            </Chip>
          )}
          {filters.tags.map((tag) => (
            <Chip
              key={tag}
              onRemove={() => onChange({ tags: filters.tags.filter((t) => t !== tag) })}
              removeLabel={`Remove tag ${tag}`}
            >
              <span className="font-mono">{tag}</span>
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
