# CardSync Whatnot pilot

CardSync is a Chrome MV3 extension prototype for buyer-side, user-initiated scanning of a Whatnot livestream tab. It outlines card-shaped regions, asks a configured vision provider to read a crop, and offers research links. With no configured AI key, page text is only a low-confidence lead and does not trigger a priced recommendation.

**This build is not validated for paid use or a two-second exact valuation claim.** The [Whatnot readiness audit](docs/WHATNOT_READINESS_AUDIT.md) records the code review, tests, blockers, and field-validation gate. The separate [Expo mobile prototype](apps/mobile/README.md) uses synthetic sample sales and does not analyze live photos.

## Run the extension locally

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Load `dist/` as an unpacked extension in Chrome. Open a Whatnot live show, click the CardSync toolbar icon to arm tab capture, and use the side panel to inspect the current candidate. If no outline appears, hold Shift and drag a rectangle around the card on the Whatnot page to force a crop; the selected card remains visible for about 12 seconds. A card moving, turning, or leaving the frame may delay or prevent a readable result. Manually verify identity and every price before bidding.

`package.json` is the version source. Every `npm run build` or `pnpm build` copies its version into `public/manifest.json` before building `dist/`. Change the package version when releasing an update, then reload the unpacked extension in `chrome://extensions`. Building does not fetch source updates; pull or apply them first.

The default vision setting is `Mock/page-text only` and the price-guide proxy URL is blank. For visual identification, set a user-owned OpenAI, OpenRouter, Anthropic, or compatible endpoint key in Settings. This prototype stores the key in `chrome.storage.local` and sends card crops to that provider. Scans and crops can also be retained locally in IndexedDB until the show's history is cleared. Do not use sensitive streams without understanding those transmissions and storage.

The default pricing path searches and parses eBay sold-result HTML, which can fail or misread results. At least three matching parsed rows with a sold marker are required for a provisional range. Those rows are not a licensed or independently confirmed sales feed, and the UI deliberately does not display a suggested maximum bid.

## Optional local guide proxy

For an authorized SportsCardsPro account, run the [Worker](worker/README.md) locally, set its token in `worker/.dev.vars`, and enter `http://127.0.0.1:8787/v1/price-guide/lookup` as the extension's proxy URL. A matched guide price is labeled as a guide reference with zero individual sold transactions. SportsCardsPro's API does not provide historic sales, and displaying its data to customers requires a separate commercial license and express written permission. The current Worker has no user authentication or centralized quota, so it must not be deployed as a public paid-service endpoint.
