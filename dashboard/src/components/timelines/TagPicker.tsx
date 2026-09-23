import type { TagCount } from "../../types";

export function TagPicker({
  tags,
  selected,
  onChange,
}: {
  tags: TagCount[];
  selected: string[];
  onChange: (tags: string[]) => void;
}) {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-md border border-border bg-surface px-3 py-1 text-sm">
        {selected.length > 0 ? `Tags (${selected.length})` : "Tags"}
      </summary>
      <div className="absolute z-10 mt-1 max-h-64 w-60 overflow-auto rounded-md border border-border bg-surface p-2 shadow-sm">
        {tags.length === 0 ? (
          <p className="px-1 text-sm text-muted">No tags in this range.</p>
        ) : (
          tags.map(({ tag, count }) => (
            <label key={tag} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-bg">
              <input
                type="checkbox"
                checked={selected.includes(tag)}
                onChange={(event) =>
                  onChange(event.target.checked ? [...selected, tag] : selected.filter((t) => t !== tag))
                }
              />
              <span className="font-mono">{tag}</span>
              <span className="ml-auto tabular-nums text-muted">{count}</span>
            </label>
          ))
        )}
      </div>
    </details>
  );
}
