import { describe, expect, it } from "vitest";
import { buildDetectionScanPlan } from "../sidepanel/lib/detector";

describe("card detector scan plan", () => {
  it("scans the full captured screen instead of a nested video sub-rectangle", () => {
    const plan = buildDetectionScanPlan(480, 270);

    expect(plan.searchBounds).toEqual({
      x: 0,
      y: 0,
      width: 480,
      height: 270
    });
    expect(plan.minHeight).toBeGreaterThanOrEqual(81);
    expect(plan.maxHeight).toBeGreaterThan(260);
  });

  it("supports both vertical and horizontal card orientations", () => {
    const plan = buildDetectionScanPlan(480, 270);

    expect(plan.aspectRatios.some((ratio) => ratio < 0.8)).toBe(true);
    expect(plan.aspectRatios.some((ratio) => ratio > 1.2)).toBe(true);
  });
});
