import type { BadgeTone, CardIdentity, CompLink, PriceLookupState, ScanHistoryItem, ScanStage, SoldComp, Valuation } from "../../shared/types";

const DB_NAME = "cardsync-scan-history";
const STORE_NAME = "scanHistory";
const DB_VERSION = 1;

export interface HistoryUpsertInput {
  id: string;
  showKey: string;
  showUrl: string;
  seenAt: number;
  cropImageDataUrl?: string;
  detectionConfidence: number;
  stage: ScanStage;
  badgeTone: BadgeTone;
  label: string;
  identity?: CardIdentity;
  valuation?: Valuation;
  compLinks: CompLink[];
  freeComps?: SoldComp[];
  priceLookup?: PriceLookupState;
}

export function showKeyFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const liveMatch = parsed.pathname.match(/^\/live\/([^/?#]+)/i);
    if (liveMatch) return `${parsed.hostname.toLowerCase()}/live/${liveMatch[1]}`;
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return url.trim() || "unknown-show";
  }
}

export function buildScanHistoryItem(input: HistoryUpsertInput, existing?: ScanHistoryItem): ScanHistoryItem {
  const valuationWarnings = input.valuation?.warnings ?? existing?.valuation?.warnings ?? [];
  const identityEvidence = input.identity?.evidence ?? existing?.identity?.evidence ?? [];
  const valuationReasons = input.valuation?.reasons ?? existing?.valuation?.reasons ?? [];

  return {
    id: input.id,
    showKey: input.showKey,
    showUrl: input.showUrl,
    firstSeenAt: existing?.firstSeenAt ?? input.seenAt,
    lastSeenAt: input.seenAt,
    cropImageDataUrl: input.cropImageDataUrl ?? existing?.cropImageDataUrl ?? "",
    detectionConfidence: Math.max(existing?.detectionConfidence ?? 0, input.detectionConfidence),
    stage: input.stage,
    badgeTone: input.badgeTone,
    label: input.label,
    identity: input.identity ?? existing?.identity,
    valuation: input.valuation ?? existing?.valuation,
    compLinks: input.compLinks.length ? input.compLinks : existing?.compLinks ?? [],
    freeComps: input.freeComps?.length ? input.freeComps : existing?.freeComps,
    priceLookup: input.priceLookup ?? existing?.priceLookup,
    evidence: [...identityEvidence, ...valuationReasons].slice(0, 8),
    warnings: valuationWarnings.slice(0, 8),
    updatedAt: input.seenAt
  };
}

export async function listShowHistory(showKey: string): Promise<ScanHistoryItem[]> {
  const db = await openHistoryDb();
  const transaction = db.transaction(STORE_NAME, "readonly");
  const index = transaction.objectStore(STORE_NAME).index("showKey");
  const items = await requestToPromise<ScanHistoryItem[]>(index.getAll(showKey));
  db.close();
  return items.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export async function upsertScanHistoryItem(input: HistoryUpsertInput): Promise<ScanHistoryItem> {
  const db = await openHistoryDb();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const existing = await requestToPromise<ScanHistoryItem | undefined>(store.get(input.id));
  const item = buildScanHistoryItem(input, existing);
  await requestToPromise(store.put(item));
  await done;
  db.close();
  return item;
}

export async function clearShowHistory(showKey: string): Promise<void> {
  const db = await openHistoryDb();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const done = transactionDone(transaction);
  const index = transaction.objectStore(STORE_NAME).index("showKey");
  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(showKey));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
  });
  await done;
  db.close();
}

async function openHistoryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("showKey", "showKey", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestToPromise<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
