import type { DetectionBox, VideoViewport } from "../../shared/types";

interface IntegralImage {
  data: Float32Array;
  stride: number;
}

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

function nonMaxSuppress(candidates: DetectionBox[], limit: number): DetectionBox[] {
  const sorted = candidates.sort((a, b) => b.confidence - a.confidence);
  const picked: DetectionBox[] = [];

  for (const candidate of sorted) {
    if (picked.some((existing) => iou(existing, candidate) > 0.34)) continue;
    picked.push(candidate);
    if (picked.length >= limit) break;
  }

  return picked;
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
  const videoRect = viewport?.videoRect;
  const rawBounds = videoRect
    ? {
        x: clamp((videoRect.x / viewportWidth) * analysisWidth, 0, analysisWidth - 1),
        y: clamp((videoRect.y / viewportHeight) * analysisHeight, 0, analysisHeight - 1),
        width: (videoRect.width / viewportWidth) * analysisWidth,
        height: (videoRect.height / viewportHeight) * analysisHeight
      }
    : { x: 0, y: 0, width: analysisWidth, height: analysisHeight };
  const bounds = {
    x: rawBounds.x,
    y: rawBounds.y,
    width: clamp(rawBounds.width, 1, analysisWidth - rawBounds.x),
    height: clamp(rawBounds.height, 1, analysisHeight - rawBounds.y)
  };

  const candidates: DetectionBox[] = [];
  const outputScaleX = viewportWidth / analysisWidth;
  const outputScaleY = viewportHeight / analysisHeight;
  const minHeight = clamp(bounds.height * 0.26, 62, bounds.height);
  const maxHeight = clamp(bounds.height * 0.9, minHeight, bounds.height);
  const aspectRatios = [0.56, 0.63, 0.72, 0.78];

  for (let h = minHeight; h <= maxHeight; h += Math.max(14, h * 0.16)) {
    for (const ratio of aspectRatios) {
      const w = h * ratio;
      if (w > bounds.width * 0.86) continue;
      const step = Math.max(10, Math.round(Math.min(w, h) * 0.18));

      for (let y = bounds.y; y <= bounds.y + bounds.height - h; y += step) {
        for (let x = bounds.x; x <= bounds.x + bounds.width - w; x += step) {
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
          const score = borderDensity * 0.74 + innerEdges * 0.2 + contrast * 0.18;

          if (score < 0.17) continue;

          candidates.push({
            x: x * outputScaleX,
            y: y * outputScaleY,
            width: w * outputScaleX,
            height: h * outputScaleY,
            confidence: clamp(score, 0, 0.96)
          });
        }
      }
    }
  }

  return nonMaxSuppress(candidates, maxBoxes);
}
