import { Chip } from "../ui";

export function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <Chip key={tag}>
          <span className="font-mono">{tag}</span>
        </Chip>
      ))}
    </span>
  );
}
