import type { CardIdentity, PriceGuideQuote, PriceLookupStatus } from "./types";

export const PRICE_GUIDE_PROXY_DEFAULT_URL = "http://127.0.0.1:8787/v1/price-guide/lookup";
export const PRICE_GUIDE_MIN_CONFIDENCE = 0.65;

export interface PriceGuideLookupRequest {
  identity: CardIdentity;
  query?: string;
}

export interface PriceGuideLookupResponse {
  ok: boolean;
  status?: PriceLookupStatus;
  quote?: PriceGuideQuote;
  error?: string;
}

export interface SportsCardsProProductSummary extends Record<string, unknown> {
  id?: string | number;
  "product-name"?: string;
  "console-name"?: string;
  genre?: string;
}

export interface PriceGuideQuery {
  query: string;
  warnings: string[];
}

export interface RankedPriceGuideCandidate {
  product: SportsCardsProProductSummary;
  confidence: number;
  warnings: string[];
}

export interface SelectedPrice {
  key: string;
  condition: string;
  price: number;
  warnings: string[];
}

export function buildPriceGuideQuery(identity: CardIdentity): PriceGuideQuery {
  const warnings: string[] = [];
  const fields = [identity.year, identity.player, identity.set];

  if (identity.cardNumber) {
    fields.push(`#${identity.cardNumber.replace(/^#/, "")}`);
  } else {
    warnings.push("Card number is uncertain, so the price-guide match confidence is reduced.");
  }

  if (identity.confidence >= 0.65 && identity.parallel) {
    fields.push(identity.parallel);
  } else if (identity.parallel) {
    warnings.push("Parallel was detected with low confidence and was omitted from the price-guide query.");
  }

  if (identity.confidence >= 0.75 && (identity.gradeCompany || identity.grade)) {
    fields.push([identity.gradeCompany, identity.grade].filter(Boolean).join(" "));
  } else if (identity.gradeCompany || identity.grade) {
    warnings.push("Grade was detected with low confidence and was omitted from the price-guide query.");
  }

  const query = fields
    .filter((field): field is string => Boolean(field?.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!identity.player) warnings.push("Player/name is uncertain, so CardSync may only show manual research links.");
  if (!identity.set) warnings.push("Set is uncertain, so CardSync may only show manual research links.");

  return {
    query: query || identity.rawText.trim(),
    warnings
  };
}

export function rankPriceGuideCandidates(identity: CardIdentity, products: SportsCardsProProductSummary[]): RankedPriceGuideCandidate[] {
  return products
    .map((product) => rankCandidate(identity, product))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 20);
}

export function selectSportsCardsProPrice(identity: CardIdentity, row: Record<string, unknown>): SelectedPrice {
  const grade = numericGrade(identity.grade);
  const company = identity.gradeCompany?.toUpperCase();
  const warnings: string[] = [];
  let key = "loose-price";
  let condition = "Ungraded";

  if (company === "PSA" && grade === 10) {
    key = "manual-only-price";
    condition = "PSA 10";
  } else if (company === "BGS" && grade === 10) {
    key = "bgs-10-price";
    condition = "BGS 10";
  } else if (company === "SGC" && grade === 10) {
    key = "condition-18-price";
    condition = "SGC 10";
  } else if (company === "CGC" && grade === 10) {
    key = "condition-17-price";
    condition = "CGC 10";
  } else if (grade === 9.5) {
    key = "box-only-price";
    condition = "Graded 9.5";
  } else if (grade === 9) {
    key = "graded-price";
    condition = "Graded 9";
  } else if (grade === 8 || grade === 8.5) {
    key = "new-price";
    condition = "Graded 8/8.5";
  } else if (grade === 7 || grade === 7.5) {
    key = "cib-price";
    condition = "Graded 7/7.5";
  } else if (identity.grade || identity.gradeCompany) {
    warnings.push("Grade did not map cleanly to a SportsCardsPro condition, so ungraded price was used.");
  }

  const price = priceCentsToDollars(row[key]);
  if (price <= 0) warnings.push(`SportsCardsPro did not return a usable ${condition} price.`);

  return {
    key,
    condition,
    price,
    warnings
  };
}

