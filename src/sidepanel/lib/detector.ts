import type { Box, DetectionBox, VideoViewport } from "../../shared/types";

interface IntegralImage {
  data: Float32Array;
  stride: number;
}

export interface DetectionScanPlan {
  searchBounds: Box;
  minHeight: number;
  maxHeight: number;
  aspectRatios: number[];
}

const CARD_ASPECT_RATIOS = [0.56, 0.63, 0.72, 0.78, 1, 1.25, 1.4, 1.6, 1.78];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rectSum(integral: IntegralImage, x: number, y: number, width: number, height: number): number {
  const x1 = clamp(Math.floor(x), 0, integral.stride - 1);
  const y1 = clamp(Math.floor(y), 0, integral.data.length / integral.stride - 1);
  const x2 = clamp(Math.floor(x + width), 0, integral.stride - 1);
  const y2 = clamp(Math.floor(y + height), 0, integral.data.length / integral.stride - 1);
  return (
    integral.data[y2 * integral.stride + x2] -
    integral.data[y1 * integral.stride + x2] -
    integral.data[y2 * integral.stride + x1] +
    integral.data[y1 * integral.stride + x1]
  );
}

function buildIntegral(values: Float32Array, width: number, height: number): IntegralImage {
  const stride = width + 1;
  const data = new Float32Array((width + 1) * (height + 1));

  for (let y = 1; y <= height; y += 1) {
    let rowSum = 0;
    for (let x = 1; x <= width; x += 1) {
      rowSum += values[(y - 1) * width + (x - 1)];
      data[y * stride + x] = data[(y - 1) * stride + x] + rowSum;
    }
  }

  return { data, stride };
}

