# CardSync Comp Proxy

Cloudflare Worker proxy for SportsCardsPro / PriceCharting price-guide lookups.

The Chrome extension calls:

```text
POST /v1/price-guide/lookup
```

The worker keeps `SPORTSCARDSPRO_TOKEN` server-side, searches `/api/products`, fetches the best `/api/product`, normalizes the selected grade/condition price, and returns a `PriceGuideQuote`.

## Local Dev

```bash
npx wrangler dev worker/src/index.ts --config worker/wrangler.toml --local --port 8787
```

Set the secret before deployed use:

```bash
npx wrangler secret put SPORTSCARDSPRO_TOKEN --config worker/wrangler.toml
```

For local testing, use a `.dev.vars` file inside `worker/` with:

```text
SPORTSCARDSPRO_TOKEN=your_40_character_token
```
