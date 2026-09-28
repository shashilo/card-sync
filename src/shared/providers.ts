import type { ProviderKind, ProviderSettings } from "./types";

export interface ProviderPreset {
  label: string;
  shortLabel: string;
  baseUrl: string;
  model: string;
  keyPlaceholder: string;
  baseUrlReadonly: boolean;
  help: string;
}

export const PROVIDER_PRESETS: Record<ProviderKind, ProviderPreset> = {
  mock: {
    label: "Mock/page-text only",
    shortLabel: "Mock",
    baseUrl: "",
    model: "mock",
    keyPlaceholder: "No key needed",
    baseUrlReadonly: true,
    help: "No external AI call. Uses visible page text and seeded demo values."
  },
  openai: {
    label: "OpenAI / ChatGPT API",
    shortLabel: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6",
    keyPlaceholder: "OpenAI API key",
    baseUrlReadonly: true,
    help: "Uses the user's OpenAI API key for vision identification."
  },
  openrouter: {
    label: "OpenRouter",
    shortLabel: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5.4-mini",
    keyPlaceholder: "OpenRouter API key",
    baseUrlReadonly: true,
    help: "Uses OpenRouter's OpenAI-compatible chat completions API."
  },
  anthropic: {
    label: "Anthropic Claude",
    shortLabel: "Claude",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-haiku-4-5-20251001",
    keyPlaceholder: "Anthropic API key",
    baseUrlReadonly: true,
    help: "Uses Claude's Messages API with image input."
  },
  "custom-openai-compatible": {
    label: "Custom OpenAI-compatible",
    shortLabel: "Custom",
    baseUrl: "http://localhost:11434/v1",
    model: "llava",
    keyPlaceholder: "API key if required",
    baseUrlReadonly: false,
    help: "For local or hosted OpenAI-compatible vision endpoints."
  }
};

export function providerPreset(kind: ProviderKind): ProviderPreset {
  return PROVIDER_PRESETS[kind];
}

export function applyProviderPreset(current: ProviderSettings, provider: ProviderKind): ProviderSettings {
  const preset = providerPreset(provider);
  return {
    provider,
    apiKey: provider === current.provider ? current.apiKey : "",
    baseUrl: preset.baseUrl,
    model: preset.model
  };
}

export function normalizeProviderSettings(saved?: Partial<ProviderSettings>): ProviderSettings {
  const legacyProvider = saved?.provider as ProviderKind | "openai-compatible" | undefined;
  let provider: ProviderKind = "mock";

  if (legacyProvider === "openai-compatible") {
    provider = saved?.baseUrl?.includes("api.openai.com") ? "openai" : "custom-openai-compatible";
  } else if (legacyProvider && legacyProvider in PROVIDER_PRESETS) {
    provider = legacyProvider;
  }

  const preset = providerPreset(provider);
  const savedModel = saved?.model || preset.model;
  return {
    provider,
    apiKey: saved?.apiKey ?? "",
    baseUrl: saved?.baseUrl || preset.baseUrl,
    // Replace the old dynamic default with a stable vision model while preserving
    // models the user explicitly selected.
    model: provider === "openrouter" && savedModel === "~openai/gpt-latest"
      ? preset.model
      : savedModel
  };
}

export function customProviderOriginPattern(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    return `${url.protocol}//${host}/*`;
  } catch {
    return undefined;
  }
}

export async function requestCustomProviderPermission(settings: ProviderSettings): Promise<boolean> {
  if (settings.provider !== "custom-openai-compatible") return true;
  const origin = customProviderOriginPattern(settings.baseUrl);
  if (!origin) return false;
  const hasPermission = await chrome.permissions.contains({ origins: [origin] });
  if (hasPermission) return true;
  return chrome.permissions.request({ origins: [origin] });
}
