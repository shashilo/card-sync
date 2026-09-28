import { DEMO_CATALOG } from "../../shared/demo-catalog";
import type { CardIdentity, PageContext } from "../../shared/types";

function clean(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function identityKey(identity: CardIdentity): string {
  return clean(
    [identity.player, identity.brand, identity.product, identity.year, identity.set, identity.cardNumber, identity.cardType, identity.rookie ? "rookie" : "", identity.insert, identity.parallel, identity.variation, identity.autographType, identity.relicType, identity.gradeCompany, identity.grade, identity.serialNumber]
      .filter(Boolean)
      .join(" ")
  );
}

export function identitySearchText(identity: Partial<CardIdentity>): string {
  return [identity.year, identity.player, identity.brand, identity.product, identity.set, identity.cardNumber ? `#${identity.cardNumber}` : "", identity.cardType, identity.rookie ? "rookie" : "", identity.insert, identity.parallel, identity.variation, identity.autographType, identity.relicType, identity.numbered ? identity.serialNumber : "", identity.gradeCompany, identity.grade]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function inferIdentityFromContext(context?: PageContext): CardIdentity {
  const identityText = clean(`${context?.auctionText ?? ""} ${context?.title ?? ""}`);
  const matched = DEMO_CATALOG.find((entry) => entry.keywords.every((keyword) => identityText.includes(clean(keyword))));

  if (matched) {
    return {
      sport: matched.identity.sport,
      player: matched.identity.player,
      year: matched.identity.year,
      set: matched.identity.set,
      cardNumber: matched.identity.cardNumber,
      parallel: matched.identity.parallel,
      gradeCompany: matched.identity.gradeCompany,
      grade: matched.identity.grade,
      rawText: identitySearchText(matched.identity),
      confidence: 0.62,
      evidence: ["Matched visible Whatnot/page text against local POC seed catalog."],
      alternatives: []
    };
  }

  const year = identityText.match(/\b(19[5-9][0-9]|20[0-3][0-9])\b/)?.[1];
  const grade = identityText.match(/\b(psa|bgs|sgc|cgc)\s*(10|9\.5|9|8\.5|8|7\.5|7)\b/i);
  const possiblePlayer = context?.auctionText?.split(/[|·,-]/)[0]?.replace(/\s+/g, " ").trim();
  const genericLabels = new Set(["auction", "products", "shop", "sold", "basketball cards", "live auction"]);
  const meaningfulPlayer = possiblePlayer && !genericLabels.has(clean(possiblePlayer)) ? possiblePlayer : undefined;
  const hasStructuredAuctionText = Boolean(meaningfulPlayer && (year || grade));

  return {
    year,
    gradeCompany: grade?.[1]?.toUpperCase(),
    grade: grade?.[2],
    rawText: context?.auctionText || context?.title || "Visible sports card",
    player: meaningfulPlayer && meaningfulPlayer.length < 60 ? meaningfulPlayer : undefined,
    confidence: hasStructuredAuctionText ? 0.54 : meaningfulPlayer ? 0.42 : 0.28,
    evidence: ["No AI provider configured; using visible page text only."],
    alternatives: []
  };
}

export function coerceIdentity(raw: unknown, fallback: CardIdentity): CardIdentity {
  if (!raw || typeof raw !== "object") return fallback;
  const value = raw as Record<string, unknown>;

  return {
    sport: asString(value.sport) ?? fallback.sport,
    player: asString(value.player) ?? fallback.player,
    brand: asString(value.brand) ?? fallback.brand,
    product: asString(value.product) ?? fallback.product,
    cardType: asString(value.cardType) ?? fallback.cardType,
    rookie: asBoolean(value.rookie) ?? fallback.rookie,
    year: asString(value.year) ?? fallback.year,
    set: asString(value.set) ?? fallback.set,
    cardNumber: asString(value.cardNumber) ?? asString(value.card_number) ?? fallback.cardNumber,
    insert: asString(value.insert) ?? asString(value.subset) ?? fallback.insert,
    parallel: asString(value.parallel) ?? fallback.parallel,
    variation: asString(value.variation) ?? fallback.variation,
    gradeCompany: asString(value.gradeCompany) ?? asString(value.grade_company) ?? fallback.gradeCompany,
    grade: asString(value.grade) ?? fallback.grade,
    serialNumber: asString(value.serialNumber) ?? asString(value.serial_number),
    numbered: asBoolean(value.numbered) ?? (Boolean(asString(value.serialNumber) ?? asString(value.serial_number)) || fallback.numbered),
    autograph: asBoolean(value.autograph) ?? fallback.autograph,
    autographType: asString(value.autographType) ?? asString(value.autograph_type) ?? fallback.autographType,
    relic: asBoolean(value.relic) ?? fallback.relic,
    relicType: asString(value.relicType) ?? asString(value.relic_type) ?? fallback.relicType,
    rawText: asString(value.rawText) ?? asString(value.raw_text) ?? fallback.rawText,
    confidence: clampConfidence(value.confidence, fallback.confidence),
    evidence: asStringArray(value.evidence, fallback.evidence),
    alternatives: asStringArray(value.alternatives, fallback.alternatives)
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 6);
}

function clampConfidence(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}
