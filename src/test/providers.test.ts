import { describe, expect, it } from "vitest";
import { applyProviderPreset, customProviderOriginPattern, normalizeProviderSettings, providerPreset } from "../shared/providers";

describe("provider settings", () => {
  it("applies BYOK presets without carrying keys across providers", () => {
    const next = applyProviderPreset(
      {
        provider: "openai",
        apiKey: "sk-old",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.6"
      },
      "openrouter"
    );

    expect(next.provider).toBe("openrouter");
    expect(next.apiKey).toBe("");
    expect(next.baseUrl).toBe(providerPreset("openrouter").baseUrl);
  });

  it("migrates legacy OpenAI-compatible settings", () => {
    const openai = normalizeProviderSettings({
      provider: "openai-compatible" as never,
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini"
    });
    const custom = normalizeProviderSettings({
      provider: "openai-compatible" as never,
      baseUrl: "http://localhost:11434/v1",
      model: "llava"
    });

    expect(openai.provider).toBe("openai");
    expect(custom.provider).toBe("custom-openai-compatible");
  });

  it("builds custom host permission patterns narrowly", () => {
    expect(customProviderOriginPattern("http://localhost:11434/v1")).toBe("http://localhost:11434/*");
    expect(customProviderOriginPattern("https://ai.example.com/v1")).toBe("https://ai.example.com/*");
    expect(customProviderOriginPattern("not a url")).toBeUndefined();
  });
});
