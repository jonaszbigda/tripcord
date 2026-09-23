/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

const captureMock = vi.fn();
vi.mock("../index", () => ({
  capture: (...args: unknown[]) => captureMock(...args),
}));

function Boom(): never {
  throw new Error("render blew up");
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("all good")).toBeTruthy();
  });

  it("calls capture() with the error message and renders the fallback on error", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary fallback={<p>something broke</p>}>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByText("something broke")).toBeTruthy();
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock.mock.calls[0][0]).toBe("render blew up");

    consoleError.mockRestore();
  });

  it("passes its tags prop to capture()", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary tags={["checkout"]} fallback={<p>something broke</p>}>
        <Boom />
      </ErrorBoundary>
    );

    expect(captureMock.mock.calls[0][2]).toEqual({ tags: ["checkout"] });
    consoleError.mockRestore();
  });
});