export function buildPriceGuideQuote(
  identity: CardIdentity,
  matchedQuery: string,
  candidate: RankedPriceGuideCandidate,
  productRow: Record<string, unknown>
): PriceGuideQuote {
  const selected = selectSportsCardsProPrice(identity, productRow);
  const productName = stringValue(productRow["product-name"]) || stringValue(candidate.product["product-name"]) || "Sports card";
  const setName = stringValue(productRow["console-name"]) || stringValue(candidate.product["console-name"]);

  return {
    provider: "sportscardspro",
    providerId: "sportscardspro",
    productId: String(productRow.id ?? candidate.product.id ?? ""),
    productName,
    setName,
    matchedQuery,
    rawProviderRow: productRow,
    selectedCondition: selected.condition,
    selectedPrice: selected.price,
    confidence: candidate.confidence,
    warnings: [...candidate.warnings, ...selected.warnings]
  };
}

export function priceCentsToDollars(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round((numeric / 100) * 100) / 100;
}

function rankCandidate(identity: CardIdentity, product: SportsCardsProProductSummary): RankedPriceGuideCandidate {
  const productName = normalizeText(stringValue(product["product-name"]));
  const setName = normalizeText(stringValue(product["console-name"]));
  const genre = normalizeText(stringValue(product.genre));
  const searchable = `${productName} ${setName} ${genre}`;
  const warnings: string[] = [];
  let score = 0.18;

  const playerTokens = tokenList(identity.player);
  if (playerTokens.length && playerTokens.every((token) => searchable.includes(token))) score += 0.26;
  else if (playerTokens.length) {
    score -= 0.18;
    warnings.push("Top price-guide candidate does not exactly match the detected player/name.");
  }

  if (identity.year && searchable.includes(identity.year)) score += 0.14;
  else if (identity.year) {
    score -= 0.14;
    warnings.push("Detected year does not match the top price-guide candidate.");
  }

  const setTokens = tokenList(identity.set);
  if (setTokens.length && setTokens.every((token) => searchable.includes(token))) score += 0.14;
  else if (setTokens.length) {
    score -= 0.12;
    warnings.push("Detected set does not exactly match the top price-guide candidate.");
  }

  const cardNumber = normalizeCardNumber(identity.cardNumber);
  if (cardNumber && hasCardNumber(productName, cardNumber)) score += 0.18;
  else if (cardNumber) {
    score -= 0.2;
    warnings.push("Detected card number does not match the top price-guide candidate.");
  }

  const parallelTokens = tokenList(identity.parallel);
  if (parallelTokens.length && parallelTokens.every((token) => searchable.includes(token))) score += 0.12;
  else if (parallelTokens.length) {
    score -= 0.1;
    warnings.push("Detected parallel does not exactly match the top price-guide candidate.");
  }

  const sport = normalizeText(identity.sport ?? "");
  if (sport && searchable.includes(sport)) score += 0.06;
  else if (sport) {
    score -= 0.06;
    warnings.push("Detected sport/category does not match the price-guide candidate.");
  }

  const detectedSticker = normalizeText(identity.rawText).includes("sticker");
  const candidateSticker = searchable.includes("sticker");
  if (detectedSticker !== candidateSticker) {
    score -= 0.12;
    warnings.push("Sticker/base mismatch risk detected.");
  }

  if (identity.autograph && !/(auto|autograph|autographed)/.test(searchable)) {
    score -= 0.12;
    warnings.push("Autograph status is uncertain against the price-guide candidate.");
  }

  if (identity.serialNumber) warnings.push("Serial number is not priced separately by this guide lookup.");

  return {
    product,
    confidence: Math.max(0, Math.min(0.98, score)),
    warnings
  };
}

function hasCardNumber(productName: string, cardNumber: string): boolean {
  const escaped = cardNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s|#)${escaped}(\\b|\\s|$)`).test(productName);
}

function numericGrade(grade: string | undefined): number | undefined {
  if (!grade) return undefined;
  const numeric = Number(grade);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeCardNumber(value: string | undefined): string {
  return (value ?? "").replace(/^#/, "").trim().toLowerCase();
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

function tokenList(value: string | undefined): string[] {
  return normalizeText(value ?? "")
    .split(/\s+/)
    .filter(Boolean);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
