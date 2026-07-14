import { describe, expect, it } from "vitest";
import type { CardIdentity, Valuation } from "../shared/types";
import { identityKey, inferIdentityFromContext } from "../sidepanel/lib/identity";
import { buildValuation, generateCompLinks, stageFor } from "../sidepanel/lib/pricing";

const jordan: CardIdentity = {
  sport: "Basketball",
  player: "Michael Jordan",
  year: "1986",
  set: "Fleer",
  cardNumber: "57",
  rawText: "1986 Fleer Michael Jordan #57",
  confidence: 0.82,
  evidence: ["test"],
  alternatives: []
};

describe("pricing pipeline", () => {
  it("generates source links from normalized card identity", () => {
    const links = generateCompLinks(jordan);
    expect(links).toHaveLength(3);
    expect(links[0].url).toContain("LH_Sold=1");
    expect(links[1].url).toContain("130point.com");
  });

  it("uses seeded demo values for known POC cards", () => {
    const valuation = buildValuation(jordan, new Map(), undefined, true);
    expect(valuation.source).toBe("seeded-demo");
    expect(valuation.low).toBeGreaterThan(0);
    expect(stageFor(jordan, valuation)).toBe("fast-value");
  });

  it("reuses session values before weaker estimates", () => {
    const cache = new Map<string, Valuation>();
    cache.set(identityKey(jordan), {
      low: 100,
      high: 140,
      maxBid: 115,
      currency: "USD",
      confidence: 0.8,
      source: "seeded-demo",
      compCount: 8,
      reasons: ["test cache"],
      warnings: []
    });

    const valuation = buildValuation(jordan, cache, { low: 1, high: 2 }, true);
    expect(valuation.source).toBe("session-cache");
    expect(valuation.maxBid).toBe(115);
  });

  it("falls back to page text when no AI provider is configured", () => {
    const identity = inferIdentityFromContext({
      title: "Whatnot",
      url: "https://www.whatnot.com/live/test",
      auctionText: "1986 Fleer Michael Jordan #57 PSA",
      visibleText: "",
      collectedAt: Date.now(),
      videoViewport: {
        viewportWidth: 1280,
        viewportHeight: 720,
        devicePixelRatio: 1
      }
    });

    expect(identity.player).toBe("Michael Jordan");
    expect(identity.confidence).toBeGreaterThan(0.5);
  });
});
