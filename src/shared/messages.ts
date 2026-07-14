import type { PendingCapture } from "./capture";
import type { PageContext, TrackSummary } from "./types";

export type RuntimeMessage =
  | { type: "CS_CONTEXT"; context: PageContext }
  | { type: "CS_RENDER_TRACKS"; tracks: TrackSummary[] }
  | { type: "CS_CLEAR_OVERLAY" }
  | { type: "CS_SET_SCANNING"; scanning: boolean }
  | { type: "CS_BADGE_CLICK"; trackId: string }
  | { type: "BG_CAPTURE_READY"; capture: PendingCapture }
  | { type: "BG_CAPTURE_ERROR"; message: string }
  | { type: "BG_GET_ACTIVE_TAB" };

export async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

export async function sendToActiveTab(message: RuntimeMessage): Promise<void> {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
}

export async function sendToTab(tabId: number, message: RuntimeMessage): Promise<void> {
  await chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}
