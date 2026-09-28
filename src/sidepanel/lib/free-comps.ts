import type { CardIdentity, CompLink, CompSearchAttempt, SoldComp, Valuation } from "../../shared/types";
import { identitySearchText } from "./identity";

export interface FreeCompLookupResult {
  status: "free-comps-ready" | "no-free-comps" | "needs-identity" | "error";
  message: string;
  comps: SoldComp[];
  searchAttempts?: CompSearchAttempt[];
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

  const queries = freeCompSearchQueries(identity);
  const exactResult = await fetchEbayComps(ebayLink.url, queries[0]);
  const searchAttempts: CompSearchAttempt[] = [{
    source: "eBay sold",
    query: queries[0],
    status: exactResult.comps.length ? "results" : exactResult.unreadable ? "unreadable" : "no-results",
    count: exactResult.comps.length,
    message: exactResult.comps.length ? "Exact search returned sales." : exactResult.unreadable ? "Could not read exact-search response." : "No exact sales found."
  }];
  if (exactResult.comps.length) {
    return {
      status: "free-comps-ready",
      message: `Found ${exactResult.comps.length} eBay sold comp${exactResult.comps.length === 1 ? "" : "s"} for the exact card search.`,
      comps: exactResult.comps,
      searchAttempts
    };
  }

  const fallbackResults = await Promise.all(queries.slice(1).map((searchQuery) => fetchEbayComps(ebayLink.url, searchQuery)));
  searchAttempts.push(...fallbackResults.map((result, index) => ({
    source: "eBay sold" as const,
    query: queries[index + 1],
    status: result.comps.length ? "results" : result.unreadable ? "unreadable" : "no-results",
    count: result.comps.length,
    message: result.comps.length ? "Broader search returned sales." : result.unreadable ? "Could not read broadened-search response." : "No sales found."
  })));
  const broadenedComps = dedupeComps(fallbackResults.flatMap((result) => result.comps)).slice(0, 5);
  if (broadenedComps.length) {
    return {
      status: "free-comps-ready",
      message: `No exact sold comps found; found ${broadenedComps.length} sales from broader player and product searches. Confirm the set, parallel, and serial number before bidding.`,
      comps: broadenedComps,
      searchAttempts
    };
  }

  const unreadableResponse = exactResult.unreadable || fallbackResults.some((result) => result.unreadable);

  return {
    status: unreadableResponse ? "error" : "no-free-comps",
    message: unreadableResponse
      ? "eBay did not return readable sold results for the exact or broadened searches. Open the eBay link to verify results."
      : "No sold listings matched the exact card or broader player and product searches.",
    comps: [],
    searchAttempts
  };
}

async function fetchEbayComps(baseUrl: string, searchQuery: string): Promise<{ comps: SoldComp[]; unreadable: boolean }> {
  const url = new URL(baseUrl);
  url.searchParams.set("_nkw", searchQuery);
  try {
    const response = await fetch(url.toString(), {
      headers: { accept: "text/html" },
      credentials: "include",
      signal: AbortSignal.timeout(2800)
    });
    if (!response.ok) return { comps: [], unreadable: true };

    const html = await response.text();
    const comps = parseEbaySoldComps(html).slice(0, 5);
    if (comps.length) return { comps, unreadable: false };
    return {
      comps: [],
      unreadable: !/(?:no exact matches|no results found|0 results|there are no results)/i.test(html)
    };
  } catch {
    return { comps: [], unreadable: true };
  }
}

function freeCompSearchQueries(identity: CardIdentity): string[] {
  const queries = [
    identitySearchText(identity),
    [identity.year, identity.player, identity.brand, identity.set, identity.cardNumber ? `#${identity.cardNumber.replace(/^#/, "")}` : "", identity.gradeCompany, identity.grade].filter(Boolean).join(" "),
    [identity.year, identity.player, identity.brand, identity.set].filter(Boolean).join(" "),
    [identity.year, identity.player, identity.brand].filter(Boolean).join(" "),
    [identity.year, identity.player].filter(Boolean).join(" ")
  ];
  return [...new Set(queries.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
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
  const source = comps[0]?.source ?? "eBay sold";
  return {
    low: Math.round(median * 0.85),
    high: Math.round(median * 1.15),
    maxBid: Math.round(median * 0.85),
    currency: "USD",
    confidence: Math.min(0.68, Math.max(0.5, identity.confidence)),
    source: "free-comps",
    compCount: prices.length,
    reasons: [`${source} history sample of ${prices.length} visible sale${prices.length === 1 ? "" : "s"}.`],
    warnings: [source === "Card Ladder"
      ? "Card Ladder search results can include nearby variants or grades; confirm each match before bidding."
      : "Free page extraction can miss, duplicate, or misread results; verify before bidding."]
  };
}

export function parseEbaySoldComps(html: string): SoldComp[] {
  const items = html.match(/<li\b[^>]*class="[^"]*\b(?:s-item|s-card)\b[^"]*"[\s\S]*?<\/li>/gi) ?? [];
  const comps: SoldComp[] = [];

  for (const item of items) {
    const title = cleanHtml(firstMatch(item, /class="[^"]*\b(?:s-item__title|s-card__title)\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i));
    const priceText = cleanHtml(firstMatch(item, /class="[^"]*\b(?:s-item__price|s-card__price)\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i));
    const url = decodeHtml(firstMatch(item, /class="[^"]*\b(?:s-item__link|s-card__link)\b[^"]*"[^>]*href="([^"]+)"/i));
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
