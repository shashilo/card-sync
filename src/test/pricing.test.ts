import { describe, expect, it, vi } from "vitest";
import {
  buildPriceGuideQuery,
  buildPriceGuideQuote,
  priceCentsToDollars,
  rankPriceGuideCandidates,
  selectSportsCardsProPrice
} from "../shared/price-guide";
import type { CardIdentity, Valuation } from "../shared/types";
import { identityKey, inferIdentityFromContext } from "../sidepanel/lib/identity";
import { lookupPriceGuide } from "../sidepanel/lib/price-guide";
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

  it("suppresses demo and AI values when only source-backed pricing is allowed", () => {
    const valuation = buildValuation(jordan, new Map(), { low: 1, high: 2 }, false);
    expect(valuation.source).toBe("none");
    expect(valuation.maxBid).toBe(0);
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

  it("builds a price-guide query from normalized identity", () => {
    const query = buildPriceGuideQuery({
      ...jordan,
      gradeCompany: "PSA",
      grade: "10",
      confidence: 0.86
    });

    expect(query.query).toContain("1986 Michael Jordan Fleer #57 PSA 10");
  });

  it("ranks exact price-guide candidates above sticker and number mismatches", () => {
    const ranked = rankPriceGuideCandidates(jordan, [
      {
        id: "90923",
        "product-name": "Michael Jordan #8",
        "console-name": "Basketball Cards 1986 Fleer Sticker"
      },
      {
        id: "72584",
        "product-name": "Michael Jordan #57",
        "console-name": "Basketball Cards 1986 Fleer"
      }
    ]);

    expect(ranked[0].product.id).toBe("72584");
    expect(ranked[0].confidence).toBeGreaterThan(0.65);
  });

  it("maps grade and converts provider cents to dollars", () => {
    const selected = selectSportsCardsProPrice(
      { ...jordan, gradeCompany: "PSA", grade: "10" },
      {
        "manual-only-price": 602295,
        "loose-price": 225500
      }
    );

    expect(selected.key).toBe("manual-only-price");
    expect(selected.price).toBe(6022.95);
    expect(priceCentsToDollars(1732)).toBe(17.32);
  });

  it("returns no price for low-confidence price-guide matches", () => {
    const quote = buildPriceGuideQuote(
      jordan,
      "1986 Michael Jordan Fleer #57",
      {
        confidence: 0.44,
        product: {
          id: "90923",
          "product-name": "Michael Jordan #8",
          "console-name": "Basketball Cards 1986 Fleer Sticker"
        },
        warnings: ["bad match"]
      },
      {
        id: "90923",
        "product-name": "Michael Jordan #8",
        "console-name": "Basketball Cards 1986 Fleer Sticker",
        "loose-price": 10000
      }
    );

    const valuation = buildValuation(jordan, new Map(), undefined, true, quote);
    expect(valuation.source).toBe("none");
    expect(valuation.maxBid).toBe(0);
  });

  it("creates price-guide valuations from confident provider quotes", () => {
    const ranked = rankPriceGuideCandidates(jordan, [
      {
        id: "72584",
        "product-name": "Michael Jordan #57",
        "console-name": "Basketball Cards 1986 Fleer"
      }
    ]);
    const quote = buildPriceGuideQuote(jordan, "1986 Michael Jordan Fleer #57", ranked[0], {
      id: "72584",
      "product-name": "Michael Jordan #57",
      "console-name": "Basketball Cards 1986 Fleer",
      "loose-price": 225500
    });

    const valuation = buildValuation(jordan, new Map(), undefined, true, quote);
    expect(valuation.source).toBe("price-guide");
    expect(valuation.low).toBe(1917);
    expect(valuation.maxBid).toBe(1917);
    expect(valuation.high).toBe(2593);
  });

  it("reports missing-token lookup failures from the price proxy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            ok: false,
            status: "missing-token",
            error: "SportsCardsPro token is not configured."
          },
          { status: 500 }
        )
      )
    );

    const result = await lookupPriceGuide(jordan, "https://proxy.test/v1/price-guide/lookup");

    expect(result.status).toBe("missing-token");
    expect(result.message).toContain("token");
    vi.unstubAllGlobals();
  });

  it("reports proxy connectivity failures from the price proxy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("failed to fetch");
      })
    );

    const result = await lookupPriceGuide({ ...jordan, cardNumber: "58" }, "https://offline.test/v1/price-guide/lookup");

    expect(result.status).toBe("proxy-offline");
    expect(result.message).toContain("offline");
    vi.unstubAllGlobals();
  });
});
