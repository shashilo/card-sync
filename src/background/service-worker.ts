import { savePendingCapture, type PendingCapture } from "../shared/capture";
import type { RuntimeMessage } from "../shared/messages";

const WHATNOT_RE = /^https:\/\/([a-z0-9-]+\.)?whatnot\.com\//i;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);

async function configureSidePanel(tabId: number, url?: string): Promise<void> {
  const enabled = Boolean(url && WHATNOT_RE.test(url));
  await chrome.sidePanel.setOptions({
    tabId,
    path: "sidepanel.html",
    enabled
  });
}

function reportCaptureError(message: string): void {
  chrome.runtime
    .sendMessage({ type: "BG_CAPTURE_ERROR", message } satisfies RuntimeMessage)
    .catch(() => undefined);
}

async function hasContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "CS_GET_CONTEXT" } satisfies RuntimeMessage);
    return true;
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId: number): Promise<void> {
  if (await hasContentScript(tabId)) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-script.js"]
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  configureSidePanel(tabId, tab.url).catch(() => undefined);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  await configureSidePanel(tabId, tab?.url);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if ((message?.type === "CS_BADGE_CLICK" || message?.type === "CS_MANUAL_CAPTURE") && sender.tab?.id) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => undefined);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "BG_GET_ACTIVE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => sendResponse(tab));
    return true;
  }

  return false;
});

chrome.action.onClicked.addListener((tab) => {
  const tabId = tab.id;
  if (!tabId) return;

  configureSidePanel(tabId, tab.url).catch(() => undefined);
  chrome.sidePanel.open({ tabId }).catch(() => undefined);

  if (!tab.url || !WHATNOT_RE.test(tab.url)) {
    return;
  }

  const contentReady = ensureContentScript(tabId);
  void contentReady.catch(() => undefined);

  chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
    const error = chrome.runtime.lastError;

    if (error || !streamId) {
      reportCaptureError(error?.message ?? "Unable to arm tab capture.");
      return;
    }

    const capture: PendingCapture = {
      streamId,
      targetTabId: tabId,
      url: tab.url ?? "",
      createdAt: Date.now()
    };

    contentReady
      .then(() => savePendingCapture(capture))
      .then(() => {
        chrome.runtime
          .sendMessage({ type: "BG_CAPTURE_READY", capture } satisfies RuntimeMessage)
          .catch(() => undefined);
      })
      .catch((caught: unknown) => {
        reportCaptureError(caught instanceof Error ? caught.message : "Unable to inject CardSync into this tab.");
      });
  });
});
