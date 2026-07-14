import { describe, expect, it, vi } from "vitest";
import { handleRequest, type Env } from "../../worker/src/index";

const env: Env = {
  SPORTSCARDSPRO_TOKEN: "test-token",
  SPORTSCARDSPRO_BASE_URL: "https://provider.test",
  CACHE_TTL_SECONDS: "60"
};

const identity = {
  sport: "Basketball",
  player: "Michael Jordan",
  year: "1986",
  set: "Fleer",
  cardNumber: "57",
  rawText: "1986 Fleer Michael Jordan #57",
  confidence: 0.84,
  evidence: ["test"],
  alternatives: []
};

describe("comp proxy worker", () => {
  it("returns a safe error when the provider token is missing", async () => {
    const response = await handleRequest(
      new Request("https://cardsync.test/v1/price-guide/lookup", {
        method: "POST",
        body: JSON.stringify({ identity })
      }),
      {}
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "SportsCardsPro token is not configured."
    });
  });

  it("searches products, fetches the best product, and returns a normalized quote", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/products") {
        return Response.json({
          status: "success",
          products: [
            {
              id: "72584",
              "product-name": "Michael Jordan #57",
              "console-name": "Basketball Cards 1986 Fleer"
            }
          ]
        });
      }

      return Response.json({
        status: "success",
        id: "72584",
        "product-name": "Michael Jordan #57",
        "console-name": "Basketball Cards 1986 Fleer",
        "loose-price": 225500
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://cardsync.test/v1/price-guide/lookup", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ identity })
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      quote: {
        provider: "sportscardspro",
        productId: "72584",
        selectedCondition: "Ungraded",
        selectedPrice: 2255
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
