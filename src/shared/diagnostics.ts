export interface DiagnosticEntry {
  timestamp: number;
  event: string;
  details?: Record<string, string | number | boolean | null>;
}

const STORAGE_KEY = "cardsync.diagnostics";
const MAX_ENTRIES = 300;
let writeQueue: Promise<DiagnosticEntry[]> = Promise.resolve([]);

export function readDiagnosticLog(): Promise<DiagnosticEntry[]> {
  return chrome.storage.local.get(STORAGE_KEY).then((result) =>
    Array.isArray(result[STORAGE_KEY]) ? (result[STORAGE_KEY] as DiagnosticEntry[]) : []
  );
}

export function appendDiagnosticLog(
  event: string,
  details?: Record<string, string | number | boolean | null>
): Promise<DiagnosticEntry[]> {
  const entry: DiagnosticEntry = {
    timestamp: Date.now(),
    event: sanitize(event),
    ...(details ? { details: sanitizeDetails(details) } : {})
  };

  writeQueue = writeQueue
    .catch(() => [])
    .then(async () => {
      const entries = await readDiagnosticLog();
      const next = [...entries, entry].slice(-MAX_ENTRIES);
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
      return next;
    });
  return writeQueue;
}

export async function clearDiagnosticLog(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
  writeQueue = Promise.resolve([]);
}

function sanitizeDetails(details: Record<string, string | number | boolean | null>): DiagnosticEntry["details"] {
  const safe: NonNullable<DiagnosticEntry["details"]> = {};
  for (const [key, value] of Object.entries(details)) {
    if (/^(?:apiKey|token|secret|authorization|image|crop|dataurl)$/i.test(key)) continue;
    safe[key] = typeof value === "string" ? sanitize(value).slice(0, 240) : value;
  }
  return safe;
}

function sanitize(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-or-v1-|sk-proj-|sk-ant-|sk-)\S+/gi, "[redacted key]");
}
