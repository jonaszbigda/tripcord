import { useParams } from "react-router";
import { SERIES } from "../components/charts/series";
import { VolumeChart } from "../components/charts/VolumeChart";
import { EmptyState } from "../components/timelines/EmptyState";
import { FilterBar } from "../components/timelines/FilterBar";
import { TimelineList } from "../components/timelines/TimelineList";
import { TopReasons } from "../components/timelines/TopReasons";
import { Button, Card, ErrorText } from "../components/ui";
import { useTimelineSummary, useTimelineTags, useTimelines } from "../queries";
import { useTimelineFilters } from "../timelineFilters";

export function TimelinesPage() {
  const { orgId = "", projectId = "" } = useParams();
  const [filters, setFilters] = useTimelineFilters();
  const summary = useTimelineSummary(orgId, projectId, filters);
  const tags = useTimelineTags(orgId, projectId, filters.range);
  const list = useTimelines(orgId, projectId, filters);

  if (summary.data && !summary.data.projectHasTimelines) {
    return <EmptyState orgId={orgId} projectId={projectId} />;
  }

  // Colors follow the reason type, so hiding one never repaints the others.
  const series = SERIES.filter((s) => filters.reasonTypes.length === 0 || filters.reasonTypes.includes(s.key));
  const topReasons = summary.data?.topReasons ?? [];
  const timelines = list.data?.pages.flatMap((page) => page.timelines) ?? [];

  return (
    <div className="space-y-6">
      <FilterBar
        filters={filters}
        onChange={setFilters}
        tags={tags.data ?? []}
        selectedReason={topReasons.find((r) => r.key === filters.reason)}
      />

      <Card className="space-y-4">
        <h2 className="font-medium">Volume</h2>
        <ErrorText error={summary.error} />
        {summary.data && <VolumeChart summary={summary.data} series={series} />}
      </Card>

      <Card className="space-y-3">
        <h2 className="font-medium">Top reasons</h2>
        {summary.data && (
          <TopReasons reasons={topReasons} selected={filters.reason} onSelect={(reason) => setFilters({ reason })} />
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="font-medium">Timelines</h2>
        <ErrorText error={list.error} />
        {list.data && <TimelineList orgId={orgId} projectId={projectId} timelines={timelines} />}
        {list.hasNextPage && (
          <Button variant="secondary" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
      </Card>
    </div>
  );
}
