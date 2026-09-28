import type { CardIdentity, ExtensionSettings, PageContext, ProviderSettings } from "../../shared/types";
import { coerceIdentity, inferIdentityFromContext } from "./identity";
import type { AiValueEstimate } from "./pricing";

export interface AiCardResult {
  identity: CardIdentity;
  estimate?: AiValueEstimate;
  error?: string;
}

type IdentifyMode = "card" | "slab-label";

export async function identifyCard(
  imageDataUrl: string,
  context: PageContext | undefined,
  settings: ExtensionSettings
): Promise<AiCardResult> {
  return identifyImage(imageDataUrl, context, settings, "card");
}

export async function identifySlabLabel(
  imageDataUrl: string,
  context: PageContext | undefined,
  settings: ExtensionSettings
): Promise<AiCardResult> {
  return identifyImage(imageDataUrl, context, settings, "slab-label");
}

async function identifyImage(
  imageDataUrl: string,
  context: PageContext | undefined,
  settings: ExtensionSettings,
  mode: IdentifyMode
): Promise<AiCardResult> {
  const fallback = inferIdentityFromContext(context);
  const provider = settings.provider;
  if (provider.provider === "mock" || !provider.apiKey.trim()) {
    return { identity: fallback };
  }

  if (provider.provider === "anthropic") {
    return identifyWithAnthropic(imageDataUrl, context, provider, fallback, mode).catch((caught) => {
      if (isAbortError(caught)) return { identity: fallback, error: timeoutMessage(provider, mode) };
      throw caught;
    });
  }

  return identifyWithOpenAiCompatible(imageDataUrl, context, provider, fallback, mode).catch((caught) => {
    if (isAbortError(caught)) return { identity: fallback, error: timeoutMessage(provider, mode) };
    throw caught;
  });
}

