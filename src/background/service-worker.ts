import { savePendingCapture, type PendingCapture } from "../shared/capture";

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
  if (message?.type === "CS_BADGE_CLICK" && sender.tab?.id) {
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

  chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
    const error = chrome.runtime.lastError;

    if (error || !streamId) {
      chrome.runtime.sendMessage({
        type: "BG_CAPTURE_ERROR",
        message: error?.message ?? "Unable to arm tab capture."
      });
      return;
    }

    const capture: PendingCapture = {
      streamId,
      targetTabId: tabId,
      url: tab.url ?? "",
      createdAt: Date.now()
    };

    savePendingCapture(capture).then(() => {
      chrome.runtime.sendMessage({ type: "BG_CAPTURE_READY", capture }).catch(() => undefined);
    });
  });
});
