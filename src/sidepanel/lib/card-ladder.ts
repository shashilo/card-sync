import type { CardIdentity, SoldComp } from "../../shared/types";
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

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: `${CARD_LADDER_SALES_URL}${encodeURIComponent(query)}`, active: false });
    tabId = tab.id;
    if (!tabId) throw new Error("Chrome did not return the temporary Card Ladder tab ID.");

    await waitForTabLoad(tabId);
    const deadline = Date.now() + RESULT_WAIT_MS;
    let lastSnapshot: CardLadderPageSnapshot | undefined;

    while (Date.now() < deadline) {
      const [execution] = await chrome.scripting.executeScript({ target: { tabId }, func: readCardLadderSalesPage });
      lastSnapshot = execution?.result;
      if (lastSnapshot?.comps.length) {
        return {
          status: "free-comps-ready",
          message: `Found ${lastSnapshot.comps.length} Card Ladder sale${lastSnapshot.comps.length === 1 ? "" : "s"}${lastSnapshot.comps.some((comp) => comp.verified) ? ", including research-team verified sales" : ""}.`,
          comps: lastSnapshot.comps
        };
      }
      if (lastSnapshot && !lastSnapshot.loggedIn) {
        return { status: "error", message: "Card Ladder opened a sign-in page. Sign in to your Pro account in Chrome and try again.", comps: [] };
      }
      if (lastSnapshot?.resultsReady && lastSnapshot.resultCount === 0) {
        return { status: "no-free-comps", message: "Card Ladder found no sales for this search. Try a broader card identity.", comps: [] };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return {
      status: "error",
      message: lastSnapshot?.loggedIn === false
        ? "Card Ladder opened a sign-in page. Sign in to your Pro account in Chrome and try again."
        : "Card Ladder did not render sale results in time. Check that your Pro session is active, then retry.",
      comps: []
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? `Card Ladder lookup failed: ${error.message}` : "Card Ladder lookup failed in Chrome.",
      comps: []
    };
  } finally {
    if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => undefined);
  }
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
