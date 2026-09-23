import { useState } from "react";
import { Button } from "./ui";

// A newly created API key or invite link. It lives only in the creating page's
// state, so it disappears on dismiss or navigation. The server can't show it again.
export function OnceSecret({ label, value, onDismiss }: { label: string; value: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <div role="status" className="rounded-lg border border-accent/40 bg-accent/5 p-4">
      <p className="text-sm font-medium">{label}</p>
      <p className="mb-3 text-sm text-muted">Copy it now. It won't be shown again.</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-bg px-2 py-1.5 font-mono text-sm">{value}</code>
        <Button
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard?.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="secondary" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}
