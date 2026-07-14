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
      )
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
      )
    ).toBe(false);
  });

  it("starts a new scan when the visual card changes", () => {
    const changedFingerprint = flipBits(baseFingerprint, 18);

    expect(
      shouldStartScanForFingerprint(
        { fingerprint: baseFingerprint },
        new Map(),
        changedFingerprint,
        1000
      )
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
      )
    ).toBe(false);
  });

  it("only persists plausible card history rows", () => {
    expect(shouldPersistScanHistory("no-bid", 0.9)).toBe(false);
    expect(shouldPersistScanHistory("candidate", 0.49)).toBe(false);
    expect(shouldPersistScanHistory("candidate", 0.5)).toBe(true);
    expect(shouldPersistScanHistory("fast-value", 0.72)).toBe(true);
  });
});
