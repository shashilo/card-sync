import { describe, expect, it } from "vitest";
import { updateTrackedCards } from "../sidepanel/lib/tracker";

describe("tracked card continuity", () => {
  it("keeps the same track id when a visible card moves between frames", () => {
    const first = updateTrackedCards(
      [],
      [{ x: 320, y: 140, width: 250, height: 360, confidence: 0.5 }],
      1000,
      1
    );
    const moved = updateTrackedCards(
      first,
      [{ x: 395, y: 155, width: 250, height: 360, confidence: 0.52 }],
      1250,
      1
    );

    expect(moved).toHaveLength(1);
    expect(moved[0].id).toBe(first[0].id);
    expect(moved[0].stableSince).toBeDefined();
  });
});
