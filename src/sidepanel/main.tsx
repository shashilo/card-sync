import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, BadgeDollarSign, Clock3, Crosshair, ExternalLink, Loader2, Play, Settings, Square, Trash2 } from "lucide-react";
import { consumePendingCapture, type PendingCapture } from "../shared/capture";
import type { RuntimeMessage } from "../shared/messages";
import { getActiveTab, sendToActiveTab, sendToTab } from "../shared/messages";
import { applyProviderPreset, providerPreset, requestCustomProviderPermission } from "../shared/providers";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../shared/settings";
import type { BadgeTone, CardIdentity, ExtensionSettings, PageContext, ScanHistoryItem, TrackSummary, Valuation, VideoViewport } from "../shared/types";
import { identifyCard } from "./lib/ai";
import { detectCardBoxes } from "./lib/detector";
import { clearShowHistory, listShowHistory, showKeyFromUrl, upsertScanHistoryItem } from "./lib/history";
import { identityKey, inferIdentityFromContext } from "./lib/identity";
import { lookupPriceGuide } from "./lib/price-guide";
import { generateCompLinks, buildValuation, rememberValuation, stageFor } from "./lib/pricing";
import { formatPrice, labelForTrack, updateTrackedCards, type TrackedCard } from "./lib/tracker";
import "./styles.css";

const WHATNOT_RE = /^https:\/\/([a-z0-9-]+\.)?whatnot\.com\//i;