async function identifyWithOpenAiCompatible(
  imageDataUrl: string,
  context: PageContext | undefined,
  provider: ProviderSettings,
  fallback: CardIdentity,
  mode: IdentifyMode
): Promise<AiCardResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    // OpenRouter otherwise defaults to the model's very large output limit,
    // which can exceed the account's available credits before generation starts.
    max_tokens: 1200,
    temperature: 0.1,
    messages: [
      { role: "system", content: buildPrompt(mode) },
      {
        role: "user",
        content: [
          { type: "text", text: contextText(context) },
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } }
        ]
      }
    ]
  };

  if (provider.provider === "openai") {
    body.response_format = { type: "json_object" };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${provider.apiKey}`,
    "Content-Type": "application/json"
  };

  if (provider.provider === "openrouter") {
    headers["HTTP-Referer"] = "chrome-extension://cardsync";
    headers["X-OpenRouter-Title"] = "CardSync";
  }

  const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutForMode(mode))
  });

  if (!response.ok) {
    throw new Error(await providerResponseError(response, provider));
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : content?.find((part) => part.type === "text")?.text;
  return parseProviderJson(text, fallback);
}

async function identifyWithAnthropic(
  imageDataUrl: string,
  context: PageContext | undefined,
  provider: ProviderSettings,
  fallback: CardIdentity,
  mode: IdentifyMode
): Promise<AiCardResult> {
  const image = splitDataUrl(imageDataUrl);
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 1200,
      temperature: 0.1,
      system: buildPrompt(mode),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: image.mediaType,
                data: image.base64
              }
            },
            { type: "text", text: contextText(context) }
          ]
        }
      ]
    }),
    signal: AbortSignal.timeout(timeoutForMode(mode))
  });

  if (!response.ok) {
    throw new Error(await providerResponseError(response, provider));
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = payload.content?.find((part) => part.type === "text")?.text;
  return parseProviderJson(text, fallback);
}

function buildPrompt(mode: IdentifyMode): string {
  const slabInstructions =
    mode === "slab-label"
      ? [
          "The image is expected to be only the top label area of a graded slab.",
          "Prioritize exact OCR from the slab label: player/name, year, set, card number, parallel, grade company, numeric grade, and cert/serial if visible.",
          "If the crop is not a readable slab label, return the fallback/page-text identity with confidence below 0.45 and explain that the slab label was not readable.",
          "Do not identify from card art when the slab label text is missing."
        ]
      : [
          "Identify the visible card if possible. Use page text as weak evidence, not truth.",
          "If a graded slab label is visible, read the label text first because it is stronger evidence than card art."
        ];
  const prompt = [
    "You identify sports trading cards in livestream screenshots for a sudden-death auction helper.",
    "Return strict JSON only.",
    ...slabInstructions,
    "If year, set, player, grade, card number, or parallel is uncertain, leave it blank or lower confidence.",
    "You may include a broad provisional USD estimate only when useful for a 15-30 second buyer risk signal.",
    "Do not pretend the estimate is a sold comp.",
    "",
    "JSON shape:",
    "{",
    '  "identity": { "sport": "", "player": "", "year": "", "set": "", "cardNumber": "", "parallel": "", "gradeCompany": "", "grade": "", "serialNumber": "", "autograph": false, "relic": false, "rawText": "", "confidence": 0.0, "evidence": [], "alternatives": [] },',
    '  "estimate": { "low": 0, "high": 0, "maxBid": 0, "confidence": 0.0, "reasons": [], "warnings": [] }',
    "}"
  ].join("\n");
  return prompt;
}

function contextText(context: PageContext | undefined): string {
  return [
    `Page title: ${context?.title ?? ""}`,
    `Auction text (weak evidence only): ${context?.auctionText ?? ""}`
  ].join("\n");
}

function parseProviderJson(text: string | undefined, fallback: CardIdentity): AiCardResult {
  if (!text) return { identity: fallback };
  const parsed = JSON.parse(stripJsonFence(text)) as Record<string, unknown>;
  return {
    identity: coerceIdentity(parsed.identity ?? parsed, fallback),
    estimate: coerceEstimate(parsed.estimate)
  };
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function splitDataUrl(dataUrl: string): { mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; base64: string } {
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/);
  if (!match) return { mediaType: "image/jpeg", base64: dataUrl.replace(/^data:[^,]+,/, "") };
  return {
    mediaType: match[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
    base64: match[2]
  };
}

function providerLabel(provider: ProviderSettings): string {
  if (provider.provider === "openai") return "OpenAI";
  if (provider.provider === "openrouter") return "OpenRouter";
  if (provider.provider === "anthropic") return "Anthropic";
  if (provider.provider === "custom-openai-compatible") return "Custom provider";
  return "AI provider";
}

async function providerResponseError(response: Response, provider: ProviderSettings): Promise<string> {
  let detail = "";
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } | string; message?: unknown };
    const value = typeof payload.error === "object" && payload.error !== null
      ? payload.error.message
      : typeof payload.error === "string"
        ? payload.error
        : payload.message;
    if (typeof value === "string") {
      detail = value
        .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
        .replace(/\b(?:sk-or-v1-|sk-proj-|sk-ant-|sk-)\S+/gi, "[redacted key]")
        .slice(0, 240);
    }
  } catch {
    // Keep the HTTP status even if the provider returns an unreadable error body.
  }
  return `${providerLabel(provider)} returned ${response.status}${detail ? `: ${detail}` : ""}`;
}

function timeoutForMode(mode: IdentifyMode): number {
  return mode === "slab-label" ? 6000 : 12000;
}

function timeoutMessage(provider: ProviderSettings, mode: IdentifyMode): string {
  const seconds = Math.round(timeoutForMode(mode) / 1000);
  return `${providerLabel(provider)} card identification timed out after ${seconds} seconds. Click the card outline to retry.`;
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && (value.name === "TimeoutError" || value.name === "AbortError");
}

function coerceEstimate(value: unknown): AiValueEstimate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    low: asPositiveNumber(raw.low),
    high: asPositiveNumber(raw.high),
    maxBid: asPositiveNumber(raw.maxBid) ?? asPositiveNumber(raw.max_bid),
    confidence: asConfidence(raw.confidence),
    reasons: asStringArray(raw.reasons),
    warnings: asStringArray(raw.warnings)
  };
}

function asPositiveNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function asConfidence(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 5);
}
