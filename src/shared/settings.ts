import type { ExtensionSettings } from "./types";
import { PRICE_GUIDE_PROXY_DEFAULT_URL } from "./price-guide";
import { normalizeProviderSettings } from "./providers";

const SETTINGS_KEY = "cardsync.settings";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: {
    provider: "mock",
    apiKey: "",
    baseUrl: "",
    model: "mock"
  },
  priceGuideProxyUrl: PRICE_GUIDE_PROXY_DEFAULT_URL,
  scanCadenceMs: 250,
  identifyStableAfterMs: 150,
  maxTrackedCards: 1,
  allowAiEstimatedValues: true
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = result[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    provider: normalizeProviderSettings(saved?.provider),
    maxTrackedCards: DEFAULT_SETTINGS.maxTrackedCards
  };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}
