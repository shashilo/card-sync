import { DEMO_CATALOG } from "../../shared/demo-catalog";
import type { CardIdentity, CompLink, Valuation } from "../../shared/types";
import { identityKey, identitySearchText } from "./identity";

export interface AiValueEstimate {
  low?: number;
  high?: number;
  maxBid?: number;
  confidence?: number;
  reasons?: string[];
  warnings?: string[];
}

export function generateCompLinks(identity: CardIdentity): CompLink[] {
  const query = identitySearchText(identity) || identity.rawText;
  const encoded = encodeURIComponent(query);
  return [
    {
      source: "eBay sold",
      label: "eBay sold search",
      url: `https://www.ebay.com/sch/i.html?_nkw=${encoded}&_sacat=0&LH_Sold=1&LH_Complete=1`
    },
    {
      source: "130 Point",
      label: "130 Point sales search",
      url: `https://130point.com/sales/?search=${encoded}`
    },
    {
      source: "PSA APR",
      label: "PSA auction prices",
      url: `https://www.psacard.com/auctionprices/#0%7C${encoded}`
    }
  ];
}

export function buildValuation(
  identity: CardIdentity,
  sessionCache: Map<string, Valuation>,
  aiEstimate: AiValueEstimate | undefined,
  allowAiEstimate: boolean
): Valuation {
  const key = identityKey(identity);
  const cached = key ? sessionCache.get(key) : undefined;
  if (cached) {
    return {
      ...cached,
      source: "session-cache",
      reasons: ["Reused value from this live-show session.", ...cached.reasons]
    };
  }

  const searchable = `${identitySearchText(identity)} ${identity.rawText}`.toLowerCase();
  const seeded = DEMO_CATALOG.find((entry) => entry.keywords.every((keyword) => searchable.includes(keyword.toLowerCase())));
  if (seeded) return seeded.valuation;

  if (allowAiEstimate && aiEstimate?.low && aiEstimate?.high) {
    const low = Math.max(1, Math.min(aiEstimate.low, aiEstimate.high));
    const high = Math.max(low, aiEstimate.high);
    const maxBid = aiEstimate.maxBid && aiEstimate.maxBid > 0 ? aiEstimate.maxBid : Math.round(low + (high - low) * 0.38);
    return {
      low,
      high,
      maxBid,
      currency: "USD",
      confidence: Math.min(identity.confidence, aiEstimate.confidence ?? 0.48),
      source: "ai-estimate",
      compCount: 0,
      reasons: aiEstimate.reasons?.length ? aiEstimate.reasons : ["AI produced a broad provisional value before comp-backed data was available."],
      warnings: [
        ...(aiEstimate.warnings ?? []),
        "AI estimate only; use as a fast risk signal, not a completed comp."
      ]
    };
  }

  return {
    low: 0,
    high: 0,
    maxBid: 0,
    currency: "USD",
    confidence: identity.confidence,
    source: "none",
    compCount: 0,
    reasons: ["Comp searches are ready, but no fast valuation is available yet."],
    warnings: ["Open the comp links before bidding if the auction clock allows."]
  };
}

export function stageFor(identity: CardIdentity, valuation: Valuation): "candidate" | "fast-value" | "comp-backed" | "no-bid" {
  if (identity.confidence < 0.5) return "no-bid";
  if (valuation.source === "none") return "candidate";
  if (valuation.source === "ai-estimate") return "fast-value";
  return valuation.confidence >= 0.72 ? "comp-backed" : "fast-value";
}

export function rememberValuation(identity: CardIdentity, valuation: Valuation, cache: Map<string, Valuation>): void {
  const key = identityKey(identity);
  if (!key || valuation.source === "none" || valuation.source === "ai-estimate") return;
  cache.set(key, valuation);
}