function App(): JSX.Element {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<PageContext | undefined>();
  const [tracks, setTracks] = useState<TrackedCard[]>([]);
  const [activeTrackId, setActiveTrackId] = useState<string | undefined>();
  const [historyItems, setHistoryItems] = useState<ScanHistoryItem[]>([]);

  const settingsRef = useRef(settings);
  const contextRef = useRef<PageContext | undefined>();
  const tracksRef = useRef<TrackedCard[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loopRef = useRef<number | undefined>();
  const captureTabIdRef = useRef<number | undefined>();
  const lastContextPullAtRef = useRef(0);
  const scanRunRef = useRef(0);
  const showKeyRef = useRef<string | undefined>();
  const showUrlRef = useRef("");
  const trackHistoryIdsRef = useRef(new Map<string, string>());
  const scannedTrackIdsRef = useRef(new Set<string>());
  const recentScanSignaturesRef = useRef(new Map<string, number>());
  const contextPrewarmRef = useRef(new Map<string, number>());
  const sessionCacheRef = useRef(new Map<string, Valuation>());

  useEffect(() => {
    loadSettings().then((loaded) => {
      setSettings(loaded);
      settingsRef.current = loaded;
    });
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  useEffect(() => {
    tracksRef.current = tracks;
    if (scanning) {
      const targetTabId = captureTabIdRef.current;
      if (targetTabId) sendToTab(targetTabId, { type: "CS_RENDER_TRACKS", tracks: tracks.map(toSummary) }).catch(() => undefined);
    }
  }, [tracks, scanning]);

  useEffect(() => {
    const listener = (message: RuntimeMessage) => {
      if (message.type === "CS_CONTEXT") {
        setContext(message.context);
        prewarmPriceGuideFromContext(message.context).catch(() => undefined);
      }
      if (message.type === "BG_CAPTURE_READY") startFromPendingCapture(message.capture);
      if (message.type === "BG_CAPTURE_ERROR") setError(message.message);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    consumePendingCapture().then((capture) => {
      if (capture) startFromPendingCapture(capture);
    });
  }, []);

  useEffect(() => {
    getActiveTab().then((tab) => {
      if (tab?.url && WHATNOT_RE.test(tab.url)) loadHistoryForShow(tab.url).catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    return () => stopScanning();
  }, []);

  const activeTrack = useMemo(() => {
    if (!tracks.length) return undefined;
    return tracks.find((track) => track.id === activeTrackId) ?? tracks[0];
  }, [activeTrackId, tracks]);

  async function persistSettings(next: ExtensionSettings): Promise<void> {
    const granted = await requestCustomProviderPermission(next.provider);
    if (!granted) {
      setError("Chrome host permission was not granted for that custom AI endpoint.");
      return;
    }
    setSettings(next);
    settingsRef.current = next;
    await saveSettings(next);
  }

  function startScanning(): void {
    setError("Click the CardSync toolbar icon while the Whatnot stream tab is active. Chrome requires the toolbar click to arm live tab capture.");
  }

  function startFromPendingCapture(capture: PendingCapture): void {
    if (streamRef.current) stopScanning();
    const runId = scanRunRef.current + 1;
    scanRunRef.current = runId;
    setError(null);

    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: capture.streamId,
          maxWidth: 1920,
          maxHeight: 1080
        }
      }
    } as MediaStreamConstraints;

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        if (scanRunRef.current !== runId) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        return setupCapturedStream(stream, capture.targetTabId, runId);
      })
      .catch((caught) => {
        if (scanRunRef.current !== runId) return;
        setError(
          [
            caught instanceof Error ? caught.message : "Unable to start captured stream.",
            "Click the CardSync toolbar icon again from the Whatnot tab; Chrome stream IDs expire quickly."
          ].join(" ")
        );
        stopScanning();
      });
  }

  async function setupCapturedStream(stream: MediaStream, targetTabId: number | undefined, runId: number): Promise<void> {
    const tab = targetTabId ? await chrome.tabs.get(targetTabId).catch(() => undefined) : await getActiveTab();
    if (scanRunRef.current !== runId) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    if (!tab?.id) {
      stream.getTracks().forEach((track) => track.stop());
      setError("Open a Whatnot live show tab before starting CardSync.");
      return;
    }

    if (!tab.url || !WHATNOT_RE.test(tab.url)) {
      stream.getTracks().forEach((track) => track.stop());
      setError("CardSync POC is scoped to Whatnot pages.");
      return;
    }

    try {
      await loadHistoryForShow(tab.url);
      await sendToTab(tab.id, { type: "CS_SET_SCANNING", scanning: true });
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();

      streamRef.current = stream;
      captureTabIdRef.current = tab.id;
      videoRef.current = video;
      analysisCanvasRef.current = document.createElement("canvas");
      cropCanvasRef.current = document.createElement("canvas");
      requestPageContext(tab.id).catch(() => undefined);
      setScanning(true);
      scheduleLoop(runId);
    } catch (caught) {
      await sendToTab(tab.id, { type: "CS_SET_SCANNING", scanning: false });
      setError(caught instanceof Error ? caught.message : "Unable to start tab capture.");
      stopScanning();
    }
  }

  function stopScanning(): void {
    scanRunRef.current += 1;
    const targetTabId = captureTabIdRef.current;
    if (loopRef.current) {
      window.clearTimeout(loopRef.current);
      loopRef.current = undefined;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    captureTabIdRef.current = undefined;
    videoRef.current = null;
    contextRef.current = undefined;
    setContext(undefined);
    lastContextPullAtRef.current = 0;
    setScanning(false);
    setTracks([]);
    tracksRef.current = [];
    scannedTrackIdsRef.current.clear();
    if (targetTabId) {
      sendToTab(targetTabId, { type: "CS_SET_SCANNING", scanning: false }).catch(() => undefined);
      sendToTab(targetTabId, { type: "CS_CLEAR_OVERLAY" }).catch(() => undefined);
    } else {
      sendToActiveTab({ type: "CS_SET_SCANNING", scanning: false }).catch(() => undefined);
      sendToActiveTab({ type: "CS_CLEAR_OVERLAY" }).catch(() => undefined);
    }
  }

  function scheduleLoop(runId: number): void {
    const cadence = settingsRef.current.scanCadenceMs;
    loopRef.current = window.setTimeout(() => {
      if (scanRunRef.current !== runId || !streamRef.current) return;
      runScanTick();
      if (scanRunRef.current === runId && streamRef.current) scheduleLoop(runId);
    }, cadence);
  }

  function runScanTick(): void {
    const video = videoRef.current;
    const canvas = analysisCanvasRef.current;
    if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    const now = Date.now();
    const currentSettings = settingsRef.current;
    const targetTabId = captureTabIdRef.current;
    if (targetTabId && now - lastContextPullAtRef.current > 500) {
      lastContextPullAtRef.current = now;
      requestPageContext(targetTabId).catch(() => undefined);
    }

    const videoViewport = contextRef.current?.videoViewport;
    if (!isUsableVideoViewport(videoViewport)) {
      if (tracksRef.current.length) {
        tracksRef.current = [];
        setTracks([]);
      }
      return;
    }

    const detections = detectCardBoxes(video, canvas, videoViewport, currentSettings.maxTrackedCards);
    const nextTracks = updateTrackedCards(tracksRef.current, detections, now, currentSettings.maxTrackedCards);

    tracksRef.current = nextTracks;
    setTracks(nextTracks);
    prewarmIdentities(nextTracks, now).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "Identification failed.");
    });
  }

  async function prewarmIdentities(currentTracks: TrackedCard[], now: number): Promise<void> {
    const video = videoRef.current;
    if (!video) return;

    for (const track of currentTracks) {
      const stableFor = now - (track.stableSince ?? track.firstSeenAt);
      const alreadyUseful = track.identity && track.valuation?.source && track.valuation.source !== "none";
      const recentlyRequested = track.identifyRequestedAt && now - track.identifyRequestedAt < 7000;
      const alreadyScanned = scannedTrackIdsRef.current.has(track.id);

      if (alreadyUseful || alreadyScanned || track.inFlight || recentlyRequested || stableFor < settingsRef.current.identifyStableAfterMs) continue;

      const crop = cropTrack(video, track);
      if (!crop) continue;

      const contextIdentity = inferIdentityFromContext(contextRef.current);
      const signature = scanSignature(contextIdentity, track, crop);
      if (hasRecentScanSignature(recentScanSignaturesRef.current, signature, now)) {
        scannedTrackIdsRef.current.add(track.id);
        continue;
      }

      rememberScanSignature(recentScanSignaturesRef.current, signature, now);
      scannedTrackIdsRef.current.add(track.id);
      markTrack(track.id, { inFlight: true, identifyRequestedAt: now, stage: "candidate" });
      const contextValuation = buildValuation(
        contextIdentity,
        sessionCacheRef.current,
        undefined,
        settingsRef.current.allowAiEstimatedValues
      );
      const contextStage = stageFor(contextIdentity, contextValuation);
      markTrack(track.id, {
        identity: contextIdentity,
        valuation: contextValuation,
        compLinks: generateCompLinks(contextIdentity),
        stage: contextStage,
        updatedAt: Date.now()
      });
      persistTrackHistory(track, crop, {
        identity: contextIdentity,
        valuation: contextValuation,
        compLinks: generateCompLinks(contextIdentity),
        stage: contextStage
      }).catch(() => undefined);
      applyPriceGuide(track.id, track, crop, contextIdentity).catch(() => undefined);

      const provider = settingsRef.current.provider;
      if (provider.provider === "mock" || !provider.apiKey.trim()) {
        markTrack(track.id, { inFlight: false });
        continue;
      }

      identifyCard(crop, contextRef.current, settingsRef.current)
        .then(({ identity, estimate }) => {
          const valuation = buildValuation(
            identity,
            sessionCacheRef.current,
            estimate,
            settingsRef.current.allowAiEstimatedValues
          );
          const compLinks = generateCompLinks(identity);
          rememberValuation(identity, valuation, sessionCacheRef.current);
          const stage = stageFor(identity, valuation);
          markTrack(track.id, {
            identity,
            valuation,
            compLinks,
            stage,
            inFlight: false,
            updatedAt: Date.now()
          });
          persistTrackHistory(track, crop, {
            identity,
            valuation,
            compLinks,
            stage
          }).catch(() => undefined);
          applyPriceGuide(track.id, track, crop, identity).catch(() => undefined);
        })
        .catch((caught) => {
          markTrack(track.id, {
            inFlight: false,
            stage: "error",
            label: caught instanceof Error ? `AI error: ${caught.message}` : "AI error"
          });
        });
    }
  }

  async function applyPriceGuide(trackId: string, track: TrackedCard, crop: string, identity: CardIdentity): Promise<void> {
    const quote = await lookupPriceGuide(identity, settingsRef.current.priceGuideProxyUrl);
    if (!quote) return;

    const valuation = buildValuation(identity, sessionCacheRef.current, undefined, settingsRef.current.allowAiEstimatedValues, quote);
    const compLinks = generateCompLinks(identity);
    rememberValuation(identity, valuation, sessionCacheRef.current);
    const stage = stageFor(identity, valuation);
    markTrack(trackId, {
      identity,
      valuation,
      compLinks,
      stage,
      inFlight: false,
      updatedAt: Date.now()
    });
    await persistTrackHistory(track, crop, {
      identity,
      valuation,
      compLinks,
      stage
    });
  }

  async function requestPageContext(tabId: number): Promise<void> {
    const response = await chrome.tabs.sendMessage(tabId, { type: "CS_GET_CONTEXT" }).catch(() => undefined);
    if (!isPageContext(response)) return;
    contextRef.current = response;
    setContext(response);
    prewarmPriceGuideFromContext(response).catch(() => undefined);
  }

  async function prewarmPriceGuideFromContext(pageContext: PageContext): Promise<void> {
    const identity = inferIdentityFromContext(pageContext);
    const key = identityKey(identity) || hashString(identity.rawText);
    if (!key || identity.confidence < 0.5) return;

    const now = Date.now();
    const recent = contextPrewarmRef.current.get(key);
    if (recent && now - recent < 20_000) return;
    contextPrewarmRef.current.set(key, now);

    const quote = await lookupPriceGuide(identity, settingsRef.current.priceGuideProxyUrl);
    if (!quote) return;

    const valuation = buildValuation(identity, sessionCacheRef.current, undefined, settingsRef.current.allowAiEstimatedValues, quote);
    rememberValuation(identity, valuation, sessionCacheRef.current);
    applyPrewarmedValuationToCurrentTracks(identity, valuation);
  }

  function applyPrewarmedValuationToCurrentTracks(identity: CardIdentity, valuation: Valuation): void {
    const key = identityKey(identity);
    if (!key || valuation.source === "none") return;

    for (const track of tracksRef.current) {
      const trackIdentity = track.identity ?? inferIdentityFromContext(contextRef.current);
      if (identityKey(trackIdentity) !== key) continue;

      const compLinks = generateCompLinks(identity);
      const stage = stageFor(identity, valuation);
      markTrack(track.id, {
        identity,
        valuation,
        compLinks,
        stage,
        inFlight: false,
        updatedAt: Date.now()
      });
      persistTrackHistory(track, undefined, {
        identity,
        valuation,
        compLinks,
        stage
      }).catch(() => undefined);
    }
  }

  async function loadHistoryForShow(showUrl: string): Promise<void> {
    const showKey = showKeyFromUrl(showUrl);
    if (showKeyRef.current !== showKey) {
      trackHistoryIdsRef.current.clear();
      scannedTrackIdsRef.current.clear();
      recentScanSignaturesRef.current.clear();
      contextPrewarmRef.current.clear();
    }
    showKeyRef.current = showKey;
    showUrlRef.current = showUrl;
    const items = await listShowHistory(showKey);
    setHistoryItems(items);
  }

  async function persistTrackHistory(
    track: TrackedCard,
    cropImageDataUrl: string | undefined,
    patch: Pick<TrackedCard, "identity" | "valuation" | "compLinks" | "stage">
  ): Promise<void> {
    const showKey = showKeyRef.current;
    if (!showKey || (!cropImageDataUrl && !trackHistoryIdsRef.current.has(track.id))) return;

    const existingId = trackHistoryIdsRef.current.get(track.id);
    const id = existingId ?? crypto.randomUUID();
    trackHistoryIdsRef.current.set(track.id, id);
    const item = await upsertScanHistoryItem({
      id,
      showKey,
      showUrl: showUrlRef.current,
      seenAt: Date.now(),
      cropImageDataUrl,
      detectionConfidence: track.detectionConfidence,
      stage: patch.stage,
      badgeTone: badgeToneForStage(patch.stage, patch.identity?.confidence ?? track.detectionConfidence, patch.valuation),
      label: labelForTrack({
        stage: patch.stage,
        identity: patch.identity,
        valuation: patch.valuation,
        detectionConfidence: track.detectionConfidence
      }),
      identity: patch.identity,
      valuation: patch.valuation,
      compLinks: patch.compLinks
    });

    setHistoryItems((current) => [item, ...current.filter((candidate) => candidate.id !== item.id)].sort((a, b) => b.lastSeenAt - a.lastSeenAt));
  }

  async function clearCurrentShowHistory(): Promise<void> {
    const showKey = showKeyRef.current;
    if (!showKey) return;
    await clearShowHistory(showKey);
    trackHistoryIdsRef.current.clear();
    setHistoryItems([]);
  }

  function markTrack(id: string, patch: Partial<TrackedCard>): void {
    setTracks((current) => {
      const next = current.map((track) => {
        if (track.id !== id) return track;
        const merged = { ...track, ...patch };
        const tone: BadgeTone =
          merged.stage === "error" || merged.stage === "no-bid"
            ? "red"
            : merged.stage === "comp-backed" && (merged.valuation?.confidence ?? 0) >= 0.72
              ? "green"
              : merged.stage === "candidate" || merged.stage === "fast-value"
                ? "yellow"
                : "gray";

        return {
          ...merged,
          label: patch.label ?? labelForTrack(merged),
          badgeTone: tone
        };
      });
      tracksRef.current = next;
      return next;
    });
  }

  function cropTrack(video: HTMLVideoElement, track: TrackedCard): string | undefined {
    const canvas = cropCanvasRef.current;
    const viewport = contextRef.current?.videoViewport;
    if (!canvas || !viewport?.viewportWidth || !viewport.viewportHeight) return undefined;

    const frameX = (track.box.x / viewport.viewportWidth) * video.videoWidth;
    const frameY = (track.box.y / viewport.viewportHeight) * video.videoHeight;
    const frameW = (track.box.width / viewport.viewportWidth) * video.videoWidth;
    const frameH = (track.box.height / viewport.viewportHeight) * video.videoHeight;
    const pad = Math.max(frameW, frameH) * 0.08;
    const sx = Math.max(0, frameX - pad);
    const sy = Math.max(0, frameY - pad);
    const sw = Math.min(video.videoWidth - sx, frameW + pad * 2);
    const sh = Math.min(video.videoHeight - sy, frameH + pad * 2);
    if (sw < 64 || sh < 64) return undefined;

    const maxSide = 512;
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">Whatnot sudden-death POC</p>
          <h1>CardSync</h1>
        </div>
        <button className="iconButton" type="button" title="Settings" onClick={() => setSettingsOpen((open) => !open)}>
          <Settings size={18} />
        </button>
      </header>

      <section className="controlBand">
        <button className="primaryButton" type="button" onClick={scanning ? stopScanning : startScanning}>
          {scanning ? <Square size={17} /> : <Play size={17} />}
          {scanning ? "Stop scanning" : "Arm from toolbar"}
        </button>
        <div className={`statusPill ${scanning ? "active" : ""}`}>
          {scanning ? <Loader2 size={14} className="spin" /> : <Crosshair size={14} />}
          {scanning ? "Live prewarm running" : "Toolbar click arms capture"}
        </div>
      </section>

      {error ? (
        <section className="notice error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </section>
      ) : null}

      {settingsOpen ? <SettingsPanel settings={settings} onChange={persistSettings} /> : null}

      <section className="hudGrid">
        <Metric label="Tracked" value={tracks.length.toString()} />
        <Metric label="Session values" value={sessionCacheRef.current.size.toString()} />
        <Metric label="Pricing" value={settings.priceGuideProxyUrl.trim() ? "Guide" : "Links"} />
      </section>

      <section className="trackList">
        <h2>Live Cards</h2>
        {tracks.length ? (
          tracks.map((track) => (
            <button
              className={`trackRow ${track.id === activeTrack?.id ? "selected" : ""}`}
              key={track.id}
              type="button"
              onClick={() => setActiveTrackId(track.id)}
            >
              <span className={`dot ${track.badgeTone}`} />
              <span>
                <strong>{track.label}</strong>
                <small>{track.identity?.rawText || `${Math.round(track.detectionConfidence * 100)}% rectangle confidence`}</small>
              </span>
            </button>
          ))
        ) : (
          <p className="empty">Click the CardSync toolbar icon while a Whatnot live show is active. Card outlines should appear first, then candidate pricing.</p>
        )}
      </section>

      <HistoryPanel items={historyItems} onClear={clearCurrentShowHistory} />

      {activeTrack ? <DetailPanel track={activeTrack} /> : null}
    </main>
  );
}

