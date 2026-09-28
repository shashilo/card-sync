import { PRICE_GUIDE_MIN_CONFIDENCE } from "../../shared/price-guide";
import type { CardIdentity, CompLink, PriceGuideQuote, Valuation } from "../../shared/types";
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
      source: "Card Ladder",
      label: "Card Ladder sales search",
      url: `https://app.cardladder.com/sales-history?direction=desc&sort=date&q=${encoded}`
    },
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
  _aiEstimate: AiValueEstimate | undefined,
  _allowAiEstimate: boolean,
  priceGuideQuote?: PriceGuideQuote,
  maxBidPercent = 80
): Valuation {
  if (priceGuideQuote) return valuationFromPriceGuide(identity, priceGuideQuote, maxBidPercent);

  const key = identityKey(identity);
  const cached = key ? sessionCache.get(key) : undefined;
  if (cached) {
    return {
      ...withMaxBidPercent(cached, maxBidPercent),
      source: "session-cache",
      reasons: ["Reused value from this live-show session.", ...cached.reasons]
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
    reasons: ["No sold comp or configured price-guide value is available."],
    warnings: ["No price is shown until a real source returns a value. Open the comp links or retry the lookup."]
  };
}

export function stageFor(identity: CardIdentity, valuation: Valuation): "candidate" | "fast-value" | "comp-backed" | "no-bid" {
  if (identity.confidence < 0.5) return "no-bid";
  if (valuation.source === "none") return "candidate";
  return valuation.confidence >= 0.72 ? "comp-backed" : "fast-value";
}

export function rememberValuation(identity: CardIdentity, valuation: Valuation, cache: Map<string, Valuation>): void {
  const key = identityKey(identity);
  if (!key || valuation.source === "none" || valuation.source === "ai-estimate" || valuation.source === "seeded-demo") return;
  cache.set(key, valuation);
}

export function withMaxBidPercent(valuation: Valuation, maxBidPercent = 80, referencePriceOverride?: number): Valuation {
  const referencePrice = referencePriceOverride ?? valuation.priceGuideQuote?.selectedPrice ?? (valuation.low + valuation.high) / 2;
  const percentage = Math.max(0, Math.min(100, maxBidPercent)) / 100;
  return { ...valuation, maxBid: valuation.source === "none" ? 0 : Math.round(referencePrice * percentage) };
}

function valuationFromPriceGuide(identity: CardIdentity, quote: PriceGuideQuote, maxBidPercent: number): Valuation {
  const warnings = [
    ...quote.warnings,
    ...missingIdentityWarnings(identity),
    "Price-guide value only; verify sold comps before treating this as an appraisal."
  ];

  if (quote.confidence < PRICE_GUIDE_MIN_CONFIDENCE || quote.selectedPrice <= 0) {
    return {
      low: 0,
      high: 0,
      maxBid: 0,
      currency: "USD",
      confidence: Math.min(identity.confidence, quote.confidence),
      source: "none",
      compCount: 0,
      reasons: [`SportsCardsPro candidate found for "${quote.productName}", but match confidence is below the pricing threshold.`],
      warnings
    };
  }

  const fairValue = quote.selectedPrice;
  const confidence = Math.min(0.96, Math.max(identity.confidence, quote.confidence * 0.86 + identity.confidence * 0.14));

  return withMaxBidPercent({
    low: Math.round(fairValue * 0.85),
    high: Math.round(fairValue * 1.15),
    maxBid: 0,
    currency: "USD",
    confidence,
    source: "price-guide",
    compCount: 1,
    reasons: [
      `Price-backed by SportsCardsPro ${quote.selectedCondition} value for "${quote.productName}".`,
      quote.setName ? `Matched guide set: ${quote.setName}.` : `Matched guide query: ${quote.matchedQuery}.`
    ],
    warnings,
    priceGuideQuote: quote
  }, maxBidPercent);
}

function missingIdentityWarnings(identity: CardIdentity): string[] {
  const warnings: string[] = [];
  if (!identity.grade && !identity.gradeCompany) warnings.push("Grade is uncertain; raw/ungraded price-guide value was used.");
  if (!identity.parallel) warnings.push("Parallel is uncertain; verify the variant before bidding.");
  if (!identity.cardNumber) warnings.push("Card number is uncertain; verify the exact card before bidding.");
  if (identity.serialNumber) warnings.push("Serial-numbered variants can price materially above or below the guide value.");
  if (identity.autograph === undefined) warnings.push("Autograph status is uncertain.");
  return warnings;
}
