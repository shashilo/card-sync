import {
  buildPriceGuideQuery,
  buildPriceGuideQuote,
  rankPriceGuideCandidates,
  type PriceGuideLookupRequest,
  type PriceGuideLookupResponse
} from "../../src/shared/price-guide";

export interface Env {
  SPORTSCARDSPRO_TOKEN?: string;
  SPORTSCARDSPRO_BASE_URL?: string;
  CACHE_TTL_SECONDS?: string;
  ALLOWED_ORIGINS?: string;
}

const DEFAULT_CACHE_TTL_SECONDS = 24 * 60 * 60;
let lastProviderCallAt = 0;
let providerQueue = Promise.resolve();
const memoryCache = new Map<string, { expiresAt: number; body: PriceGuideLookupResponse }>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  }
};

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const corsHeaders = buildCorsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  const url = new URL(request.url);
  if (url.pathname !== "/v1/price-guide/lookup") {
    return json({ ok: false, error: "Not found" }, 404, corsHeaders);
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "Use POST /v1/price-guide/lookup" }, 405, corsHeaders);
  }

  if (!env.SPORTSCARDSPRO_TOKEN?.trim()) {
    return json({ ok: false, status: "missing-token", error: "SportsCardsPro token is not configured." }, 500, corsHeaders);
  }

  const body = (await request.json().catch(() => undefined)) as Partial<PriceGuideLookupRequest> | undefined;
  if (!body?.identity) {
    return json({ ok: false, error: "Missing card identity." }, 400, corsHeaders);
  }

  const built = buildPriceGuideQuery(body.identity);
  const query = (body.query || built.query).trim();
  if (!query) {
    return json({ ok: false, error: "No searchable card identity." }, 400, corsHeaders);
  }

  const cacheKey = await hashJson({ query, identity: body.identity });
  const cached = await getCached(cacheKey);
  if (cached) return json(cached, 200, corsHeaders);

  const baseUrl = env.SPORTSCARDSPRO_BASE_URL || "https://www.pricecharting.com";
  const fastProductUrl = withParams(`${baseUrl}/api/product`, {
    t: env.SPORTSCARDSPRO_TOKEN,
    q: query
  });
  const fastProductResponse = await providerJson(fastProductUrl);
  if (isSuccess(fastProductResponse) && fastProductResponse.id) {
    const ranked = rankPriceGuideCandidates(body.identity, [fastProductResponse]);
    const top = ranked[0];
    const quote = buildPriceGuideQuote(body.identity, query, top, fastProductResponse);
    const response = { ok: true, status: "ready", quote } satisfies PriceGuideLookupResponse;
    await putCached(cacheKey, response, cacheTtlSeconds(env));
    return json(response, 200, corsHeaders);
  }

  const productsUrl = withParams(`${baseUrl}/api/products`, {
    t: env.SPORTSCARDSPRO_TOKEN,
    q: query
  });

  const productsResponse = await providerJson(productsUrl);
  if (!isSuccess(productsResponse)) {
    const error = stringValue(productsResponse["error-message"]) || "SportsCardsPro product search failed.";
    return json({ ok: false, status: "error", error }, 502, corsHeaders);
  }

  const products = Array.isArray(productsResponse.products) ? productsResponse.products : [];
  const ranked = rankPriceGuideCandidates(body.identity, products);
  const top = ranked[0];
  if (!top?.product.id) {
    const response = { ok: true, status: "no-match", error: "SportsCardsPro did not return a matching product." } satisfies PriceGuideLookupResponse;
    await putCached(cacheKey, response, cacheTtlSeconds(env));
    return json(response, 200, corsHeaders);
  }

  const productUrl = withParams(`${baseUrl}/api/product`, {
    t: env.SPORTSCARDSPRO_TOKEN,
    id: String(top.product.id)
  });
  const productResponse = await providerJson(productUrl);
  if (!isSuccess(productResponse)) {
    const error = stringValue(productResponse["error-message"]) || "SportsCardsPro product lookup failed.";
    return json({ ok: false, status: "error", error }, 502, corsHeaders);
  }

  const quote = buildPriceGuideQuote(body.identity, query, top, productResponse);
  const response = { ok: true, status: "ready", quote } satisfies PriceGuideLookupResponse;
  await putCached(cacheKey, response, cacheTtlSeconds(env));
  return json(response, 200, corsHeaders);
}

async function providerJson(url: URL): Promise<Record<string, unknown>> {
  return queuedProviderFetch(async () => {
    const response = await fetch(url.toString(), {
      headers: {
        accept: "application/json"
      }
    });
    return (await response.json()) as Record<string, unknown>;
  });
}

async function queuedProviderFetch<T>(operation: () => Promise<T>): Promise<T> {
  const queued = providerQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, 1050 - (now - lastProviderCallAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastProviderCallAt = Date.now();
    return operation();
  });
  providerQueue = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

async function getCached(cacheKey: string): Promise<PriceGuideLookupResponse | undefined> {
  const cache = await workerCache();
  const cacheRequest = new Request(`https://cardsync-cache.local/${cacheKey}`);
  const cachedResponse = await cache?.match(cacheRequest);
  if (cachedResponse) return (await cachedResponse.json()) as PriceGuideLookupResponse;

  const cachedMemory = memoryCache.get(cacheKey);
  if (!cachedMemory) return undefined;
  if (Date.now() > cachedMemory.expiresAt) {
    memoryCache.delete(cacheKey);
    return undefined;
  }
  return cachedMemory.body;
}

async function putCached(cacheKey: string, body: PriceGuideLookupResponse, ttlSeconds: number): Promise<void> {
  const cache = await workerCache();
  const cacheRequest = new Request(`https://cardsync-cache.local/${cacheKey}`);
  const response = new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${ttlSeconds}`
    }
  });
  await cache?.put(cacheRequest, response.clone());
  memoryCache.set(cacheKey, {
    expiresAt: Date.now() + ttlSeconds * 1000,
    body
  });
}

async function workerCache(): Promise<Cache | undefined> {
  const maybeCaches = globalThis.caches as CacheStorage & { default?: Cache };
  return maybeCaches?.default;
}

async function hashJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function withParams(base: string, params: Record<string, string | undefined>): URL {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url;
}

function json(body: PriceGuideLookupResponse, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "content-type": "application/json"
    }
  });
}

function buildCorsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("origin") ?? "*";
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const allowOrigin = allowed.length ? (allowed.includes(origin) ? origin : allowed[0]) : "*";

  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  };
}

function cacheTtlSeconds(env: Env): number {
  const ttl = Number(env.CACHE_TTL_SECONDS);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_CACHE_TTL_SECONDS;
}

function isSuccess(response: Record<string, unknown>): boolean {
  return response.status === "success";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
