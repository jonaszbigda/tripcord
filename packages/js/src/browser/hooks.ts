import type { Tracer } from "../core/tracer";

interface ErrorDescription {
  message: string;
  name?: string;
}

// "Uncaught TypeError: x" (the browser's ErrorEvent.message) or "TypeError: x".
const PREFIXED = /^(?:Uncaught\s+)?(?:([A-Za-z_$][\w$]*Error):\s*)?([\s\S]*)$/;

function fromText(text: string): ErrorDescription {
  const [, name, message] = PREFIXED.exec(text) ?? [];
  return { message: message ?? text, name };
}

// The thrown value itself, when it's an Error, has the bare message and its
// name. Only without one (a cross-origin "Script error.", a thrown string)
// does the prefix get parsed out of the text.
function describe(value: unknown, fallbackText: string): ErrorDescription {
  if (value instanceof Error) {
    return { message: value.message, name: value.name };
  }
  return fromText(fallbackText);
}

export function attachErrorHooks(tracer: Tracer): () => void {
  function onError(event: ErrorEvent): void {
    const { message, name } = describe(event.error, event.message);
    tracer.captureError(message, name);
  }
  function onRejection(event: PromiseRejectionEvent): void {
    const { message, name } = describe(event.reason, String(event.reason));
    tracer.captureUnhandledRejection(message, name);
  }
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

const TRACE_ATTRIBUTE = "data-trace";

export function attachTraceAttributeListener(tracer: Tracer): () => void {
  function onClick(event: MouseEvent): void {
    const target = event.target as Element | null;
    const el = target?.closest(`[${TRACE_ATTRIBUTE}]`);
    if (!el) return;
    const label = el.getAttribute(TRACE_ATTRIBUTE);
    if (label) tracer.traceElement(label);
  }
  document.addEventListener("click", onClick, { capture: true });
  return () => {
    document.removeEventListener("click", onClick, { capture: true });
  };
}
