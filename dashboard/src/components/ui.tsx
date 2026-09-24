import { useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-cord font-semibold text-accent-fg shadow-[0_0_0_1px_rgb(255_150_60/0.4),0_8px_24px_-8px_rgb(255_106_26/0.6)] hover:brightness-110",
  secondary: "border border-border bg-raised text-fg hover:border-muted/50",
  danger: "border border-danger/60 text-danger hover:bg-danger hover:text-accent-fg",
};

export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & {
  label: string;
  value: string;
  onChange: (value: string) => void;
};

export function TextField({ label, value, onChange, className = "", ...props }: TextFieldProps) {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="mb-1.5 block font-medium text-muted">{label}</span>
      <input
        className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-fg outline-none transition placeholder:text-muted/60 focus:border-accent focus:shadow-[0_0_0_3px_rgb(255_122_26/0.18)]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
    </label>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`panel rounded-2xl p-6 ${className}`}>{children}</section>;
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {children}
    </div>
  );
}

export function ErrorText({ error }: { error: Error | null | undefined }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error.message}
    </p>
  ) : null;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}

export function FullPageMessage({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center text-sm text-muted">{children}</div>;
}

/** The logo: a cord that ends in a knot, then the name. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <svg viewBox="0 0 28 16" aria-hidden="true" className="h-[0.8em] w-auto">
        <defs>
          <linearGradient id="wordmark-cord" x1="0" x2="1">
            <stop offset="0" stopColor="var(--color-accent)" />
            <stop offset="1" stopColor="var(--color-amber)" />
          </linearGradient>
        </defs>
        <path d="M1 12 C7 12 8 4 14 4 S20 12 22 12" fill="none" stroke="url(#wordmark-cord)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="24.5" cy="12" r="3" fill="var(--color-ok)" />
      </svg>
      Tripcord
    </span>
  );
}

/** Centered card used by login, signup and invite pages. */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <Wordmark className="mb-8 text-2xl" />
      <Card className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {children}
      </Card>
    </div>
  );
}

/** Two-step button for destructive actions: the first click asks, the second acts. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled = false,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button variant="secondary" disabled={disabled} onClick={() => setConfirming(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="inline-flex gap-2">
      <Button
        variant="danger"
        disabled={disabled}
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button variant="secondary" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}

/** One-of-n buttons, e.g. a time range. Each button reports aria-pressed. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          className={`rounded-md px-2.5 py-1 text-sm transition ${option === value ? "bg-accent/15 font-medium text-accent shadow-[inset_0_0_0_1px_rgb(255_122_26/0.35)]" : "text-muted hover:text-fg"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** A series' color next to its label. Identity never rests on color alone. */
export function Swatch({ color }: { color: string }) {
  return <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: color }} />;
}

export function Chip({ children, onRemove, removeLabel }: { children: ReactNode; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-raised px-2 py-0.5 text-xs">
      {children}
      {onRemove && (
        <button type="button" aria-label={removeLabel} onClick={onRemove} className="text-muted hover:text-fg">
          ×
        </button>
      )}
    </span>
  );
}

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      className={copied ? "border-ok/50 text-ok" : ""}
      onClick={async () => {
        await navigator.clipboard?.writeText(value);
        setCopied(true);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** A destructive action behind typing `expected` (a name or an email) exactly. */
export function TypeToConfirm({
  label,
  expected,
  buttonLabel,
  pending,
  onConfirm,
}: {
  label: string;
  expected: string;
  buttonLabel: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}
    >
      <TextField className="min-w-48 flex-1" label={label} value={typed} onChange={setTyped} autoComplete="off" />
      <Button type="submit" variant="danger" disabled={pending || typed !== expected}>
        {buttonLabel}
      </Button>
    </form>
  );
}
