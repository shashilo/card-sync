import type { ScanStage } from "../../shared/types";

export interface ActiveScanFingerprint {
  fingerprint: string;
  pendingFingerprint?: string;
  pendingCount?: number;
  completed?: boolean;
}

export interface ScanFingerprintDecision {
  shouldScan: boolean;
  activeScan?: ActiveScanFingerprint;
}

export function hammingDistance(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let distance = Math.abs(a.length - b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) distance += 1;
  }
  return distance;
}

export function sameCardFingerprint(a: string, b: string): boolean {
  return hammingDistance(a, b) <= 10;
}

export function shouldStartScanForFingerprint(
  activeScan: ActiveScanFingerprint | undefined,
  recentFingerprints: Map<string, number>,
  fingerprint: string,
  now: number
): ScanFingerprintDecision {
  if (activeScan?.completed && hammingDistance(activeScan.fingerprint, fingerprint) <= 20) {
    return { shouldScan: false, activeScan: { ...activeScan, pendingFingerprint: undefined, pendingCount: 0 } };
  }
  if (activeScan && sameCardFingerprint(activeScan.fingerprint, fingerprint)) {
    return { shouldScan: false, activeScan: { ...activeScan, pendingFingerprint: undefined, pendingCount: 0 } };
  }

  if (activeScan) {
    const samePending = activeScan.pendingFingerprint && sameCardFingerprint(activeScan.pendingFingerprint, fingerprint);
    const pendingCount = samePending ? (activeScan.pendingCount ?? 0) + 1 : 1;
    const nextActiveScan = {
      ...activeScan,
      pendingFingerprint: fingerprint,
      pendingCount
    };
    if (pendingCount < 3) return { shouldScan: false, activeScan: nextActiveScan };
  }

  if (hasRecentCardFingerprint(recentFingerprints, fingerprint, now)) return { shouldScan: false, activeScan };

  return { shouldScan: true };
}

export function hasRecentCardFingerprint(fingerprints: Map<string, number>, fingerprint: string, now: number): boolean {
  for (const [existing, seenAt] of fingerprints) {
    if (now - seenAt <= 45_000 && sameCardFingerprint(existing, fingerprint)) return true;
  }
  return false;
}

export function rememberCardFingerprint(fingerprints: Map<string, number>, fingerprint: string, now: number): void {
  if (!fingerprint) return;
  fingerprints.set(fingerprint, now);
  for (const [key, seenAt] of fingerprints) {
    if (now - seenAt > 60_000) fingerprints.delete(key);
  }
}

export function shouldPersistScanHistory(stage: ScanStage, identityConfidence: number | undefined): boolean {
  if (stage === "no-bid") return false;
  return (identityConfidence ?? 0) >= 0.5;
}
