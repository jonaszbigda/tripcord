import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TimelineSummary } from "../../types";
import { niceTicks } from "./scale";
import { SERIES } from "./series";
import { VolumeChart } from "./VolumeChart";

const SUMMARY: TimelineSummary = {
  projectHasTimelines: true,
  bucket: "day",
  buckets: [
    { start: "2026-09-20T00:00:00.000Z", error: 3, unhandledrejection: 1, manual: 0 },
    { start: "2026-09-21T00:00:00.000Z", error: 0, unhandledrejection: 0, manual: 0 },
    { start: "2026-09-22T00:00:00.000Z", error: 5, unhandledrejection: 0, manual: 2 },
  ],
  topReasons: [],
};

describe("niceTicks", () => {
  it.each([
    [0, [0, 1]],
    [1, [0, 1]],
    [3, [0, 1, 2, 3]],
    [7, [0, 2, 4, 6, 8]],
    [100, [0, 50, 100]],
    [101, [0, 50, 100, 150]],
  ])("%i → %j", (max, ticks) => {
    expect(niceTicks(max)).toEqual(ticks);
  });
});

describe("VolumeChart", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws stacked bars by default, one segment per non-zero count", () => {
    const { container } = render(<VolumeChart summary={SUMMARY} series={SERIES} />);
    expect(container.querySelectorAll('[data-series="error"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-series="unhandledrejection"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-series="manual"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Bars" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches to one line per series and remembers the choice", async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(<VolumeChart summary={SUMMARY} series={SERIES} />);

    await user.click(screen.getByRole("button", { name: "Lines" }));
    expect(container.querySelectorAll("path[data-series]")).toHaveLength(3);

    unmount();
    render(<VolumeChart summary={SUMMARY} series={SERIES} />);
    expect(screen.getByRole("button", { name: "Lines" })).toHaveAttribute("aria-pressed", "true");
  });

  it("falls back to bars when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<VolumeChart summary={SUMMARY} series={SERIES} />);
    expect(screen.getByRole("button", { name: "Bars" })).toHaveAttribute("aria-pressed", "true");
  });

  it("draws and lists only the series it's given", () => {
    const { container } = render(<VolumeChart summary={SUMMARY} series={SERIES.filter((s) => s.key === "error")} />);
    expect(container.querySelectorAll('[data-series="manual"]')).toHaveLength(0);
    expect(within(screen.getByRole("list", { name: "Legend" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows each type's count and the total on hover", async () => {
    const user = userEvent.setup();
    render(<VolumeChart summary={SUMMARY} series={SERIES} />);

    await user.hover(screen.getAllByTestId("chart-hover-target")[2]);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Error5");
    expect(tooltip).toHaveTextContent("Manual2");
    expect(tooltip).toHaveTextContent("Total7");
  });

  it("offers the same numbers as a table", async () => {
    const user = userEvent.setup();
    render(<VolumeChart summary={SUMMARY} series={SERIES} />);

    await user.click(screen.getByRole("button", { name: "Show table" }));

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[3]).toHaveTextContent(/5027$/);
  });
});
