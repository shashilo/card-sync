import type { CardIdentity, CompSearchAttempt, SoldComp } from "../../shared/types";
import type { FreeCompLookupResult } from "./free-comps";
import { identitySearchText } from "./identity";

const CARD_LADDER_SALES_URL = "https://app.cardladder.com/sales-history?direction=desc&sort=date&q=";
const RESULT_WAIT_MS = 12_000;

interface CardLadderPageSnapshot {
  loggedIn: boolean;
  resultsReady: boolean;
  resultCount: number;
  comps: SoldComp[];
}

export async function lookupCardLadderComps(identity: CardIdentity): Promise<FreeCompLookupResult> {
  const query = identitySearchText(identity);
  if (identity.confidence < 0.5 || !query) {
    return { status: "needs-identity", message: "Card needs a stronger identity before Card Ladder can search sales.", comps: [] };
  }

  const queries = [...new Set([
    query,
    [identity.year, identity.player, identity.brand, identity.set, identity.cardNumber ? `#${identity.cardNumber.replace(/^#/, "")}` : "", identity.gradeCompany, identity.grade].filter(Boolean).join(" "),
    [identity.year, identity.player, identity.brand, identity.set].filter(Boolean).join(" "),
    [identity.year, identity.player, identity.brand].filter(Boolean).join(" ")
  ].map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
  const searchAttempts: CompSearchAttempt[] = [];

  for (const searchQuery of queries) {
    let tabId: number | undefined;
    let lastSnapshot: CardLadderPageSnapshot | undefined;
    try {
      const tab = await chrome.tabs.create({ url: `${CARD_LADDER_SALES_URL}${encodeURIComponent(searchQuery)}`, active: false });
      tabId = tab.id;
      if (!tabId) throw new Error("Chrome did not return the temporary Card Ladder tab ID.");

      await waitForTabLoad(tabId);
      const deadline = Date.now() + RESULT_WAIT_MS;
      while (Date.now() < deadline) {
        const [execution] = await chrome.scripting.executeScript({ target: { tabId }, func: readCardLadderSalesPage });
        lastSnapshot = execution?.result;
        if (lastSnapshot?.comps.length) {
          searchAttempts.push({ source: "Card Ladder", query: searchQuery, status: "results", count: lastSnapshot.comps.length, message: "Sales rows were extracted." });
          return {
            status: "free-comps-ready",
            message: `Found ${lastSnapshot.comps.length} Card Ladder sale${lastSnapshot.comps.length === 1 ? "" : "s"}${lastSnapshot.comps.some((comp) => comp.verified) ? ", including research-team verified sales" : ""}${searchQuery !== query ? ` with broader query “${searchQuery}”` : ""}.`,
            comps: lastSnapshot.comps,
            searchAttempts
          };
        }
        if (lastSnapshot && !lastSnapshot.loggedIn) {
          searchAttempts.push({ source: "Card Ladder", query: searchQuery, status: "login-required", count: 0, message: "The page showed a sign-in state." });
          return { status: "error", message: "Card Ladder opened a sign-in page. Sign in to your Pro account in Chrome and try again.", comps: [], searchAttempts };
        }
        if (lastSnapshot?.resultsReady && lastSnapshot.resultCount === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const noSales = Boolean(lastSnapshot?.resultsReady && lastSnapshot.resultCount === 0);
      searchAttempts.push({
        source: "Card Ladder",
        query: searchQuery,
        status: noSales ? "no-results" : "timeout",
        count: lastSnapshot?.resultCount ?? 0,
        message: noSales ? "Card Ladder returned zero sales; trying a broader query." : "Card Ladder did not render results before the search timeout."
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Card Ladder lookup failed in Chrome.";
      searchAttempts.push({ source: "Card Ladder", query: searchQuery, status: "error", count: 0, message });
    } finally {
      if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => undefined);
    }
  }

  const hadReadableNoSales = searchAttempts.some((attempt) => attempt.status === "no-results");
  return {
    status: hadReadableNoSales ? "no-free-comps" : "error",
    message: hadReadableNoSales
      ? "Card Ladder found no sales for the exact search or broader player and product queries."
      : "Card Ladder did not render sale results for the exact or broader queries. Check that your Pro session is active, then retry.",
    comps: [],
    searchAttempts
  };
}

async function waitForTabLoad(tabId: number): Promise<void> {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Timed out loading Card Ladder.")), 15_000);
    const listener: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function readCardLadderSalesPage(): CardLadderPageSnapshot {
  const bodyText = document.body?.innerText ?? "";
  const loggedIn = !/sign in|log in|create an account/i.test(bodyText.slice(0, 1200)) && !/\/login(?:[/?#]|$)/i.test(location.pathname);
  const resultCountMatch = bodyText.match(/([\d,]+)\s+results\b/i);
  const rows = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="saleId="]'));
  const comps = rows.flatMap((row) => {
    const title = row.querySelector<HTMLElement>(".item-text")?.innerText.trim();
    const saleId = new URL(row.href).searchParams.get("saleId");
    const stats = Array.from(row.querySelectorAll<HTMLElement>(".stat-item"));
    const statValue = (label: string) => stats.find((stat) => stat.querySelector("label")?.textContent?.trim().toLowerCase() === label.toLowerCase())?.querySelector<HTMLElement>(".value")?.innerText.trim();
    const priceText = statValue("Price") ?? "";
    const priceMatch = priceText.replace(/,/g, "").match(/\$?([0-9]+(?:\.[0-9]{1,2})?)/);
    const price = priceMatch ? Number(priceMatch[1]) : 0;
    if (!title || !saleId || !Number.isFinite(price) || price <= 0) return [];

    return [{
      source: "Card Ladder" as const,
      title,
      price,
      url: row.href,
      soldDate: statValue("Date Sold"),
      verified: /\bverified\b/i.test(row.innerText)
    }];
  });

  return {
    loggedIn,
    resultsReady: resultCountMatch !== null || rows.length > 0 || /no results|no sales found/i.test(bodyText),
    resultCount: resultCountMatch ? Number(resultCountMatch[1].replace(/,/g, "")) : rows.length,
    comps: comps.slice(0, 5)
  };
}
