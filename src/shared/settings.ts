import type { ExtensionSettings } from "./types";
import { normalizeProviderSettings } from "./providers";

const SETTINGS_KEY = "cardsync.settings";
const LEGACY_PRICE_GUIDE_PROXY_DEFAULT_URL = "http://127.0.0.1:8787/v1/price-guide/lookup";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: {
    provider: "mock",
    apiKey: "",
    baseUrl: "",
    model: "mock"
  },
  priceGuideProxyUrl: "",
  scanCadenceMs: 250,
  identifyStableAfterMs: 150,
  maxTrackedCards: 1,
  allowAiEstimatedValues: true,
  maxBidPercent: 80
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = result[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    provider: normalizeProviderSettings(saved?.provider),
    priceGuideProxyUrl: normalizePriceGuideProxyUrl(saved?.priceGuideProxyUrl),
    maxBidPercent: normalizeMaxBidPercent(saved?.maxBidPercent),
    maxTrackedCards: DEFAULT_SETTINGS.maxTrackedCards
  };
}

export function normalizeMaxBidPercent(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.maxBidPercent;
  return Math.max(10, Math.min(100, Math.round(value as number)));
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function normalizePriceGuideProxyUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === LEGACY_PRICE_GUIDE_PROXY_DEFAULT_URL) return "";
  return trimmed;
}
