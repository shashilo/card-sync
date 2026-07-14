import type { BadgeTone, Box, DetectionBox, ScanStage, TrackSummary } from "../../shared/types";

export interface TrackedCard extends TrackSummary {
  firstSeenAt: number;
  lastSeenAt: number;
  stableSince?: number;
  identifyRequestedAt?: number;
  inFlight?: boolean;
}

function overlap(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function smoothBox(previous: Box, next: Box): Box {
  const alpha = 0.34;
  return {
    x: previous.x * (1 - alpha) + next.x * alpha,
    y: previous.y * (1 - alpha) + next.y * alpha,
    width: previous.width * (1 - alpha) + next.width * alpha,
    height: previous.height * (1 - alpha) + next.height * alpha
  };
}

export function formatPrice(value: number): string {
  return `$${Math.round(value).toLocaleString()}`;
}

export function badgeTone(stage: ScanStage, confidence: number): BadgeTone {
  if (stage === "no-bid" || stage === "error" || confidence < 0.5) return "red";
  if (stage === "comp-backed" && confidence >= 0.72) return "green";
  if (stage === "fast-value" || stage === "candidate") return "yellow";
  return "gray";
}

export function labelForTrack(track: Pick<TrackSummary, "stage" | "identity" | "valuation" | "detectionConfidence">): string {
  const identityConfidence = track.identity?.confidence ?? track.detectionConfidence;

  if (track.stage === "no-bid") return `No-bid signal · ${Math.round(identityConfidence * 100)}%`;
  if (track.valuation?.source && track.valuation.source !== "none") {
    return `${formatPrice(track.valuation.low)}-${formatPrice(track.valuation.high)} · Max ${formatPrice(
      track.valuation.maxBid
    )} · ${Math.round(track.valuation.confidence * 100)}%`;
  }
  if (track.identity?.player) return `${track.identity.player} candidate · ${Math.round(identityConfidence * 100)}%`;
  if (track.stage === "candidate") return `Candidate · ${Math.round(identityConfidence * 100)}%`;
  return "Detecting card";
}

export function updateTrackedCards(previous: TrackedCard[], detections: DetectionBox[], now: number, maxTracks: number): TrackedCard[] {
  const next: TrackedCard[] = [];
  const used = new Set<number>();

  for (const track of previous) {
    let bestIndex = -1;
    let bestScore = 0;

    detections.forEach((detection, index) => {
      if (used.has(index)) return;
      const score = overlap(track.box, detection);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0 && bestScore > 0.12) {
      const detection = detections[bestIndex];
      used.add(bestIndex);
      next.push({
        ...track,
        box: smoothBox(track.box, detection),
        detectionConfidence: Math.max(track.detectionConfidence * 0.82, detection.confidence),
        lastSeenAt: now,
        stableSince: track.stableSince ?? now,
        updatedAt: now
      });
    } else if (now - track.lastSeenAt < 1200) {
      next.push(track);
    }
  }

  detections.forEach((detection, index) => {
    if (used.has(index)) return;
    next.push({
      id: crypto.randomUUID(),
      box: detection,
      detectionConfidence: detection.confidence,
      firstSeenAt: now,
      lastSeenAt: now,
      stage: "detecting",
      badgeTone: "gray",
      label: "Detecting card",
      compLinks: [],
      updatedAt: now
    });
  });

  return next
    .sort((a, b) => b.detectionConfidence - a.detectionConfidence)
    .slice(0, maxTracks)
    .map((track) => ({
      ...track,
      badgeTone: badgeTone(track.stage, track.identity?.confidence ?? track.detectionConfidence),
      label: labelForTrack(track)
    }));
}
