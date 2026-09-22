import type { Tracer } from "../core/tracer";

export function attachErrorHooks(tracer: Tracer): () => void {
  function onError(event: ErrorEvent): void {
    tracer.captureError(event.message);
  }
  function onRejection(event: PromiseRejectionEvent): void {
    tracer.captureUnhandledRejection(String(event.reason));
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
