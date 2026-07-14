import { buildPriceGuideQuery, type PriceGuideLookupResponse } from "../../shared/price-guide";
import type { CardIdentity, PriceGuideQuote } from "../../shared/types";

const inflightLookups = new Map<string, Promise<PriceGuideQuote | undefined>>();

export async function lookupPriceGuide(identity: CardIdentity, proxyUrl: string): Promise<PriceGuideQuote | undefined> {
  const endpoint = proxyUrl.trim();
  const { query } = buildPriceGuideQuery(identity);
  if (!endpoint || !query || identity.confidence < 0.5) return undefined;

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
      if (!response.ok || !body?.ok) return undefined;
      return body.quote;
    })
    .catch(() => undefined)
    .finally(() => {
      window.setTimeout(() => inflightLookups.delete(cacheKey), 10_000);
    });

  inflightLookups.set(cacheKey, lookup);
  return lookup;
}
