import type { CardIdentity, SoldComp } from "../../shared/types";

const STOP_WORDS = new Set(["the", "card", "cards", "panini", "topps", "upper", "deck", "sports", "trading", "rookie", "rc", "base", "insert", "parallel", "numbered", "auto", "autograph"]);

export function compSearchQueries(identity: CardIdentity): string[] {
  const player = identity.player;
  const queries = [
    [identity.year, player, identity.brand, identity.product, identity.set, identity.cardNumber ? `#${identity.cardNumber.replace(/^#/, "")}` : "", identity.insert, identity.parallel, identity.variation, identity.serialNumber].filter(Boolean).join(" "),
    [identity.year, player, identity.insert, identity.parallel, identity.cardNumber ? `#${identity.cardNumber.replace(/^#/, "")}` : ""].filter(Boolean).join(" "),
    [identity.year, player, identity.brand, identity.product, identity.set].filter(Boolean).join(" "),
    [identity.year, player, identity.insert].filter(Boolean).join(" "),
    [player, identity.insert, identity.parallel].filter(Boolean).join(" "),
    [identity.year, player, identity.brand].filter(Boolean).join(" "),
    player ?? ""
  ];
  return [...new Set(queries.map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

export function rankSoldComps(identity: CardIdentity, comps: SoldComp[]): SoldComp[] {
  const ranked = comps.map((comp) => ({ ...comp, matchScore: scoreComp(identity, comp.title) }))
    .filter((comp) => comp.matchScore >= 0.28)
    .sort((left, right) => qualityRank(right.matchScore) - qualityRank(left.matchScore) || dateRank(right.soldDate) - dateRank(left.soldDate) || right.matchScore - left.matchScore);

  return ranked.map((comp) => ({
    ...comp,
    matchQuality: comp.matchScore >= 0.78 ? "strong" as const : comp.matchScore >= 0.55 ? "close" as const : "broad" as const
  }));
}

function scoreComp(identity: CardIdentity, title: string): number {
  const normalized = normalize(title);
  const titleTokens = new Set(normalized.split(" ").filter(Boolean));
  const playerTokens = meaningfulTokens(identity.player);
  if (playerTokens.length && !playerTokens.some((token) => titleTokens.has(token))) return 0;

  let score = 0;
  if (playerTokens.length) {
    const matches = playerTokens.filter((token) => titleTokens.has(token)).length;
    score += 0.46 * matches / playerTokens.length;
  }
  if (identity.year && titleTokens.has(identity.year)) score += 0.12;
  if (identity.cardNumber && titleTokens.has(normalize(identity.cardNumber).replace(/^0+/, ""))) score += 0.15;
  score += phraseScore(identity.insert, titleTokens, 0.16);
  score += phraseScore(identity.parallel, titleTokens, 0.13);
  score += phraseScore(identity.variation, titleTokens, 0.08);
  score += phraseScore(identity.product, titleTokens, 0.06);
  score += phraseScore(identity.set, titleTokens, 0.06);
  score += phraseScore(identity.brand, titleTokens, 0.04);
  if (identity.serialNumber && normalize(identity.serialNumber).split(" ").every((token) => titleTokens.has(token))) score += 0.12;
  if (identity.autograph === true && /auto|autograph|signed|signature/.test(normalized)) score += 0.05;
  return Math.min(1, score);
}

function phraseScore(value: string | undefined, titleTokens: Set<string>, weight: number): number {
  const tokens = meaningfulTokens(value);
  if (!tokens.length) return 0;
  const matches = tokens.filter((token) => titleTokens.has(token)).length;
  return weight * matches / tokens.length;
}

function meaningfulTokens(value: string | undefined): string[] {
  return normalize(value ?? "").split(" ").filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function dateRank(value?: string): number {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function qualityRank(score: number): number {
  return score >= 0.78 ? 2 : score >= 0.55 ? 1 : 0;
}
