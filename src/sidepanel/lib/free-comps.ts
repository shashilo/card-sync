import type { CardIdentity, CompLink, SoldComp, Valuation } from "../../shared/types";
import { identitySearchText } from "./identity";

export interface FreeCompLookupResult {
  status: "free-comps-ready" | "no-free-comps" | "needs-identity" | "error";
  message: string;
  comps: SoldComp[];
}

export async function lookupFreeComps(identity: CardIdentity, compLinks: CompLink[]): Promise<FreeCompLookupResult> {
  const query = identitySearchText(identity);
  if (identity.confidence < 0.5 || !query) {
    return {
      status: "needs-identity",
      message: "Card needs a stronger identity before CardSync can fetch free comps.",
      comps: []
    };
  }

  const ebayLink = compLinks.find((link) => link.source === "eBay sold");
  if (!ebayLink) {
    return {
      status: "no-free-comps",
      message: "No eBay sold search link is available for this card.",
      comps: []
    };
  }

  try {
    const response = await fetch(ebayLink.url, {
      headers: {
        accept: "text/html"
      },
      signal: AbortSignal.timeout(4200)
    });

    if (!response.ok) {
      return {
        status: "error",
        message: `eBay sold search returned ${response.status}.`,
        comps: []
      };
    }

    const comps = parseEbaySoldComps(await response.text()).slice(0, 5);
    if (!comps.length) {
      return {
        status: "no-free-comps",
        message: "No visible eBay sold comps were found.",
        comps: []
      };
    }

    return {
      status: "free-comps-ready",
      message: `Found ${comps.length} eBay sold comp${comps.length === 1 ? "" : "s"}.`,
      comps
    };
  } catch {
    return {
      status: "error",
      message: "Could not fetch eBay sold results from the browser.",
      comps: []
    };
  }
}

export function valuationFromFreeComps(identity: CardIdentity, comps: SoldComp[]): Valuation {
  const prices = comps.map((comp) => comp.price).filter((price) => Number.isFinite(price) && price > 0).sort((a, b) => a - b);
  if (!prices.length) {
    return {
      low: 0,
      high: 0,
      maxBid: 0,
      currency: "USD",
      confidence: identity.confidence,
      source: "none",
      compCount: 0,
      reasons: ["Free comp search did not return usable sold prices."],
      warnings: ["Open the manual comp links before bidding if the auction clock allows."]
    };
  }

  const median = prices[Math.floor(prices.length / 2)];
  return {
    low: Math.round(median * 0.85),
    high: Math.round(median * 1.15),
    maxBid: Math.round(median * 0.85),
    currency: "USD",
    confidence: Math.min(0.68, Math.max(0.5, identity.confidence)),
    source: "free-comps",
    compCount: prices.length,
    reasons: [`Best-effort eBay sold extraction from ${prices.length} visible result${prices.length === 1 ? "" : "s"}.`],
    warnings: ["Free page extraction can miss, duplicate, or misread results; verify before bidding."]
  };
}

export function parseEbaySoldComps(html: string): SoldComp[] {
  const items = html.match(/<li\b[^>]*class="[^"]*\bs-item\b[^"]*"[\s\S]*?<\/li>/gi) ?? [];
  const comps: SoldComp[] = [];

  for (const item of items) {
    const title = cleanHtml(firstMatch(item, /class="[^"]*\bs-item__title\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i));
    const priceText = cleanHtml(firstMatch(item, /class="[^"]*\bs-item__price\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i));
    const url = decodeHtml(firstMatch(item, /class="[^"]*\bs-item__link\b[^"]*"[^>]*href="([^"]+)"/i));
    const soldDate = cleanHtml(firstMatch(item, /class="[^"]*\bPOSITIVE\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i));
    const price = parsePrice(priceText);

    if (!title || /^shop on ebay$/i.test(title) || !url || !price) continue;
    comps.push({
      source: "eBay sold",
      title,
      price,
      url,
      soldDate: soldDate || undefined
    });
  }

  return dedupeComps(comps).slice(0, 12);
}

function firstMatch(value: string, pattern: RegExp): string {
  return value.match(pattern)?.[1] ?? "";
}

function cleanHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parsePrice(value: string): number | undefined {
  const match = value.replace(/,/g, "").match(/\$([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!match) return undefined;
  const price = Number(match[1]);
  return Number.isFinite(price) && price > 0 ? price : undefined;
}

function dedupeComps(comps: SoldComp[]): SoldComp[] {
  const seen = new Set<string>();
  return comps.filter((comp) => {
    const key = `${comp.title.toLowerCase()}|${comp.price}|${comp.url.split("?")[0]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
