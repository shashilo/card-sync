import { describe, expect, it } from "vitest";
import {
  hammingDistance,
  rememberCardFingerprint,
  shouldPersistScanHistory,
  shouldStartScanForFingerprint
} from "../sidepanel/lib/scan-gate";

const baseFingerprint = "1111000011110000111100001111000011110000111100001111000011110000";

function flipBits(value: string, count: number): string {
  const bits = value.split("");
  for (let index = 0; index < count; index += 1) {
    bits[index] = bits[index] === "1" ? "0" : "1";
  }
  return bits.join("");
}

describe("scan gate", () => {
  it("does not rescan the same active visual card", () => {
    expect(
      shouldStartScanForFingerprint(
        { fingerprint: baseFingerprint },
        new Map(),
        baseFingerprint,
        1000
      ).shouldScan
    ).toBe(false);
  });

  it("does not rescan slight livestream fingerprint noise", () => {
    const noisyFingerprint = flipBits(baseFingerprint, 8);

    expect(hammingDistance(baseFingerprint, noisyFingerprint)).toBe(8);
    expect(
      shouldStartScanForFingerprint(
        { fingerprint: baseFingerprint },
        new Map(),
        noisyFingerprint,
        1000
      ).shouldScan
    ).toBe(false);
  });

  it("waits for a sustained visual change before starting a new scan", () => {
    const changedFingerprint = flipBits(baseFingerprint, 18);
    const firstDecision = shouldStartScanForFingerprint(
      { fingerprint: baseFingerprint },
      new Map(),
      changedFingerprint,
      1000
    );
    const secondDecision = shouldStartScanForFingerprint(
      firstDecision.activeScan,
      new Map(),
      changedFingerprint,
      1250
    );

    expect(firstDecision.shouldScan).toBe(false);
    expect(secondDecision.shouldScan).toBe(false);
    expect(
      shouldStartScanForFingerprint(
        secondDecision.activeScan,
        new Map(),
        changedFingerprint,
        1500
      ).shouldScan
    ).toBe(true);
  });

  it("suppresses the same recent card even after tracker reset", () => {
    const recent = new Map<string, number>();
    rememberCardFingerprint(recent, baseFingerprint, 1000);

    expect(
      shouldStartScanForFingerprint(
        undefined,
        recent,
        flipBits(baseFingerprint, 6),
        5000
      ).shouldScan
    ).toBe(false);
  });

  it("only persists plausible card history rows", () => {
    expect(shouldPersistScanHistory("no-bid", 0.9)).toBe(false);
    expect(shouldPersistScanHistory("candidate", 0.49)).toBe(false);
    expect(shouldPersistScanHistory("candidate", 0.5)).toBe(true);
    expect(shouldPersistScanHistory("fast-value", 0.72)).toBe(true);
  });
});