function iou(a: DetectionBox, b: DetectionBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function containedOverlap(a: DetectionBox, b: DetectionBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const smallerArea = Math.min(a.width * a.height, b.width * b.height);
  return smallerArea > 0 ? intersection / smallerArea : 0;
}

function nonMaxSuppress(candidates: DetectionBox[], limit: number): DetectionBox[] {
  const sorted = candidates.sort((a, b) => b.confidence - a.confidence);
  const picked: DetectionBox[] = [];

  for (const candidate of sorted) {
    if (picked.some((existing) => iou(existing, candidate) > 0.18 || containedOverlap(existing, candidate) > 0.52)) continue;
    picked.push(candidate);
    if (picked.length >= limit) break;
  }

  return picked;
}

function centerBonus(
  box: { x: number; y: number; width: number; height: number },
  bounds: { x: number; y: number; width: number; height: number }
): number {
  const boxCx = box.x + box.width / 2;
  const boxCy = box.y + box.height / 2;
  const boundsCx = bounds.x + bounds.width / 2;
  const targetY = bounds.y + bounds.height * 0.62;
  const nx = (boxCx - boundsCx) / Math.max(1, bounds.width * 0.3);
  const ny = (boxCy - targetY) / Math.max(1, bounds.height * 0.38);
  return Math.exp(-0.5 * (nx * nx + ny * ny));
}

function sizeBonus(
  box: { width: number; height: number },
  bounds: { width: number; height: number }
): number {
  const heightShare = box.height / Math.max(1, bounds.height);
  const areaShare = (box.width * box.height) / Math.max(1, bounds.width * bounds.height);
  const heightFit = clamp(1 - Math.abs(heightShare - 0.38) / 0.5, 0, 1);
  const areaFit = clamp(1 - Math.abs(areaShare - 0.12) / 0.2, 0, 1);
  return heightFit * 0.65 + areaFit * 0.35;
}

function expandBox(
  box: { x: number; y: number; width: number; height: number },
  bounds: { x: number; y: number; width: number; height: number }
): Box {
  const pad = Math.min(box.width, box.height) * 0.08;
  const x = clamp(box.x - pad, bounds.x, bounds.x + bounds.width);
  const y = clamp(box.y - pad, bounds.y, bounds.y + bounds.height);
  const right = clamp(box.x + box.width + pad, bounds.x, bounds.x + bounds.width);
  const bottom = clamp(box.y + box.height + pad, bounds.y, bounds.y + bounds.height);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}

export function buildDetectionScanPlan(
  analysisWidth: number,
  analysisHeight: number,
  viewportRect?: Box,
  viewportWidth = analysisWidth,
  viewportHeight = analysisHeight
): DetectionScanPlan {
  const scaleX = analysisWidth / Math.max(1, viewportWidth);
  const scaleY = analysisHeight / Math.max(1, viewportHeight);
  const left = viewportRect ? clamp(viewportRect.x * scaleX, 0, analysisWidth) : 0;
  const top = viewportRect ? clamp(viewportRect.y * scaleY, 0, analysisHeight) : 0;
  const right = viewportRect
    ? clamp((viewportRect.x + viewportRect.width) * scaleX, left, analysisWidth)
    : analysisWidth;
  const bottom = viewportRect
    ? clamp((viewportRect.y + viewportRect.height) * scaleY, top, analysisHeight)
    : analysisHeight;
  const searchBounds = {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
  const minHeight = clamp(searchBounds.height * 0.16, 48, searchBounds.height);
  const maxHeight = clamp(searchBounds.height * 0.82, minHeight, searchBounds.height);

  return {
    searchBounds,
    minHeight,
    maxHeight,
    aspectRatios: CARD_ASPECT_RATIOS
  };
}

export function detectCardBoxes(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  viewport: VideoViewport | undefined,
  maxBoxes: number
): DetectionBox[] {
  const frameWidth = video.videoWidth;
  const frameHeight = video.videoHeight;
  if (!frameWidth || !frameHeight) return [];

  const analysisWidth = 480;
  const analysisHeight = Math.max(180, Math.round((frameHeight / frameWidth) * analysisWidth));
  canvas.width = analysisWidth;
  canvas.height = analysisHeight;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  ctx.drawImage(video, 0, 0, analysisWidth, analysisHeight);
  const image = ctx.getImageData(0, 0, analysisWidth, analysisHeight);
  const gray = new Float32Array(analysisWidth * analysisHeight);
  const edges = new Float32Array(analysisWidth * analysisHeight);
  const brightness = new Float32Array(analysisWidth * analysisHeight);

  for (let i = 0; i < image.data.length; i += 4) {
    const value = image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114;
    const p = i / 4;
    gray[p] = value;
    brightness[p] = value / 255;
  }

  for (let y = 1; y < analysisHeight; y += 1) {
    for (let x = 1; x < analysisWidth; x += 1) {
      const idx = y * analysisWidth + x;
      const gradient = Math.abs(gray[idx] - gray[idx - 1]) + Math.abs(gray[idx] - gray[idx - analysisWidth]);
      edges[idx] = gradient > 34 ? 1 : 0;
    }
  }

  const edgeIntegral = buildIntegral(edges, analysisWidth, analysisHeight);
  const brightnessIntegral = buildIntegral(brightness, analysisWidth, analysisHeight);
  const viewportWidth = viewport?.viewportWidth || frameWidth;
  const viewportHeight = viewport?.viewportHeight || frameHeight;

  const candidates: DetectionBox[] = [];
  const outputScaleX = viewportWidth / analysisWidth;
  const outputScaleY = viewportHeight / analysisHeight;
  const { searchBounds, minHeight, maxHeight, aspectRatios } = buildDetectionScanPlan(
    analysisWidth,
    analysisHeight,
    viewport?.videoRect,
    viewportWidth,
    viewportHeight
  );

  for (let h = minHeight; h <= maxHeight; h += Math.max(14, h * 0.16)) {
    for (const ratio of aspectRatios) {
      const w = h * ratio;
      if (w > searchBounds.width * 0.98) continue;
      const step = Math.max(10, Math.round(Math.min(w, h) * 0.18));

      for (let y = searchBounds.y; y <= searchBounds.y + searchBounds.height - h; y += step) {
        for (let x = searchBounds.x; x <= searchBounds.x + searchBounds.width - w; x += step) {
          const border = Math.max(3, Math.round(Math.min(w, h) * 0.055));
          const top = rectSum(edgeIntegral, x, y, w, border);
          const bottom = rectSum(edgeIntegral, x, y + h - border, w, border);
          const left = rectSum(edgeIntegral, x, y, border, h);
          const right = rectSum(edgeIntegral, x + w - border, y, border, h);
          const borderArea = w * border * 2 + h * border * 2;
          const borderDensity = (top + bottom + left + right) / borderArea;

          const innerX = x + border * 2;
          const innerY = y + border * 2;
          const innerW = Math.max(1, w - border * 4);
          const innerH = Math.max(1, h - border * 4);
          const innerEdges = rectSum(edgeIntegral, innerX, innerY, innerW, innerH) / (innerW * innerH);
          const innerBrightness = rectSum(brightnessIntegral, innerX, innerY, innerW, innerH) / (innerW * innerH);
          const outerBrightness = rectSum(brightnessIntegral, x, y, w, h) / (w * h);
          const contrast = Math.abs(innerBrightness - outerBrightness);
          if (h / searchBounds.height > 0.84 || w / searchBounds.width > 0.9) continue;
          const center = centerBonus({ x, y, width: w, height: h }, searchBounds);
          const size = sizeBonus({ width: w, height: h }, searchBounds);
          const score =
            borderDensity * 0.4 +
            innerEdges * 0.08 +
            contrast * 0.06 +
            center * 0.24 +
            size * 0.22;

          if (score < 0.22) continue;

          const expanded = expandBox({ x, y, width: w, height: h }, searchBounds);

          candidates.push({
            x: expanded.x * outputScaleX,
            y: expanded.y * outputScaleY,
            width: expanded.width * outputScaleX,
            height: expanded.height * outputScaleY,
            confidence: clamp(score, 0, 0.96)
          });
        }
      }
    }
  }

  return nonMaxSuppress(candidates, maxBoxes);
}
