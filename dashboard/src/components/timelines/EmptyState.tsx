import { Link } from "react-router";
import { Card, CopyButton } from "../ui";

export function EmptyState({ orgId, projectId }: { orgId: string; projectId: string }) {
  const snippet = [
    `import { init, setTags } from "@tripcord/js";`,
    "",
    "init({",
    `  endpoint: "${window.location.origin}/v1/timeline",`,
    `  apiKey: "<your API key>",`,
    "});",
    "",
    `setTags(["checkout"]); // optional: the area of your app`,
  ].join("\n");

  return (
    <Card className="space-y-4">
      <div className="space-y-1">
        <h2 className="font-medium">No timelines yet</h2>
        <p className="text-sm text-muted">
          Add <code className="font-mono">@tripcord/js</code> to your app and initialize it with a key from the{" "}
          <Link to={`/orgs/${orgId}/projects/${projectId}/keys`} className="text-accent hover:underline">
            Keys tab
          </Link>
          . Timelines show up here as soon as the first one arrives.
        </p>
      </div>
      <pre className="overflow-x-auto rounded-md bg-bg p-3 font-mono text-sm">
        <code>{snippet}</code>
      </pre>
      <CopyButton value={snippet} />
    </Card>
  );
}
