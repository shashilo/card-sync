import type { RuntimeMessage } from "../shared/messages";
import type { Box, PageContext, TrackSummary, VideoViewport } from "../shared/types";

const OVERLAY_ID = "cardsync-overlay-root";

let root: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let scanning = false;
let disabled = false;

function disableContentScript(): void {
  disabled = true;
  scanning = false;
}

function isContextInvalidated(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("extension context invalidated");
}

function sendRuntimeMessage(message: RuntimeMessage): void {
  if (disabled) return;

  try {
    chrome.runtime.sendMessage(message, () => {
      const error = chrome.runtime.lastError;
      if (error?.message?.toLowerCase().includes("extension context invalidated")) disableContentScript();
    });
  } catch (error) {
    if (isContextInvalidated(error)) disableContentScript();
  }
}

function queryAll(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function ensureOverlay(): ShadowRoot | undefined {
  if (disabled) return undefined;
  if (shadow) return shadow;
  if (!document.documentElement) return undefined;

  root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.zIndex = "2147483647";
  root.style.pointerEvents = "none";
  root.style.contain = "layout style paint";

  shadow = root.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .frame {
      position: fixed;
      border: 2px solid rgba(156, 163, 175, 0.95);
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45), 0 8px 30px rgba(0, 0, 0, 0.28);
      box-sizing: border-box;
      transition: transform 120ms linear, width 120ms linear, height 120ms linear, border-color 120ms ease;
      pointer-events: none;
    }
    .frame.yellow { border-color: rgb(245, 158, 11); }
    .frame.green { border-color: rgb(16, 185, 129); }
    .frame.red { border-color: rgb(239, 68, 68); }
    .badge {
      position: absolute;
      left: 0;
      top: -34px;
      max-width: min(280px, calc(100vw - 24px));
      padding: 6px 8px;
      border-radius: 7px;
      background: rgba(17, 24, 39, 0.92);
      color: white;
      font: 600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: auto;
      cursor: pointer;
      user-select: none;
    }
    .badge.yellow { background: rgba(146, 64, 14, 0.94); }
    .badge.green { background: rgba(6, 95, 70, 0.94); }
    .badge.red { background: rgba(127, 29, 29, 0.95); }
    .status {
      position: fixed;
      right: 14px;
      bottom: 14px;
      padding: 7px 9px;
      border-radius: 7px;
      background: rgba(17, 24, 39, 0.86);
      color: #fff;
      font: 600 12px/1.1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: none;
    }
  `;
  shadow.append(style);
  document.documentElement.append(root);
  return shadow;
}

function getLargestVideoRect(): Box | undefined {
  if (disabled) return undefined;
  const videos = queryAll("video").filter((element): element is HTMLVideoElement => element instanceof HTMLVideoElement);
  let best: Box | undefined;
  let bestArea = 0;

  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    const area = width * height;
    if (area > bestArea && width >= 160 && height >= 120) {
      bestArea = area;
      best = {
        x: Math.max(rect.left, 0),
        y: Math.max(rect.top, 0),
        width,
        height
      };
    }
  }

  return best;
}

function collectAuctionText(): string {
  if (disabled) return "";
  const selectors = [
    "[data-testid*='auction' i]",
    "[data-testid*='product' i]",
    "[data-testid*='listing' i]",
    "[aria-label*='auction' i]",
    "h1",
    "h2"
  ];
  const pieces = new Set<string>();

  for (const selector of selectors) {
    for (const element of queryAll(selector)) {
      const text = element.textContent?.replace(/\s+/g, " ").trim();
      if (text && text.length > 2 && text.length < 240) pieces.add(text);
    }
  }

  return Array.from(pieces).slice(0, 12).join(" | ");
}

function collectVisibleText(): string {
  if (disabled) return "";
  const text = document.body?.innerText ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, 4000);
}

function currentContext(): PageContext {
  const videoViewport: VideoViewport = {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    videoRect: getLargestVideoRect()
  };

  return {
    url: location.href,
    title: document.title,
    visibleText: collectVisibleText(),
    auctionText: collectAuctionText(),
    videoViewport,
    collectedAt: Date.now()
  };
}

function renderTracks(tracks: TrackSummary[]): void {
  if (disabled) return;
  const target = ensureOverlay();
  if (!target) return;
  target.querySelectorAll(".frame").forEach((node) => node.remove());
  target.querySelectorAll(".status").forEach((node) => node.remove());

  for (const track of tracks) {
    const frame = document.createElement("div");
    frame.className = `frame ${track.badgeTone}`;
    frame.style.transform = `translate(${track.box.x}px, ${track.box.y}px)`;
    frame.style.width = `${track.box.width}px`;
    frame.style.height = `${track.box.height}px`;

    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = `badge ${track.badgeTone}`;
    badge.textContent = track.label;
    badge.title = "Open CardSync details";
    badge.addEventListener("click", () => {
      sendRuntimeMessage({ type: "CS_BADGE_CLICK", trackId: track.id });
    });
    frame.append(badge);
    target.append(frame);
  }

  if (scanning) {
    const status = document.createElement("div");
    status.className = "status";
    status.textContent = tracks.length ? "CardSync scanning" : "CardSync looking for cards";
    target.append(status);
  }
}

function setScanning(next: boolean): void {
  if (disabled) return;
  scanning = next;
  if (!next) renderTracks([]);
  else ensureOverlay();
}

try {
  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    if (disabled) return;

    try {
      if (message.type === "CS_GET_CONTEXT") {
        sendResponse(currentContext());
        return;
      }

      if (message.type === "CS_RENDER_TRACKS") {
        renderTracks(message.tracks);
        return;
      }

      if (message.type === "CS_CLEAR_OVERLAY") {
        renderTracks([]);
        return;
      }

      if (message.type === "CS_SET_SCANNING") {
        setScanning(message.scanning);
      }
    } catch (error) {
      if (isContextInvalidated(error)) disableContentScript();
    }
  });
} catch (error) {
  if (isContextInvalidated(error)) disableContentScript();
}

window.addEventListener("pagehide", disableContentScript, { once: true });
