import { describe, expect, it } from "vitest";
import type { HistoryUpsertInput } from "../sidepanel/lib/history";
import { buildScanHistoryItem, showKeyFromUrl } from "../sidepanel/lib/history";

const baseInput: HistoryUpsertInput = {
  id: "scan-1",
  showKey: "www.whatnot.com/live/show-a",
  showUrl: "https://www.whatnot.com/live/show-a",
  seenAt: 1000,
  cropImageDataUrl: "data:image/jpeg;base64,first",
  detectionConfidence: 0.55,
  stage: "candidate",
  badgeTone: "yellow",
  label: "Candidate · 55%",
  identity: {
    player: "Michael Jordan",
    year: "1986",
    set: "Fleer",
    cardNumber: "57",
    rawText: "1986 Michael Jordan Fleer #57",
    confidence: 0.55,
    evidence: ["Matched page text."],
    alternatives: []
  },
  valuation: {
    low: 0,
    high: 0,
    maxBid: 0,
    currency: "USD",
    confidence: 0.55,
    source: "none",
    compCount: 0,
    reasons: ["Comp links are ready."],
    warnings: ["Verify before bidding."]
  },
  compLinks: []
};

describe("scan history", () => {
  it("keys Whatnot live show URLs by show id", () => {
    expect(showKeyFromUrl("https://www.whatnot.com/live/50f12d0c-62e8?foo=bar")).toBe(
      "www.whatnot.com/live/50f12d0c-62e8"
    );
    expect(showKeyFromUrl("https://www.whatnot.com/live/another-show")).toBe("www.whatnot.com/live/another-show");
  });

  it("creates a first history item with crop, identity, and evidence", () => {
    const item = buildScanHistoryItem(baseInput);

    expect(item.id).toBe("scan-1");
    expect(item.firstSeenAt).toBe(1000);
    expect(item.lastSeenAt).toBe(1000);
    expect(item.cropImageDataUrl).toContain("first");
    expect(item.identity?.player).toBe("Michael Jordan");
    expect(item.evidence).toContain("Matched page text.");
    expect(item.warnings).toContain("Verify before bidding.");
  });

  it("updates the same item when stronger value data arrives", () => {
    const existing = buildScanHistoryItem(baseInput);
    const updated = buildScanHistoryItem(
      {
        ...baseInput,
        seenAt: 2500,
        cropImageDataUrl: undefined,
        detectionConfidence: 0.72,
        stage: "fast-value",
        label: "$80-$115 · Max $92 · 68%",
        valuation: {
          low: 80,
          high: 115,
          maxBid: 92,
          currency: "USD",
          confidence: 0.68,
          source: "ai-estimate",
          compCount: 0,
          reasons: ["AI provisional estimate."],
          warnings: ["AI estimate only."]
        },
        compLinks: [
          {
            source: "eBay sold",
            label: "eBay sold search",
            url: "https://www.ebay.com"
          }
        ]
      },
      existing
    );

    expect(updated.id).toBe(existing.id);
    expect(updated.firstSeenAt).toBe(1000);
    expect(updated.lastSeenAt).toBe(2500);
    expect(updated.cropImageDataUrl).toBe(existing.cropImageDataUrl);
    expect(updated.valuation?.source).toBe("ai-estimate");
    expect(updated.compLinks).toHaveLength(1);
  });

  it("preserves price lookup status on history rows", () => {
    const item = buildScanHistoryItem({
      ...baseInput,
      priceLookup: {
        status: "no-match",
        message: "No confident price match",
        updatedAt: 1200
      }
    });

    expect(item.priceLookup?.status).toBe("no-match");
    expect(item.priceLookup?.message).toContain("price");
  });

  it("persists the selected max bid percentage and comp search trail", () => {
    const item = buildScanHistoryItem({
      ...baseInput,
      maxBidPercent: 80,
      compSearchAttempts: [{
        source: "Card Ladder",
        query: "1986 Michael Jordan Fleer #57",
        status: "results",
        count: 2,
        message: "Sales rows were extracted."
      }]
    });

    expect(item.maxBidPercent).toBe(80);
    expect(item.compSearchAttempts?.[0]).toMatchObject({ source: "Card Ladder", count: 2, status: "results" });
  });

  it("keeps manual comp links on manual-ready history rows", () => {
    const item = buildScanHistoryItem({
      ...baseInput,
      priceLookup: {
        status: "manual-ready",
        message: "Open eBay, 130 Point, and PSA APR research links.",
        updatedAt: 1200
      },
      compLinks: [
        { source: "eBay sold", label: "eBay sold search", url: "https://www.ebay.com" },
        { source: "130 Point", label: "130 Point sales search", url: "https://130point.com" },
        { source: "PSA APR", label: "PSA auction prices", url: "https://www.psacard.com" }
      ]
    });

    expect(item.priceLookup?.status).toBe("manual-ready");
    expect(item.compLinks.map((link) => link.source)).toEqual(["eBay sold", "130 Point", "PSA APR"]);
  });

  it("keeps show-scoped records separate by key", () => {
    const showA = buildScanHistoryItem(baseInput);
    const showB = buildScanHistoryItem({
      ...baseInput,
      id: "scan-2",
      showKey: "www.whatnot.com/live/show-b",
      showUrl: "https://www.whatnot.com/live/show-b"
    });

    expect(showA.showKey).not.toBe(showB.showKey);
    expect(showA.id).not.toBe(showB.id);
  });
});
