/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { attachErrorHooks, attachTraceAttributeListener } from "./hooks";
import type { Tracer } from "../core/tracer";

function fakeTracer(): Tracer {
  return {
    track: vi.fn(),
    capture: vi.fn(),
    captureError: vi.fn(),
    captureUnhandledRejection: vi.fn(),
    traceElement: vi.fn(),
    setTags: vi.fn(),
    clearTags: vi.fn(),
  };
}

describe("attachErrorHooks", () => {
  it("calls captureError on a window error event", () => {
    const tracer = fakeTracer();
    attachErrorHooks(tracer);

    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(tracer.captureError).toHaveBeenCalledWith("boom", undefined);
  });

  it("reports the thrown error's own message and name, without the browser's \"Uncaught\" prefix", () => {
    const tracer = fakeTracer();
    attachErrorHooks(tracer);

    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "Uncaught TypeError: Cannot read properties of undefined",
        error: new TypeError("Cannot read properties of undefined"),
      })
    );

    expect(tracer.captureError).toHaveBeenCalledWith("Cannot read properties of undefined", "TypeError");
  });

  it("parses the prefix out of the message when there's no error object", () => {
    const tracer = fakeTracer();
    attachErrorHooks(tracer);

    window.dispatchEvent(new ErrorEvent("error", { message: "Uncaught RangeError: too deep" }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));

    expect(tracer.captureError).toHaveBeenNthCalledWith(1, "too deep", "RangeError");
    expect(tracer.captureError).toHaveBeenNthCalledWith(2, "Script error.", undefined);
  });

  it("calls captureUnhandledRejection on an unhandledrejection event", () => {
    const tracer = fakeTracer();
    attachErrorHooks(tracer);

    const event = Object.assign(new Event("unhandledrejection"), { reason: "network down" });
    window.dispatchEvent(event);

    expect(tracer.captureUnhandledRejection).toHaveBeenCalledWith("network down", undefined);
  });

  it("reports a rejected Error's message and name rather than \"Error: …\"", () => {
    const tracer = fakeTracer();
    attachErrorHooks(tracer);

    const event = Object.assign(new Event("unhandledrejection"), { reason: new Error("network down") });
    window.dispatchEvent(event);

    expect(tracer.captureUnhandledRejection).toHaveBeenCalledWith("network down", "Error");
  });

  it("stops calling the tracer after dispose()", () => {
    const tracer = fakeTracer();
    const dispose = attachErrorHooks(tracer);
    dispose();

    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(tracer.captureError).not.toHaveBeenCalled();
  });
});

describe("attachTraceAttributeListener", () => {
  it("calls traceElement with the data-trace value on click", () => {
    document.body.innerHTML = '<button data-trace="Sign up submit"><span>Sign up</span></button>';
    const tracer = fakeTracer();
    attachTraceAttributeListener(tracer);

    document.querySelector("span")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(tracer.traceElement).toHaveBeenCalledWith("Sign up submit");
  });

  it("does not call traceElement for clicks outside a data-trace element", () => {
    document.body.innerHTML = "<button>No trace</button>";
    const tracer = fakeTracer();
    attachTraceAttributeListener(tracer);

    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(tracer.traceElement).not.toHaveBeenCalled();
  });

  it("stops calling the tracer after dispose()", () => {
    document.body.innerHTML = '<button data-trace="Sign up submit">Sign up</button>';
    const tracer = fakeTracer();
    const dispose = attachTraceAttributeListener(tracer);
    dispose();

    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(tracer.traceElement).not.toHaveBeenCalled();
  });
});
