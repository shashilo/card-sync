export const PENDING_CAPTURE_KEY = "cardsync.pendingCapture";

export interface PendingCapture {
  streamId: string;
  targetTabId: number;
  url: string;
  createdAt: number;
}

export async function savePendingCapture(capture: PendingCapture): Promise<void> {
  await chrome.storage.session.set({ [PENDING_CAPTURE_KEY]: capture });
}

export async function consumePendingCapture(): Promise<PendingCapture | undefined> {
  const result = await chrome.storage.session.get(PENDING_CAPTURE_KEY);
  await chrome.storage.session.remove(PENDING_CAPTURE_KEY);
  const capture = result[PENDING_CAPTURE_KEY] as PendingCapture | undefined;
  if (!capture || Date.now() - capture.createdAt > 8000) return undefined;
  return capture;
}
