import { describe, expect, it } from "vitest";
import { buildDetectionScanPlan, expandBox, frameToViewportBox } from "../sidepanel/lib/detector";

describe("card detector scan plan", () => {
  it("scans the full captured screen instead of a nested video sub-rectangle", () => {
    const plan = buildDetectionScanPlan(480, 270);

    expect(plan.searchBounds).toEqual({
      x: 0,
      y: 0,
      width: 480,
      height: 270
    });
    expect(plan.minHeight).toBe(48);
    expect(plan.maxHeight).toBeGreaterThan(220);
  });

  it("uses the complete captured frame as the detection bounds", () => {
    expect(buildDetectionScanPlan(640, 360).searchBounds).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });

  it("adds enough margin around inner-artwork detections to include card edges", () => {
    const expanded = expandBox({ x: 100, y: 100, width: 100, height: 160 }, { x: 0, y: 0, width: 480, height: 400 });
    expect(expanded.x).toBe(64);
    expect(expanded.y).toBeCloseTo(42.4);
    expect(expanded.width).toBe(172);
    expect(expanded.height).toBeCloseTo(275.2);
  });

  it("supports both vertical and horizontal card orientations", () => {
    const plan = buildDetectionScanPlan(480, 270);

    expect(plan.aspectRatios.some((ratio) => ratio < 0.8)).toBe(true);
    expect(plan.aspectRatios.some((ratio) => ratio > 1.2)).toBe(true);
  });

  it("centers letterboxed captured frames in the browser viewport", () => {
    const box = frameToViewportBox({ x: 0, y: 0, width: 1920, height: 1080 }, 1920, 1080, 1000, 1000);
    expect(box.x).toBeCloseTo(0);
    expect(box.y).toBeCloseTo(218.75);
    expect(box.width).toBeCloseTo(1000);
    expect(box.height).toBeCloseTo(562.5);
  });
});
