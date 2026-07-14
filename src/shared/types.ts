export type ScanStage =
  | "idle"
  | "detecting"
  | "candidate"
  | "fast-value"
  | "comp-backed"
  | "no-bid"
  | "error";

export type BadgeTone = "gray" | "yellow" | "green" | "red";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectionBox extends Box {
  confidence: number;
}

export interface VideoViewport {
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  videoRect?: Box;
}

export interface PageContext {
  url: string;
  title: string;
  visibleText: string;
  auctionText: string;
  videoViewport: VideoViewport;
  collectedAt: number;
}

export interface CardIdentity {
  sport?: string;
  player?: string;
  year?: string;
  set?: string;
  cardNumber?: string;
  parallel?: string;
  gradeCompany?: string;
  grade?: string;
  serialNumber?: string;
  autograph?: boolean;
  relic?: boolean;
  rawText: string;
  confidence: number;
  evidence: string[];
  alternatives: string[];
}

export interface CompLink {
  source: "eBay sold" | "130 Point" | "PSA APR" | "Search";
  label: string;
  url: string;
}

export type CompProvider = "sportscardspro" | "manual-links" | "demo";

export interface PriceGuideQuote {
  provider: CompProvider;
  providerId: string;
  productId: string;
  productName: string;
  setName?: string;
  matchedQuery: string;
  rawProviderRow: Record<string, unknown>;
  selectedCondition: string;
  selectedPrice: number;
  confidence: number;
  warnings: string[];
}

export interface Valuation {
  low: number;
  high: number;
  maxBid: number;
  currency: "USD";
  confidence: number;
  source: "session-cache" | "seeded-demo" | "price-guide" | "ai-estimate" | "none";
  compCount: number;
  reasons: string[];
  warnings: string[];
  priceGuideQuote?: PriceGuideQuote;
}

export interface TrackSummary {
  id: string;
  box: Box;
  detectionConfidence: number;
  stage: ScanStage;
  badgeTone: BadgeTone;
  label: string;
  identity?: CardIdentity;
  valuation?: Valuation;
  compLinks: CompLink[];
  inFlight?: boolean;
  updatedAt: number;
}

export interface ScanHistoryItem {
  id: string;
  showKey: string;
  showUrl: string;
  firstSeenAt: number;
  lastSeenAt: number;
  cropImageDataUrl: string;
  detectionConfidence: number;
  stage: ScanStage;
  badgeTone: BadgeTone;
  label: string;
  identity?: CardIdentity;
  valuation?: Valuation;
  compLinks: CompLink[];
  evidence: string[];
  warnings: string[];
  updatedAt: number;
}

export type ProviderKind = "mock" | "openai" | "openrouter" | "anthropic" | "custom-openai-compatible";

export interface ProviderSettings {
  provider: ProviderKind;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ExtensionSettings {
  provider: ProviderSettings;
  priceGuideProxyUrl: string;
  scanCadenceMs: number;
  identifyStableAfterMs: number;
  maxTrackedCards: number;
  allowAiEstimatedValues: boolean;
}
