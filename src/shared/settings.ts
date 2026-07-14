import type { ExtensionSettings } from "./types";
import { normalizeProviderSettings } from "./providers";

const SETTINGS_KEY = "cardsync.settings";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: {
    provider: "mock",
    apiKey: "",
    baseUrl: "",
    model: "mock"
  },
  scanCadenceMs: 350,
  identifyStableAfterMs: 900,
  maxTrackedCards: 3,
  allowAiEstimatedValues: true
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = result[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    provider: normalizeProviderSettings(saved?.provider)
  };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}
