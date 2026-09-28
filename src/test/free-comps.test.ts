import { describe, expect, it, vi } from "vitest";
import type { CardIdentity } from "../shared/types";
import { lookupFreeComps, parseEbaySoldComps, valuationFromFreeComps } from "../sidepanel/lib/free-comps";
import { generateCompLinks } from "../sidepanel/lib/pricing";

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

const ebayHtml = `
  <li class="s-item">
    <a class="s-item__link" href="https://www.ebay.com/itm/1?hash=abc">
      <span class="s-item__title">1986 Fleer Michael Jordan #57 PSA 8</span>
    </a>
    <span class="s-item__price">$2,100.00</span>
    <span class="POSITIVE">Sold Jul 1, 2026</span>
  </li>
  <li class="s-item">
    <a class="s-item__link" href="https://www.ebay.com/itm/2">
      <span class="s-item__title">1986 Fleer Michael Jordan #57</span>
    </a>
    <span class="s-item__price">$1,950.00</span>
  </li>
`;

describe("free comp extraction", () => {
  it("parses visible eBay sold result rows", () => {
    const comps = parseEbaySoldComps(ebayHtml);

    expect(comps).toHaveLength(2);
    expect(comps[0]).toMatchObject({
      source: "eBay sold",
      title: "1986 Fleer Michael Jordan #57 PSA 8",
      price: 2100,
      soldDate: "Sold Jul 1, 2026"
    });
  });

  it("does not fetch comps without a usable identity", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupFreeComps({ ...jordan, confidence: 0.32, player: undefined }, generateCompLinks(jordan));

    expect(result.status).toBe("needs-identity");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("fetches eBay sold comps and builds a best-effort valuation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(ebayHtml, { status: 200 })));

    const result = await lookupFreeComps(jordan, generateCompLinks(jordan));
    const valuation = valuationFromFreeComps(jordan, result.comps);

    expect(result.status).toBe("free-comps-ready");
    expect(result.comps).toHaveLength(2);
    expect(valuation.source).toBe("free-comps");
    expect(valuation.compCount).toBe(2);
    expect(valuation.maxBid).toBeGreaterThan(0);
    expect(valuation.maxBid).toBe(1680);
    vi.unstubAllGlobals();
  });
});