function badgeToneForStage(stage: TrackedCard["stage"], confidence: number, valuation?: Valuation): BadgeTone {
  if (stage === "error" || stage === "no-bid") return "red";
  if (stage === "comp-backed" && (valuation?.confidence ?? 0) >= 0.72) return "green";
  if (stage === "candidate" || stage === "fast-value") return "yellow";
  return confidence < 0.5 ? "red" : "gray";
}

function scanSignature(identity: CardIdentity, track: TrackedCard, cropImageDataUrl: string): string {
  const key = identityKey(identity);
  if (key && identity.confidence >= 0.5) return `identity:${key}`;
  return [
    `crop:${hashString(cropImageDataUrl)}`,
    Math.round(track.box.width / 25),
    Math.round(track.box.height / 25)
  ].join("|");
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function hasRecentScanSignature(signatures: Map<string, number>, signature: string, now: number): boolean {
  const lastSeenAt = signature ? signatures.get(signature) : undefined;
  return Boolean(lastSeenAt && now - lastSeenAt < 45_000);
}

function rememberScanSignature(signatures: Map<string, number>, signature: string, now: number): void {
  if (!signature) return;
  signatures.set(signature, now);
  for (const [key, seenAt] of signatures) {
    if (now - seenAt > 90_000) signatures.delete(key);
  }
}

function isUsableVideoViewport(viewport: VideoViewport | undefined): viewport is VideoViewport {
  return Boolean(viewport?.viewportWidth && viewport.viewportHeight && viewport.viewportWidth >= 160 && viewport.viewportHeight >= 120);
}

function toSummary(track: TrackedCard): TrackSummary {
  const { firstSeenAt: _firstSeenAt, lastSeenAt: _lastSeenAt, stableSince: _stableSince, identifyRequestedAt: _identifyRequestedAt, inFlight: _inFlight, ...summary } = track;
  return summary;
}

function isPageContext(value: unknown): value is PageContext {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PageContext>;
  return (
    typeof candidate.url === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.visibleText === "string" &&
    typeof candidate.auctionText === "string" &&
    typeof candidate.collectedAt === "number" &&
    Boolean(candidate.videoViewport)
  );
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailPanel({ track }: { track: TrackedCard }): JSX.Element {
  return (
    <section className="detailPanel">
      <div className="detailHeader">
        <BadgeDollarSign size={18} />
        <div>
          <h2>{track.identity?.player || "Card candidate"}</h2>
          <p>{track.identity?.rawText || "Waiting for a stable crop and identity signal."}</p>
        </div>
      </div>

      {track.valuation?.source && track.valuation.source !== "none" ? (
        <div className="valueBox">
          <span>{valuationTitle(track.valuation)}</span>
          <strong>
            {formatPrice(track.valuation.low)}-{formatPrice(track.valuation.high)}
          </strong>
          <small>Suggested max bid: {formatPrice(track.valuation.maxBid)}</small>
        </div>
      ) : (
        <div className="valueBox muted">
          <span>No fast value yet</span>
          <strong>Comp search ready after identity</strong>
          <small>Do not chase without confidence.</small>
        </div>
      )}

      {track.identity ? <IdentityFacts identity={track.identity} /> : null}
      {track.valuation ? <ValuationNotes valuation={track.valuation} /> : null}

      {track.compLinks.length ? (
        <div className="links">
          <h3>Comp Links</h3>
          {track.compLinks.map((link) => (
            <a href={link.url} key={link.url} rel="noreferrer" target="_blank">
              <ExternalLink size={14} />
              {link.label}
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function valuationTitle(valuation: Valuation): string {
  if (valuation.source === "price-guide" || valuation.priceGuideQuote) return "Price-backed Fast Value";
  if (valuation.source === "ai-estimate") return "Provisional Fast Value";
  if (valuation.source === "seeded-demo") return "Demo Fast Value";
  if (valuation.source === "session-cache") return "Cached Fast Value";
  return "Fast Value";
}

function HistoryPanel({ items, onClear }: { items: ScanHistoryItem[]; onClear: () => Promise<void> }): JSX.Element {
  return (
    <section className="historyPanel">
      <div className="sectionHeader">
        <div>
          <h2>History</h2>
          <p>{items.length ? `${items.length} card${items.length === 1 ? "" : "s"} saved for this show` : "Card crops save here as scans resolve."}</p>
        </div>
        <button className="iconButton" type="button" title="Clear show history" onClick={() => onClear().catch(() => undefined)} disabled={!items.length}>
          <Trash2 size={16} />
        </button>
      </div>

      {items.length ? (
        <div className="historyList">
          {items.map((item) => (
            <article className="historyItem" key={item.id}>
              <img alt={item.identity?.rawText || "Scanned card crop"} src={item.cropImageDataUrl} />
              <div>
                <div className="historyTitle">
                  <span className={`dot ${item.badgeTone}`} />
                  <strong>{item.identity?.player || item.identity?.rawText || "Card candidate"}</strong>
                </div>
                <p>{item.label}</p>
                <small>
                  <Clock3 size={12} />
                  {formatHistoryTime(item.lastSeenAt)} · {Math.round((item.identity?.confidence ?? item.detectionConfidence) * 100)}%
                </small>
                {item.compLinks.length ? (
                  <div className="miniLinks">
                    {item.compLinks.slice(0, 3).map((link) => (
                      <a href={link.url} key={link.url} rel="noreferrer" target="_blank">
                        {link.source}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="empty">No saved scans for this show yet.</p>
      )}
    </section>
  );
}

function formatHistoryTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(timestamp);
}

function IdentityFacts({ identity }: { identity: CardIdentity }): JSX.Element {
  const facts = [
    ["Player", identity.player],
    ["Year", identity.year],
    ["Set", identity.set],
    ["Number", identity.cardNumber],
    ["Parallel", identity.parallel],
    ["Grade", [identity.gradeCompany, identity.grade].filter(Boolean).join(" ")]
  ].filter(([, value]) => value);

  return (
    <div className="facts">
      <h3>Identity</h3>
      {facts.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
      <div>
        <span>Confidence</span>
        <strong>{Math.round(identity.confidence * 100)}%</strong>
      </div>
    </div>
  );
}

function ValuationNotes({ valuation }: { valuation: Valuation }): JSX.Element {
  return (
    <div className="notes">
      <h3>Why</h3>
      {[...valuation.reasons, ...valuation.warnings].slice(0, 7).map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );
}

function SettingsPanel({
  settings,
  onChange
}: {
  settings: ExtensionSettings;
  onChange: (settings: ExtensionSettings) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(settings);
  const preset = providerPreset(draft.provider.provider);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  return (
    <section className="settingsPanel">
      <h2>Settings</h2>
      <label>
        Provider
        <select
          value={draft.provider.provider}
          onChange={(event) =>
            setDraft({
              ...draft,
              provider: applyProviderPreset(draft.provider, event.target.value as ExtensionSettings["provider"]["provider"])
            })
          }
        >
          <option value="mock">Mock/page-text only</option>
          <option value="openai">OpenAI / ChatGPT API</option>
          <option value="openrouter">OpenRouter</option>
          <option value="anthropic">Anthropic Claude</option>
          <option value="custom-openai-compatible">Custom OpenAI-compatible</option>
        </select>
        <span className="helper">{preset.help}</span>
      </label>
      <label>
        Price guide proxy
        <input
          value={draft.priceGuideProxyUrl}
          onChange={(event) => setDraft({ ...draft, priceGuideProxyUrl: event.target.value })}
          placeholder="http://127.0.0.1:8787/v1/price-guide/lookup"
        />
        <span className="helper">CardSync proxy endpoint for SportsCardsPro values. Leave blank to use manual comp links only.</span>
      </label>
      <label>
        API key
        <input
          type="password"
          value={draft.provider.apiKey}
          onChange={(event) => setDraft({ ...draft, provider: { ...draft.provider, apiKey: event.target.value } })}
          disabled={draft.provider.provider === "mock"}
          placeholder={preset.keyPlaceholder}
        />
        <span className="helper">Stored locally in Chrome, never in CardSync infrastructure.</span>
      </label>
      <label>
        Base URL
        <input
          value={draft.provider.baseUrl}
          disabled={preset.baseUrlReadonly}
          onChange={(event) => setDraft({ ...draft, provider: { ...draft.provider, baseUrl: event.target.value } })}
        />
      </label>
      <label>
        Model
        <input
          value={draft.provider.model}
          onChange={(event) => setDraft({ ...draft, provider: { ...draft.provider, model: event.target.value } })}
        />
      </label>
      <label className="checkRow">
        <input
          type="checkbox"
          checked={draft.allowAiEstimatedValues}
          onChange={(event) => setDraft({ ...draft, allowAiEstimatedValues: event.target.checked })}
        />
        Allow clearly labeled AI provisional values
      </label>
      <button className="secondaryButton" type="button" onClick={() => onChange(draft)}>
        Save settings
      </button>
    </section>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
