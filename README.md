# CardSync Sudden-Death POC

CardSync is a Chrome MV3 extension POC for Whatnot live singles auctions. After one user click, it captures the active Whatnot tab, tracks card-shaped regions in the livestream, outlines detected cards on the page, and shows a fast provisional value/max-bid badge while richer details live in the side panel.

## Run Locally

```bash
npm install
npm run build
```

Then load `dist/` as an unpacked extension in Chrome.

## How The POC Works

- The content script injects a transparent overlay on Whatnot pages.
- The side panel starts `tabCapture` after the user clicks `Start scanning`.
- Local canvas vision tracks card-shaped rectangles continuously.
- Stable card crops are sent to the configured AI provider, not every frame.
- In free-comp mode, stable identities are searched in Card Ladder using the signed-in Chrome session; eBay sold listings are the fallback.
- Stable identities can also be sent to a CardSync comp proxy for SportsCardsPro / PriceCharting price-guide values.
- The overlay shows staged states: detecting, candidate, fast value, or price-backed.
- The sidebar shows identity evidence, warnings, and comp-search links.

## BYOK AI Settings

The default provider is `Mock/page-text only`, which can demonstrate tracking and seeded demo values from visible page text. For real visual identification, users bring their own key and choose one of:

- OpenAI / ChatGPT API
- OpenRouter
- Anthropic Claude
- Custom OpenAI-compatible endpoint

API keys are stored locally in `chrome.storage.local` for this POC. CardSync does not pay for or proxy the user's model usage in this BYOK build. Custom endpoints request a narrow Chrome host permission for the configured endpoint instead of using broad default host access.

## Limits

This is decision support, not an appraisal tool. AI-estimated values are labeled provisional. Card Ladder sale extraction requires an active signed-in Pro browser session and is a POC; verify sale matches and prices before relying on them. A configured price-guide proxy takes precedence over free-comp lookup.

## SportsCardsPro Price Guide Proxy

The extension defaults to `http://127.0.0.1:8787/v1/price-guide/lookup` for local POC testing. Run the proxy locally with:

```bash
npx wrangler dev worker/src/index.ts --config worker/wrangler.toml --local --port 8787
```

Set `SPORTSCARDSPRO_TOKEN` in `worker/.dev.vars` for local development or as a Cloudflare Worker secret for deployment. The extension only stores the proxy URL; the SportsCardsPro token stays server-side.
