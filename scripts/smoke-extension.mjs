import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const chromeForTestingPath = resolve(
  ".cache/puppeteer-browsers/chrome/mac_arm-150.0.7871.115/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
);
const chromePath =
  process.env.CHROME_PATH ||
  (existsSync(chromeForTestingPath) ? chromeForTestingPath : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const extensionPath = resolve("dist");
const smokeUrl = "https://www.whatnot.com/live/cardsync-smoke";
const userDataDir = await mkdtemp(join(tmpdir(), "cardsync-chrome-"));
const errors = [];

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: process.env.CARDSYNC_HEADFUL === "1" ? false : "new",
  ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
  userDataDir,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-default-browser-check",
    "--no-first-run"
  ]
});

try {
  const worker = await findCardSyncWorker(browser);

  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !text.includes("favicon.ico")) errors.push(text);
  });

  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.url() === smokeUrl) {
      request.respond({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
          <html>
            <head><title>CardSync Smoke</title></head>
            <body>
              <h1>Whatnot Smoke Page</h1>
              <video width="640" height="360" muted playsinline></video>
              <div data-testid="auction-title">1986 Fleer Michael Jordan #57 PSA</div>
            </body>
          </html>`
      });
      return;
    }

    if (request.url().endsWith("/favicon.ico")) {
      request.respond({ status: 204, body: "" });
      return;
    }

    request.abort();
  });

  await page.goto(smokeUrl, { waitUntil: "domcontentloaded" });
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("No active tab available for smoke injection.");
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-script.js"]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-script.js"]
    });
    const context = await chrome.tabs.sendMessage(tab.id, { type: "CS_GET_CONTEXT" });
    if (!context?.auctionText?.includes("Michael Jordan")) {
      throw new Error(`Unexpected page context from content script: ${JSON.stringify(context)}`);
    }
    await chrome.tabs.sendMessage(tab.id, { type: "CS_SET_SCANNING", scanning: true });
    await chrome.tabs.sendMessage(tab.id, {
      type: "CS_RENDER_TRACKS",
      tracks: [
        {
          id: "smoke-track",
          box: { x: 24, y: 24, width: 180, height: 250 },
          detectionConfidence: 0.9,
          stage: "fast-value",
          badgeTone: "yellow",
          label: "$80-$115 · Max $92 · 68%",
          compLinks: [],
          updatedAt: Date.now()
        }
      ]
    });
  });
  await page.waitForFunction(() => document.documentElement.getAttribute("data-cardsync-content") === "ready", {
    timeout: 5000
  }).catch((error) => {
    const extensionTargets = browser
      .targets()
      .filter((target) => target.url().startsWith("chrome-extension://"))
      .map((target) => `${target.type()}: ${target.url()}`);
    throw new Error(
      [
        error.message,
        "Content script readiness marker was not found.",
        `Extension targets: ${extensionTargets.length ? extensionTargets.join(" | ") : "none"}`
      ].join("\n")
    );
  });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#cardsync-overlay-root").length === 1 &&
      Boolean(document.getElementById("cardsync-overlay-root")?.shadowRoot?.querySelector(".frame")),
    { timeout: 5000 }
  );
  await new Promise((resolveReady) => setTimeout(resolveReady, 1200));

  if (errors.length > 0) {
    throw new Error(`Extension smoke test saw console errors:\n${errors.join("\n")}`);
  }

  console.log("CardSync extension smoke test passed.");
} finally {
  await browser.close();
  await rm(userDataDir, { recursive: true, force: true });
}

async function findCardSyncWorker(browser) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    for (const target of browser.targets()) {
      if (target.type() !== "service_worker" || !target.url().startsWith("chrome-extension://")) continue;
      const worker = await target.worker();
      if (!worker) continue;
      const name = await worker.evaluate(() => chrome.runtime.getManifest().name).catch(() => "");
      if (name === "CardSync Sudden-Death POC") return worker;
    }

    await new Promise((resolveWorker) => setTimeout(resolveWorker, 150));
  }

  const extensionTargets = browser
    .targets()
    .filter((target) => target.url().startsWith("chrome-extension://"))
    .map((target) => `${target.type()}: ${target.url()}`);
  throw new Error(`CardSync service worker was not found. Extension targets: ${extensionTargets.join(" | ") || "none"}`);
}
