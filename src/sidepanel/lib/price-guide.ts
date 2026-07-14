import { buildPriceGuideQuery, type PriceGuideLookupResponse } from "../../shared/price-guide";
import type { CardIdentity, PriceGuideQuote, PriceLookupStatus } from "../../shared/types";

export interface PriceGuideLookupResult {
  status: PriceLookupStatus;
  message: string;
  quote?: PriceGuideQuote;
}

const inflightLookups = new Map<string, Promise<PriceGuideLookupResult>>();

export async function lookupPriceGuide(identity: CardIdentity, proxyUrl: string): Promise<PriceGuideLookupResult> {
  const endpoint = proxyUrl.trim();
  const { query } = buildPriceGuideQuery(identity);
  if (!endpoint) {
    return {
      status: "proxy-offline",
      message: "Price guide proxy URL is not configured."
    };
  }
  if (!query || identity.confidence < 0.5) {
    return {
      status: "no-match",
      message: "Card identity confidence is too low for a SportsCardsPro lookup."
    };
  }

  const cacheKey = `${endpoint}|${query}|${identity.gradeCompany ?? ""}|${identity.grade ?? ""}`;
  const existing = inflightLookups.get(cacheKey);
  if (existing) return existing;

  const lookup = fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ identity, query }),
    signal: AbortSignal.timeout(1600)
  })
    .then(async (response) => {
      const body = (await response.json().catch(() => undefined)) as PriceGuideLookupResponse | undefined;
      if (response.ok && body?.ok && body.quote) {
        return {
          status: "ready",
          message: `SportsCardsPro matched "${body.quote.productName}".`,
          quote: body.quote
        } satisfies PriceGuideLookupResult;
      }
      if (response.ok && body?.ok && !body.quote) {
        return {
          status: "no-match",
          message: body.error || "SportsCardsPro did not return a confident product match."
        } satisfies PriceGuideLookupResult;
      }
      const status = normalizeStatus(body?.status, body?.error);
      return {
        status,
        message: body?.error || messageForStatus(status)
      } satisfies PriceGuideLookupResult;
    })
    .catch((caught: unknown) => {
      const isTimeout = caught instanceof DOMException && caught.name === "TimeoutError";
      return {
        status: "proxy-offline",
        message: isTimeout ? "Price proxy did not respond within 1.6 seconds." : "Price proxy is offline or unreachable."
      } satisfies PriceGuideLookupResult;
    })
    .finally(() => {
      globalThis.setTimeout(() => inflightLookups.delete(cacheKey), 10_000);
    });

  inflightLookups.set(cacheKey, lookup);
  return lookup;
}

function normalizeStatus(status: PriceLookupStatus | undefined, error: string | undefined): PriceLookupStatus {
  if (status) return status;
  if (error?.toLowerCase().includes("token")) return "missing-token";
  return "error";
}

function messageForStatus(status: PriceLookupStatus): string {
  if (status === "missing-token") return "SportsCardsPro token is not configured on the price proxy.";
  if (status === "no-match") return "SportsCardsPro did not return a confident product match.";
  if (status === "proxy-offline") return "Price proxy is offline or unreachable.";
  if (status === "ready") return "SportsCardsPro price is ready.";
  if (status === "pending") return "Checking SportsCardsPro.";
  if (status === "idle") return "SportsCardsPro lookup has not started.";
  return "SportsCardsPro lookup failed.";
}
