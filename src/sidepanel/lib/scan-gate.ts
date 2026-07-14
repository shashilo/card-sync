import type { ScanStage } from "../../shared/types";

export interface ActiveScanFingerprint {
  fingerprint: string;
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
): boolean {
  if (activeScan && sameCardFingerprint(activeScan.fingerprint, fingerprint)) return false;
  return !hasRecentCardFingerprint(recentFingerprints, fingerprint, now);
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
