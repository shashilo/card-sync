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

export async function lookup130PointComps(identity: CardIdentity): Promise<FreeCompLookupResult> {
  const query = identitySearchText(identity);
  if (identity.confidence < 0.5 || !query) return { status: "needs-identity", message: "Card needs a stronger identity before 130 Point can search sales.", comps: [] };
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: `https://130point.com/sales/?search=${encodeURIComponent(query)}`, active: false });
    tabId = tab.id;
    if (!tabId) throw new Error("Chrome did not return a 130 Point tab ID.");
    await waitFor130PointTab(tabId);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [execution] = await chrome.scripting.executeScript({ target: { tabId }, func: read130PointSalesPage, args: [query] });
      const snapshot = execution?.result;
      if (snapshot?.comps?.length) return { status: "free-comps-ready", message: `Found ${snapshot.comps.length} 130 Point sale${snapshot.comps.length === 1 ? "" : "s"}.`, comps: snapshot.comps, searchAttempts: [{ source: "130 Point", query, status: "results", count: snapshot.comps.length, message: "130 Point sales rows were extracted." }] };
      if (snapshot?.ready) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { status: "no-free-comps", message: "130 Point returned no readable sales for this search.", comps: [], searchAttempts: [{ source: "130 Point", query, status: "no-results", count: 0, message: "No readable 130 Point sales rows were found." }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "130 Point lookup failed.";
    return { status: "error", message: `130 Point lookup failed: ${message}`, comps: [], searchAttempts: [{ source: "130 Point", query, status: "error", count: 0, message }] };
  } finally {
    if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

async function waitFor130PointTab(tabId: number): Promise<void> {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => finish(), 15_000);
    const listener: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const finish = () => { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function read130PointSalesPage(query: string): { ready: boolean; comps: SoldComp[] } {
  const body = document.body?.innerText ?? "";
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const rows = links.filter((link) => /ebay|item|sale/i.test(link.href)).flatMap((link): SoldComp[] => {
    const text = link.parentElement?.innerText || link.innerText || "";
    const priceMatch = text.match(/\$\s?([0-9,]+(?:\.\d{1,2})?)/);
    if (!priceMatch) return [];
    const price = Number(priceMatch[1].replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0) return [];
    const date = text.match(/(?:sold|ended|date)\s*[:\-]?\s*([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})/i)?.[1];
    return [{ source: "130 Point", title: text.replace(/\s+/g, " ").trim().slice(0, 240), price, url: link.href, soldDate: date }];
  });
  return { ready: /no results|no sales|results/i.test(body) || rows.length > 0, comps: rows.slice(0, 5) };
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

export function valuationFromFreeComps(identity: CardIdentity, comps: SoldComp[], maxBidPercent = 80): Valuation {
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
    maxBid: Math.round((comps[0]?.price ?? median) * Math.max(0, Math.min(100, maxBidPercent)) / 100),
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
