import type { RuntimeMessage } from "../shared/messages";
import type { Box, PageContext, TrackSummary, VideoViewport } from "../shared/types";

const OVERLAY_ID = "cardsync-overlay-root";
const READY_ATTR = "data-cardsync-content";

type CardSyncContentState = {
  root: HTMLDivElement | null;
  shadow: ShadowRoot | null;
  scanning: boolean;
  disabled: boolean;
  generation: number;
};

declare global {
  interface Window {
    __cardsyncContentState?: CardSyncContentState;
  }
}

const state: CardSyncContentState = window.__cardsyncContentState ?? {
  root: null,
  shadow: null,
  scanning: false,
  disabled: false,
  generation: 0
};

state.disabled = false;
state.generation += 1;
window.__cardsyncContentState = state;
const scriptGeneration = state.generation;

function markReady(): void {
  try {
    document.documentElement?.setAttribute(READY_ATTR, "ready");
  } catch {
    // The page may be navigating while Chrome injects the content script.
  }
}

function disableContentScript(): void {
  state.disabled = true;
  state.scanning = false;
}

function isContextInvalidated(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("extension context invalidated");
}

function sendRuntimeMessage(message: RuntimeMessage): void {
  if (state.disabled) return;

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
  if (state.disabled) return undefined;
  if (state.shadow && state.root?.isConnected) return state.shadow;
  if (!document.documentElement) return undefined;

  const existingRoot = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (existingRoot?.shadowRoot) {
    state.root = existingRoot;
    state.shadow = existingRoot.shadowRoot;
    return state.shadow;
  }

  existingRoot?.remove();

  state.root = document.createElement("div");
  state.root.id = OVERLAY_ID;
  state.root.style.position = "fixed";
  state.root.style.inset = "0";
  state.root.style.zIndex = "2147483647";
  state.root.style.pointerEvents = "none";
  state.root.style.contain = "layout style paint";

  state.shadow = state.root.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .frame {
      position: fixed;
      border: 2px solid rgba(156, 163, 175, 0.95);
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45), 0 8px 30px rgba(0, 0, 0, 0.28);
      box-sizing: border-box;
      transition: transform 120ms linear, width 120ms linear, height 120ms linear, border-color 120ms ease;
      pointer-events: auto;
      cursor: crosshair;
    }
    .frame.yellow { border-color: rgb(245, 158, 11); }
    .frame.green { border-color: rgb(16, 185, 129); }
    .frame.red { border-color: rgb(239, 68, 68); }
    .captureZone {
      position: fixed;
      border: 0;
      padding: 0;
      margin: 0;
      background: rgba(0, 0, 0, 0);
      box-shadow: none;
      outline: none;
      pointer-events: auto;
      cursor: crosshair;
    }
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
      border: 0;
      padding: 7px 9px;
      border-radius: 7px;
      background: rgba(17, 24, 39, 0.86);
      color: #fff;
      font: 600 12px/1.1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: auto;
      cursor: pointer;
    }
    .status:disabled {
      opacity: 0.78;
      cursor: default;
    }
  `;
  state.shadow.append(style);
  document.documentElement.append(state.root);
  return state.shadow;
}

function getLargestVideoRect(): Box | undefined {
  if (state.disabled) return undefined;
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
  if (state.disabled) return "";
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
  if (state.disabled) return "";
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
  if (state.disabled) return;
  const target = ensureOverlay();
  if (!target) return;
  const videoRect = getLargestVideoRect();
  target.querySelectorAll(".captureZone").forEach((node) => node.remove());
  target.querySelectorAll(".frame").forEach((node) => node.remove());
  target.querySelectorAll(".status").forEach((node) => node.remove());

  if (state.scanning && tracks.length && videoRect) {
    const captureZone = document.createElement("div");
    captureZone.className = "captureZone";
    captureZone.title = "Capture current card";
    captureZone.style.transform = `translate(${videoRect.x}px, ${videoRect.y}px)`;
    captureZone.style.width = `${videoRect.width}px`;
    captureZone.style.height = `${videoRect.height}px`;
    captureZone.addEventListener("click", (event) => {
      event.stopPropagation();
      if (tracks[0]) requestManualCapture(tracks[0].id);
    });
    target.append(captureZone);
  }

  for (const track of tracks) {
    const box = videoRect ? clampToRect(track.box, videoRect) : track.box;
    if (!box) continue;

    const frame = document.createElement("div");
    frame.className = `frame ${track.badgeTone}`;
    frame.style.transform = `translate(${box.x}px, ${box.y}px)`;
    frame.style.width = `${box.width}px`;
    frame.style.height = `${box.height}px`;
    frame.title = "Capture this card now";
    frame.addEventListener("click", (event) => {
      event.stopPropagation();
      requestManualCapture(track.id);
    });

    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = `badge ${track.badgeTone}`;
    badge.textContent = track.label;
    badge.title = "Capture this card now";
    badge.addEventListener("click", (event) => {
      event.stopPropagation();
      sendRuntimeMessage({ type: "CS_BADGE_CLICK", trackId: track.id });
      requestManualCapture(track.id);
    });
    frame.append(badge);
    target.append(frame);
  }

  if (state.scanning) {
    const status = document.createElement("button");
    status.type = "button";
    status.className = "status";
    status.textContent = tracks.length ? "Capture current card" : "CardSync looking for cards";
    status.title = tracks.length ? "Manual CardSync capture" : "Waiting for a card outline";
    status.disabled = !tracks.length;
    status.addEventListener("click", (event) => {
      event.stopPropagation();
      if (tracks[0]) requestManualCapture(tracks[0].id);
    });
    target.append(status);
  }
}

function requestManualCapture(trackId?: string): void {
  sendRuntimeMessage(trackId ? { type: "CS_MANUAL_CAPTURE", trackId } : { type: "CS_MANUAL_CAPTURE" });
}

function clampToRect(box: Box, bounds: Box): Box | undefined {
  const x1 = Math.max(box.x, bounds.x);
  const y1 = Math.max(box.y, bounds.y);
  const x2 = Math.min(box.x + box.width, bounds.x + bounds.width);
  const y2 = Math.min(box.y + box.height, bounds.y + bounds.height);
  const width = Math.max(0, x2 - x1);
  const height = Math.max(0, y2 - y1);
  if (width < 24 || height < 24) return undefined;
  return { x: x1, y: y1, width, height };
}

function setScanning(next: boolean): void {
  if (state.disabled) return;
  state.scanning = next;
  if (!next) renderTracks([]);
  else ensureOverlay();
}

try {
  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    if (state.disabled || scriptGeneration !== state.generation) return;

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

markReady();
window.addEventListener("pagehide", disableContentScript, { once: true });
