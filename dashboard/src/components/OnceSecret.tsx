import { Button, CopyButton } from "./ui";

// A newly created API key or invite link. It lives only in the creating page's
// state, so it disappears on dismiss or navigation. The server can't show it again.
export function OnceSecret({ label, value, onDismiss }: { label: string; value: string; onDismiss: () => void }) {
  return (
    <div role="status" className="rounded-2xl border border-accent/40 bg-accent/10 p-4 shadow-[0_0_40px_-12px_rgb(255_106_26/0.45)]">
      <p className="text-sm font-medium">{label}</p>
      <p className="mb-3 text-sm text-muted">Copy it now. It won't be shown again.</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-lg bg-bg px-2.5 py-1.5 font-mono text-sm text-amber">{value}</code>
        <CopyButton value={value} />
        <Button variant="secondary" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}
