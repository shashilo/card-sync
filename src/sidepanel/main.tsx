import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, BadgeDollarSign, Clock3, Copy, Crosshair, Download, ExternalLink, FileText, Loader2, Play, Settings, Square, Trash2 } from "lucide-react";
import { consumePendingCapture, type PendingCapture } from "../shared/capture";
import type { RuntimeMessage } from "../shared/messages";
import { getActiveTab, sendToActiveTab, sendToTab } from "../shared/messages";
import { applyProviderPreset, providerPreset, requestCustomProviderPermission } from "../shared/providers";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../shared/settings";
import { appendDiagnosticLog, clearDiagnosticLog, readDiagnosticLog, type DiagnosticEntry } from "../shared/diagnostics";
import type { BadgeTone, CardIdentity, ExtensionSettings, PageContext, PriceLookupState, ScanHistoryItem, TrackSummary, Valuation, VideoViewport } from "../shared/types";
import { identifyCard } from "./lib/ai";
import { detectCardBoxes } from "./lib/detector";
import { clearShowHistory, listShowHistory, showKeyFromUrl, upsertScanHistoryItem } from "./lib/history";
import { identityKey, identitySearchText, inferIdentityFromContext } from "./lib/identity";
import { lookupPriceGuide, type PriceGuideLookupResult } from "./lib/price-guide";
import { lookup130PointComps, lookupFreeComps, valuationFromFreeComps } from "./lib/free-comps";
import type { FreeCompLookupResult } from "./lib/free-comps";
import { lookupCardLadderComps } from "./lib/card-ladder";
import { withMaxBidPercent, generateCompLinks, buildValuation, rememberValuation, stageFor } from "./lib/pricing";
import { rememberCardFingerprint, shouldPersistScanHistory, shouldStartScanForFingerprint, type ActiveScanFingerprint } from "./lib/scan-gate";
import { formatPrice, labelForTrack, priceLookupLabel, updateTrackedCards, type TrackedCard } from "./lib/tracker";
import "./styles.css";

const WHATNOT_RE = /^https:\/\/([a-z0-9-]+\.)?whatnot\.com\//i;

interface CropSnapshot {
  dataUrl: string;
  fingerprint: string;
}

interface ActiveScan extends ActiveScanFingerprint {
  signature: string;
  requestId: string;
}

function App(): JSX.Element {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<PageContext | undefined>();
  const [tracks, setTracks] = useState<TrackedCard[]>([]);
  const [activeTrackId, setActiveTrackId] = useState<string | undefined>();
  const [historyItems, setHistoryItems] = useState<ScanHistoryItem[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);

  const settingsRef = useRef(settings);
  const contextRef = useRef<PageContext | undefined>();
  const tracksRef = useRef<TrackedCard[]>([]);
  const activeTrackIdRef = useRef<string | undefined>();
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
  const scanHistoryIdsRef = useRef(new Map<string, string>());
  const recentScanSignaturesRef = useRef(new Map<string, number>());
  const recentCardFingerprintsRef = useRef(new Map<string, number>());
  const activeScansRef = useRef(new Map<string, ActiveScan>());
  const aiIdentificationInFlightRef = useRef(false);
  const nextAiIdentificationAtRef = useRef(0);
  const contextPrewarmRef = useRef(new Map<string, number>());
  const sessionCacheRef = useRef(new Map<string, Valuation>());
  const lastDetectorLogAtRef = useRef(0);
  const lastDetectionCountRef = useRef<number | undefined>();

  function logDiagnostic(event: string, details?: Record<string, string | number | boolean | null>): void {
    appendDiagnosticLog(event, details).then(setDiagnostics).catch(() => undefined);
  }

  useEffect(() => {
    loadSettings().then((loaded) => {
      setSettings(loaded);
      settingsRef.current = loaded;
      logDiagnostic("Settings loaded", {
        provider: loaded.provider.provider,
        keyConfigured: Boolean(loaded.provider.apiKey.trim()),
        endpointHost: safeHost(loaded.provider.baseUrl),
        model: loaded.provider.model || "(empty)"
      });
    });
    readDiagnosticLog().then(setDiagnostics).catch(() => undefined);
    const storageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes["cardsync.diagnostics"]) {
        setDiagnostics(Array.isArray(changes["cardsync.diagnostics"].newValue) ? changes["cardsync.diagnostics"].newValue as DiagnosticEntry[] : []);
      }
    };
    chrome.storage.onChanged.addListener(storageListener);
    return () => chrome.storage.onChanged.removeListener(storageListener);
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  useEffect(() => {
    activeTrackIdRef.current = activeTrackId;
  }, [activeTrackId]);

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
        logDiagnostic("Page context received", {
          viewportWidth: message.context.videoViewport.viewportWidth,
          viewportHeight: message.context.videoViewport.viewportHeight,
          videoFound: Boolean(message.context.videoViewport.videoRect),
          auctionTextLength: message.context.auctionText.length
        });
        prewarmPriceGuideFromContext(message.context).catch(() => undefined);
      }
      if (message.type === "CS_MANUAL_CAPTURE") {
        logDiagnostic("Manual capture requested", { trackId: message.trackId ?? "active" });
        manualCapture(message.trackId).catch((caught) => {
          const messageText = caught instanceof Error ? caught.message : "Manual capture failed.";
          logDiagnostic("Manual capture failed", { message: messageText });
          setError(messageText);
        });
      }
      if (message.type === "BG_CAPTURE_READY") {
        logDiagnostic("Tab capture armed", { targetTabId: message.capture.targetTabId ?? null });
        startFromPendingCapture(message.capture);
      }
      if (message.type === "BG_CAPTURE_ERROR") {
        logDiagnostic("Tab capture failed", { message: message.message });
        setError(message.message);
      }
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
    const updatedTracks = tracksRef.current.map((track) => {
      if (!track.valuation) return track;
      const valuation = withMaxBidPercent(track.valuation, next.maxBidPercent, track.freeComps?.[0]?.price);
      return { ...track, valuation };
    });
    tracksRef.current = updatedTracks;
    setTracks(updatedTracks);
    await saveSettings(next);
    logDiagnostic("Settings saved", {
      provider: next.provider.provider,
      keyConfigured: Boolean(next.provider.apiKey.trim()),
      endpointHost: safeHost(next.provider.baseUrl),
      model: next.provider.model || "(empty)"
    });
  }

  async function copyDiagnosticLog(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setDiagnosticsCopied(true);
      window.setTimeout(() => setDiagnosticsCopied(false), 1800);
    } catch {
      setError("Clipboard access was blocked. Download the diagnostic log instead.");
    }
  }

  function downloadDiagnosticLog(): void {
    const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "cardsync-diagnostics.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function clearDiagnostics(): Promise<void> {
    await clearDiagnosticLog();
    setDiagnostics([]);
  }

  function startScanning(): void {
    setError("Click the CardSync toolbar icon while the Whatnot stream tab is active. Chrome requires the toolbar click to arm live tab capture.");
  }

  function startFromPendingCapture(capture: PendingCapture): void {
    if (streamRef.current) stopScanning();
    const runId = scanRunRef.current + 1;
    scanRunRef.current = runId;
    setError(null);
    logDiagnostic("Opening captured tab stream", { runId, targetTabId: capture.targetTabId ?? null });

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
        logDiagnostic("Captured tab stream opened", { runId, trackCount: stream.getTracks().length });
        return setupCapturedStream(stream, capture.targetTabId, runId);
      })
      .catch((caught) => {
        if (scanRunRef.current !== runId) return;
        logDiagnostic("Captured tab stream failed", { runId, message: caught instanceof Error ? caught.message : "Unable to start captured stream" });
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
      logDiagnostic("Scanner started", {
        runId,
        tabId: tab.id,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        provider: settingsRef.current.provider.provider,
        keyConfigured: Boolean(settingsRef.current.provider.apiKey.trim())
      });
      scheduleLoop(runId);
    } catch (caught) {
      logDiagnostic("Scanner setup failed", { runId, message: caught instanceof Error ? caught.message : "Unable to start tab capture" });
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
    recentCardFingerprintsRef.current.clear();
    activeScansRef.current.clear();
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
    if (!settingsRef.current.autoScan) return;
    const currentSettings = settingsRef.current;
    const targetTabId = captureTabIdRef.current;
    if (targetTabId && now - lastContextPullAtRef.current > 500) {
      lastContextPullAtRef.current = now;
      requestPageContext(targetTabId).catch(() => undefined);
    }

    const videoViewport = contextRef.current?.videoViewport;
    if (!isUsableVideoViewport(videoViewport)) {
      if (now - lastDetectorLogAtRef.current > 5_000) {
        lastDetectorLogAtRef.current = now;
        logDiagnostic("Waiting for Whatnot video viewport", {
          contextReceived: Boolean(contextRef.current),
          videoFound: Boolean(contextRef.current?.videoViewport.videoRect)
        });
      }
      if (tracksRef.current.length) {
        tracksRef.current = [];
        setTracks([]);
      }
      return;
    }

    const detections = detectCardBoxes(video, canvas, videoViewport, currentSettings.maxTrackedCards);
    if (detections.length !== lastDetectionCountRef.current || now - lastDetectorLogAtRef.current > 5_000) {
      lastDetectionCountRef.current = detections.length;
      lastDetectorLogAtRef.current = now;
      logDiagnostic(detections.length ? "Card candidates detected" : "No card candidates detected", {
        count: detections.length,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        viewportWidth: videoViewport.viewportWidth,
        viewportHeight: videoViewport.viewportHeight
      });
    }
    const nextTracks = updateTrackedCards(tracksRef.current, detections, now, currentSettings.maxTrackedCards);

    tracksRef.current = nextTracks;
    setTracks(nextTracks);
    prewarmIdentities(nextTracks, now).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "Identification failed.");
    });
  }

  function scanNow(): void {
    if (!streamRef.current) {
      startScanning();
      return;
    }
    const previous = settingsRef.current.autoScan;
    settingsRef.current.autoScan = true;
    runScanTick();
    settingsRef.current.autoScan = previous;
  }

  async function prewarmIdentities(currentTracks: TrackedCard[], now: number): Promise<void> {
    const video = videoRef.current;
    if (!video) return;

    for (const track of currentTracks) {
      const stableFor = now - (track.stableSince ?? track.firstSeenAt);
      const visibleFor = now - track.firstSeenAt;
      const veryRecentlyRequested = track.identifyRequestedAt && now - track.identifyRequestedAt < 10_000;
      const readyForFastAttempt =
        stableFor >= settingsRef.current.identifyStableAfterMs ||
        visibleFor >= 450 ||
        track.detectionConfidence >= 0.34;

      if (!readyForFastAttempt || veryRecentlyRequested) continue;

      await startTrackScan(track, now);
    }
  }

  async function manualCapture(trackId?: string): Promise<void> {
    const track =
      (trackId ? tracksRef.current.find((candidate) => candidate.id === trackId) : undefined) ??
      (activeTrackIdRef.current ? tracksRef.current.find((candidate) => candidate.id === activeTrackIdRef.current) : undefined) ??
      tracksRef.current[0];

    if (!streamRef.current || !videoRef.current) {
      logDiagnostic("Manual capture blocked", { reason: "scanner-not-running" });
      setError("Start scanning before using manual capture.");
      return;
    }

    if (!track) {
      logDiagnostic("Manual capture blocked", { reason: "no-card-outline" });
      setError("No card outline is active yet. Wait for CardSync to draw the card, then click the outline to force capture.");
      return;
    }

    const started = await startTrackScan(track, Date.now(), { force: true });
    if (!started) {
      logDiagnostic("Manual capture blocked", { reason: "crop-not-ready" });
      setError("CardSync could not crop the current card yet. Try again when the outline is visible.");
      return;
    }

    setError(null);
  }

  async function startTrackScan(track: TrackedCard, now: number, options: { force?: boolean } = {}): Promise<boolean> {
    const video = videoRef.current;
    if (!video) return false;

    const crop = cropTrack(video, track);
    if (!crop) {
      logDiagnostic("Card crop failed", { trackId: track.id, detectionConfidence: track.detectionConfidence });
      return false;
    }
    const contextIdentity = inferIdentityFromContext(contextRef.current);
    const signature = scanSignature(contextIdentity, track, crop);
    const activeScan = activeScansRef.current.get(track.id);

    if (!options.force) {
      const scanDecision = shouldStartScanForFingerprint(activeScan, recentCardFingerprintsRef.current, crop.fingerprint, now);
      if (scanDecision.activeScan && activeScan) activeScansRef.current.set(track.id, { ...activeScan, ...scanDecision.activeScan });
      if (!scanDecision.shouldScan) return false;
      if (hasRecentScanSignature(recentScanSignaturesRef.current, signature, now)) return false;
    }

    // Keep the active request record stable until its response is applied. Updating it
    // for every slightly different video frame makes a valid AI response look stale.
    if (aiIdentificationInFlightRef.current) {
      logDiagnostic("Card identification skipped", { reason: "another-request-in-flight", provider: settingsRef.current.provider.provider });
      return false;
    }
    if (Date.now() < nextAiIdentificationAtRef.current) {
      logDiagnostic("Card identification skipped", { reason: "provider-request-cooldown", provider: settingsRef.current.provider.provider });
      return false;
    }

    const requestId = crypto.randomUUID();
    rememberScanSignature(recentScanSignaturesRef.current, signature, now);
    rememberCardFingerprint(recentCardFingerprintsRef.current, crop.fingerprint, now);
    activeScansRef.current.set(track.id, { signature, fingerprint: crop.fingerprint, requestId });
    const pendingPriceLookup = priceLookupState("free-comps-pending", "Searching Card Ladder sales.");
    markTrack(track.id, { inFlight: true, identifyRequestedAt: now, stage: "candidate", priceLookup: pendingPriceLookup });
    logDiagnostic("Card crop ready", {
      trackId: track.id,
      cropWidth: cropCanvasRef.current?.width ?? 0,
      cropHeight: cropCanvasRef.current?.height ?? 0,
      boxWidth: Math.round(track.box.width),
      boxHeight: Math.round(track.box.height),
      detectionConfidence: Math.round(track.detectionConfidence * 100)
    });

    const contextValuation = buildValuation(
      contextIdentity,
      sessionCacheRef.current,
      undefined,
      false
    );
    const contextStage = stageFor(contextIdentity, contextValuation);
    const contextCompLinks = generateCompLinks(contextIdentity);
    markTrack(track.id, {
      identity: contextIdentity,
      valuation: contextValuation,
      compLinks: contextCompLinks,
      stage: contextStage,
      priceLookup: pendingPriceLookup,
      updatedAt: Date.now()
    });
    persistTrackHistory(track, crop.dataUrl, {
      identity: contextIdentity,
      valuation: contextValuation,
      compLinks: contextCompLinks,
      stage: contextStage,
      priceLookup: pendingPriceLookup
    }, signature).catch(() => undefined);
    applyPriceGuide(track.id, track, crop.dataUrl, contextIdentity, signature, requestId).catch(() => undefined);

    const provider = settingsRef.current.provider;
    if (provider.provider === "mock" || !provider.apiKey.trim()) {
      logDiagnostic("AI request skipped", { reason: provider.provider === "mock" ? "mock-provider-selected" : "api-key-missing", provider: provider.provider });
      markTrack(track.id, { inFlight: false });
      return true;
    }

    logDiagnostic("Card identification request started", { provider: provider.provider, model: provider.model, endpointHost: safeHost(provider.baseUrl) });
    aiIdentificationInFlightRef.current = true;
    nextAiIdentificationAtRef.current = Date.now() + 8_000;
    identifyCard(crop.dataUrl, contextRef.current, settingsRef.current)
      .then(({ identity, estimate, error: identificationError }) => {
        const currentActiveScan = activeScansRef.current.get(track.id);
        if (currentActiveScan?.requestId === requestId) {
          activeScansRef.current.set(track.id, { ...currentActiveScan, completed: true });
        }
        logDiagnostic(identificationError ? "Card identification failed" : "Card identification response received", {
          provider: provider.provider,
          model: provider.model,
          trackId: track.id,
          cardIdentity: JSON.stringify({ player: identity.player, brand: identity.brand, cardType: identity.cardType, year: identity.year, set: identity.set, cardNumber: identity.cardNumber, parallel: identity.parallel, serialNumber: identity.serialNumber, numbered: identity.numbered, autograph: identity.autograph }),
          confidence: Math.round(identity.confidence * 100),
          hasPlayer: Boolean(identity.player),
          hasYear: Boolean(identity.year),
          hasSet: Boolean(identity.set),
          hasEstimate: Boolean(estimate),
          error: identificationError ?? ""
        });
        logDiagnostic("AI value estimate received", {
          trackId: track.id,
          low: estimate?.low ?? null,
          high: estimate?.high ?? null,
          maxBid: estimate?.maxBid ?? null,
          confidence: estimate?.confidence ?? null,
          reasons: JSON.stringify(estimate?.reasons ?? []),
          warnings: JSON.stringify(estimate?.warnings ?? [])
        });
        if (!isCurrentScan(track.id, signature, requestId)) return;
        if (identificationError) {
          markTrack(track.id, {
            identity,
            inFlight: false,
            stage: "error",
            label: identificationError,
            priceLookup: priceLookupState("error", identificationError),
            updatedAt: Date.now()
          });
          return;
        }
        const valuation = buildValuation(
          identity,
          sessionCacheRef.current,
          estimate,
          settingsRef.current.allowAiEstimatedValues,
          undefined,
          settingsRef.current.maxBidPercent
        );
        logDiagnostic("Valuation decision", {
          trackId: track.id,
          source: valuation.source,
          allowAiEstimate: settingsRef.current.allowAiEstimatedValues,
          identityConfidence: Math.round(identity.confidence * 100),
          estimateConfidence: estimate?.confidence ?? null,
          low: valuation.low,
          high: valuation.high,
          maxBid: valuation.maxBid,
          confidence: Math.round(valuation.confidence * 100),
          compCount: valuation.compCount,
          reasons: JSON.stringify(valuation.reasons),
          warnings: JSON.stringify(valuation.warnings)
        });
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
        persistTrackHistory(track, crop.dataUrl, {
          identity,
          valuation,
          compLinks,
          stage
        }, signature).catch(() => undefined);
        applyPriceGuide(track.id, track, crop.dataUrl, identity, signature, requestId).catch(() => undefined);
      })
      .catch((caught) => {
        if (!isCurrentScan(track.id, signature, requestId)) return;
        const message = caught instanceof Error ? caught.message : "Unknown error";
        logDiagnostic("Card identification request failed", { provider: provider.provider, error: message });
        markTrack(track.id, {
          inFlight: false,
          stage: "error",
          label: `AI error: ${message}`
        });
      })
      .finally(() => {
        aiIdentificationInFlightRef.current = false;
      });

    return true;
  }

  function isCurrentScan(trackId: string, signature: string, requestId?: string): boolean {
    const activeScan = activeScansRef.current.get(trackId);
    return activeScan?.signature === signature && (!requestId || activeScan.requestId === requestId);
  }

  async function applyPriceGuide(trackId: string, track: TrackedCard, crop: string, identity: CardIdentity, signature?: string, requestId?: string): Promise<void> {
    logDiagnostic("Card Ladder search started", { trackId, query: identitySearchText(identity), identityConfidence: Math.round(identity.confidence * 100) });
    const ladderResult = await lookupCardLadderComps(identity);
    for (const attempt of ladderResult.searchAttempts ?? []) {
      logDiagnostic("Card Ladder search attempt", { trackId, query: attempt.query, status: attempt.status, count: attempt.count, message: attempt.message });
    }
    for (const comp of ladderResult.comps) {
      logDiagnostic("Card Ladder sale extracted", { trackId, title: comp.title, price: comp.price, soldDate: comp.soldDate ?? "", verified: Boolean(comp.verified), url: comp.url });
    }
    logDiagnostic("Card Ladder search completed", { trackId, status: ladderResult.status, count: ladderResult.comps.length, message: ladderResult.message });
    if (ladderResult.comps.length || !settingsRef.current.priceGuideProxyUrl.trim()) {
      logDiagnostic("Pricing source route selected", {
        trackId,
        nextSource: ladderResult.comps.length ? "Card Ladder comps" : "eBay sold fallback",
        cardLadderCompCount: ladderResult.comps.length,
        sportsCardsProProxyConfigured: Boolean(settingsRef.current.priceGuideProxyUrl.trim()),
        reason: ladderResult.comps.length ? "Card Ladder returned sale rows." : "No Card Ladder sales were extracted and no SportsCardsPro proxy is configured."
      });
      await applyFreeComps(trackId, track, crop, identity, signature, requestId, ladderResult);
      return;
    }

    logDiagnostic("Pricing source route selected", { trackId, nextSource: "SportsCardsPro proxy", reason: "No Card Ladder comps were returned and a price-guide proxy is configured." });

    if (settingsRef.current.priceGuideProxyUrl.trim()) {
      markTrack(trackId, {
        priceLookup: priceLookupState("pending", "Checking SportsCardsPro.")
      });
    }
    const result = await lookupPriceGuide(identity, settingsRef.current.priceGuideProxyUrl);
    logDiagnostic("SportsCardsPro lookup completed", {
      trackId,
      status: result.status,
      message: result.message,
      matchedProduct: result.quote?.productName ?? "",
      matchedSet: result.quote?.setName ?? "",
      selectedCondition: result.quote?.selectedCondition ?? "",
      selectedPrice: result.quote?.selectedPrice ?? null,
      matchConfidence: result.quote?.confidence ?? null,
      warnings: JSON.stringify(result.quote?.warnings ?? [])
    });
    if (signature && !isCurrentScan(trackId, signature, requestId)) return;
    if (result.status !== "ready" || !result.quote) {
      const nextStatus = result.status === "ready" ? "no-match" : result.status;
      markTrack(trackId, {
        inFlight: false,
        priceLookup: priceLookupState(nextStatus, result.message),
        updatedAt: Date.now()
      });
      await persistTrackHistory(track, undefined, {
        identity,
        valuation: tracksRef.current.find((candidate) => candidate.id === trackId)?.valuation,
        compLinks: generateCompLinks(identity),
        freeComps: tracksRef.current.find((candidate) => candidate.id === trackId)?.freeComps,
        stage: tracksRef.current.find((candidate) => candidate.id === trackId)?.stage ?? "candidate",
        priceLookup: priceLookupState(nextStatus, result.message)
      }, signature);
      return;
    }

    const valuation = buildValuation(identity, sessionCacheRef.current, undefined, settingsRef.current.allowAiEstimatedValues, result.quote, settingsRef.current.maxBidPercent);
    logDiagnostic("SportsCardsPro valuation decision", {
      trackId,
      source: valuation.source,
      selectedPrice: result.quote.selectedPrice,
      selectedCondition: result.quote.selectedCondition,
      matchConfidence: result.quote.confidence,
      low: valuation.low,
      high: valuation.high,
      maxBid: valuation.maxBid,
      confidence: Math.round(valuation.confidence * 100),
      reasons: JSON.stringify(valuation.reasons),
      warnings: JSON.stringify(valuation.warnings)
    });
    const compLinks = generateCompLinks(identity);
    rememberValuation(identity, valuation, sessionCacheRef.current);
    const stage = stageFor(identity, valuation);
    const priceLookup =
      valuation.source === "price-guide"
        ? priceLookupState("ready", `SportsCardsPro ${result.quote.selectedCondition} price is ready.`)
        : priceLookupState("no-match", valuation.reasons[0] || "SportsCardsPro match was not confident enough to price.");
    markTrack(trackId, {
      identity,
      valuation,
      compLinks,
      stage,
      inFlight: false,
      priceLookup,
      updatedAt: Date.now()
    });
    await persistTrackHistory(track, crop, {
      identity,
      valuation,
      compLinks,
      freeComps: undefined,
      stage,
      priceLookup
    }, signature);
  }

  async function applyFreeComps(trackId: string, track: TrackedCard, crop: string, identity: CardIdentity, signature?: string, requestId?: string, initialLadderResult?: FreeCompLookupResult): Promise<void> {
    const compLinks = generateCompLinks(identity);
    markTrack(trackId, {
      priceLookup: priceLookupState("free-comps-pending", "Fetching Card Ladder sales comps.")
    });
    const pointResult = await lookup130PointComps(identity);
    const ladderResult = pointResult.comps.length ? pointResult : (initialLadderResult ?? await lookupCardLadderComps(identity));
    const result = pointResult.comps.length ? pointResult : (ladderResult.comps.length ? ladderResult : await lookupFreeComps(identity, compLinks));
    const compSearchAttempts = [...(ladderResult.searchAttempts ?? []), ...(ladderResult.comps.length ? [] : result.searchAttempts ?? [])];
    if (!ladderResult.comps.length) {
      for (const attempt of result.searchAttempts ?? []) {
        logDiagnostic("eBay sold search attempt", { trackId, query: attempt.query, status: attempt.status, count: attempt.count, message: attempt.message });
      }
    }
    for (const comp of result.comps) {
      logDiagnostic("Sold comp considered", { trackId, source: comp.source, title: comp.title, price: comp.price, soldDate: comp.soldDate ?? "", verified: Boolean(comp.verified), url: comp.url });
    }
    const resultMessage = ladderResult.comps.length
      ? ladderResult.message
      : result.comps.length
        ? `${ladderResult.message} Using the eBay fallback. ${result.message}`
        : `${ladderResult.message} ${result.message}`;
    logDiagnostic("Free comps lookup completed", { provider: result.comps[0]?.source ?? "none", status: result.status, count: result.comps.length, identityConfidence: Math.round(identity.confidence * 100), message: resultMessage });
    if (signature && !isCurrentScan(trackId, signature, requestId)) return;

    const valuation = result.comps.length ? valuationFromFreeComps(identity, result.comps, settingsRef.current.maxBidPercent) : tracksRef.current.find((candidate) => candidate.id === trackId)?.valuation;
    if (result.comps.length && valuation) {
      const sortedPrices = result.comps.map((comp) => comp.price).filter((price) => price > 0).sort((a, b) => a - b);
      const medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)];
      logDiagnostic("Comp valuation decision", {
        trackId,
        source: valuation.source,
        includedPrices: JSON.stringify(sortedPrices),
        count: sortedPrices.length,
        medianPrice,
        maxBidRule: `${settingsRef.current.maxBidPercent}% of latest sold price`,
        maxBidReferencePrice: result.comps[0]?.price ?? null,
        maxBidReferenceDate: result.comps[0]?.soldDate ?? null,
        low: valuation.low,
        high: valuation.high,
        maxBid: valuation.maxBid,
        confidence: Math.round(valuation.confidence * 100),
        reasons: JSON.stringify(valuation.reasons),
        warnings: JSON.stringify(valuation.warnings)
      });
    }
    const stage = valuation ? stageFor(identity, valuation) : tracksRef.current.find((candidate) => candidate.id === trackId)?.stage ?? "candidate";
    const priceLookup = priceLookupState(result.status, resultMessage);
    markTrack(trackId, {
      identity,
      valuation,
      compLinks,
      freeComps: result.comps,
      compSearchAttempts,
      stage,
      inFlight: false,
      priceLookup,
      updatedAt: Date.now()
    });
    await persistTrackHistory(track, crop, {
      identity,
      valuation,
      compLinks,
      freeComps: result.comps,
      compSearchAttempts,
      maxBidPercent: settingsRef.current.maxBidPercent,
      stage,
      priceLookup
    }, signature);
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

    const result = await lookupPriceGuide(identity, settingsRef.current.priceGuideProxyUrl);
    if (result.status !== "ready" || !result.quote) return;

    const valuation = buildValuation(identity, sessionCacheRef.current, undefined, settingsRef.current.allowAiEstimatedValues, result.quote, settingsRef.current.maxBidPercent);
    rememberValuation(identity, valuation, sessionCacheRef.current);
    applyPrewarmedValuationToCurrentTracks(identity, valuation, result);
  }

  function applyPrewarmedValuationToCurrentTracks(identity: CardIdentity, valuation: Valuation, lookup: PriceGuideLookupResult): void {
    const key = identityKey(identity);
    if (!key || valuation.source === "none") return;

    for (const track of tracksRef.current) {
      const trackIdentity = track.identity ?? inferIdentityFromContext(contextRef.current);
      if (identityKey(trackIdentity) !== key) continue;

      const compLinks = generateCompLinks(identity);
      const stage = stageFor(identity, valuation);
      const priceLookup = priceLookupState("ready", lookup.message);
      markTrack(track.id, {
        identity,
        valuation,
        compLinks,
        stage,
        inFlight: false,
        priceLookup,
        updatedAt: Date.now()
      });
      persistTrackHistory(track, undefined, {
        identity,
        valuation,
        compLinks,
        stage,
        priceLookup
      }).catch(() => undefined);
    }
  }

  async function loadHistoryForShow(showUrl: string): Promise<void> {
    const showKey = showKeyFromUrl(showUrl);
    if (showKeyRef.current !== showKey) {
      scanHistoryIdsRef.current.clear();
      recentScanSignaturesRef.current.clear();
      recentCardFingerprintsRef.current.clear();
      activeScansRef.current.clear();
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
    patch: Pick<TrackedCard, "identity" | "valuation" | "compLinks" | "stage"> & {
      freeComps?: TrackedCard["freeComps"];
      compSearchAttempts?: TrackedCard["compSearchAttempts"];
      maxBidPercent?: number;
      priceLookup?: PriceLookupState;
    },
    signature?: string
  ): Promise<void> {
    const showKey = showKeyRef.current;
    const historyKey = signature ?? activeScansRef.current.get(track.id)?.signature ?? track.id;
    if (!shouldPersistScanHistory(patch.stage, patch.identity?.confidence)) return;
    if (!showKey || (!cropImageDataUrl && !scanHistoryIdsRef.current.has(historyKey))) return;

    const existingId = scanHistoryIdsRef.current.get(historyKey);
    const id = existingId ?? crypto.randomUUID();
    scanHistoryIdsRef.current.set(historyKey, id);
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
        priceLookup: patch.priceLookup,
        detectionConfidence: track.detectionConfidence
      }),
      identity: patch.identity,
      valuation: patch.valuation,
      compLinks: patch.compLinks,
      freeComps: patch.freeComps,
      compSearchAttempts: patch.compSearchAttempts,
      maxBidPercent: patch.maxBidPercent ?? settingsRef.current.maxBidPercent,
      priceLookup: patch.priceLookup
    });

    setHistoryItems((current) => [item, ...current.filter((candidate) => candidate.id !== item.id)].sort((a, b) => b.lastSeenAt - a.lastSeenAt));
  }

  async function clearCurrentShowHistory(): Promise<void> {
    const showKey = showKeyRef.current;
    if (!showKey) return;
    await clearShowHistory(showKey);
    scanHistoryIdsRef.current.clear();
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

  function cropTrack(
    video: HTMLVideoElement,
    track: TrackedCard,
    options: { yRatio?: number; heightRatio?: number; maxSide?: number; quality?: number } = {}
  ): CropSnapshot | undefined {
    const canvas = cropCanvasRef.current;
    const viewport = contextRef.current?.videoViewport;
    if (!canvas || !viewport?.viewportWidth || !viewport.viewportHeight) return undefined;

    const displayRect = viewport.videoRect ?? { x: 0, y: 0, width: viewport.viewportWidth, height: viewport.viewportHeight };
    const frameX = ((track.box.x - displayRect.x) / Math.max(1, displayRect.width)) * video.videoWidth;
    const baseFrameY = ((track.box.y - displayRect.y) / Math.max(1, displayRect.height)) * video.videoHeight;
    const frameW = (track.box.width / Math.max(1, displayRect.width)) * video.videoWidth;
    const baseFrameH = (track.box.height / Math.max(1, displayRect.height)) * video.videoHeight;
    const yRatio = options.yRatio ?? 0;
    const heightRatio = options.heightRatio ?? 1;
    const frameY = baseFrameY + baseFrameH * yRatio;
    const frameH = baseFrameH * heightRatio;
    const pad = Math.max(frameW, frameH) * 0.08;
    const sx = Math.max(0, frameX - pad);
    const sy = Math.max(0, frameY - pad);
    const sw = Math.min(video.videoWidth - sx, frameW + pad * 2);
    const sh = Math.min(video.videoHeight - sy, frameH + pad * 2);
    if (sw < 64 || sh < 64) return undefined;

    const maxSide = options.maxSide ?? 512;
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return {
      dataUrl: canvas.toDataURL("image/jpeg", options.quality ?? 0.72),
      fingerprint: fingerprintCanvas(ctx, canvas.width, canvas.height)
    };
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">Whatnot sudden-death POC</p>
          <h1>CardSync</h1>
          <p className="versionLabel">Version {chrome.runtime.getManifest().version}</p>
        </div>
        <div className="topbarActions">
          <button className={`iconButton ${diagnosticsOpen ? "selected" : ""}`} type="button" title="Diagnostics" aria-label="Diagnostics" onClick={() => setDiagnosticsOpen((open) => !open)}>
            <FileText size={17} />
          </button>
          <button className="iconButton" type="button" title="Settings" aria-label="Settings" onClick={() => setSettingsOpen((open) => !open)}>
            <Settings size={18} />
          </button>
        </div>
      </header>

      <section className="controlBand">
        <button className="primaryButton" type="button" onClick={scanning ? (settings.autoScan ? stopScanning : scanNow) : startScanning}>
          {scanning ? (settings.autoScan ? <Square size={17} /> : <Crosshair size={17} />) : <Play size={17} />}
          {scanning ? (settings.autoScan ? "Stop scanning" : "Scan card") : "Arm from toolbar"}
        </button>
        {!settings.autoScan && scanning ? <button className="secondaryButton" type="button" onClick={stopScanning}><Square size={15} /> Stop</button> : null}
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

      {settingsOpen ? <aside className="drawer settingsDrawer"><SettingsPanel settings={settings} onChange={persistSettings} /></aside> : null}
      {diagnosticsOpen ? <aside className="drawer diagnosticsDrawer"><DiagnosticsPanel entries={diagnostics} copied={diagnosticsCopied} onCopy={copyDiagnosticLog} onDownload={downloadDiagnosticLog} onClear={clearDiagnostics} /></aside> : null}

      <section className="hudGrid">
        <Metric label="Tracked" value={tracks.length.toString()} />
        <Metric label="Session values" value={sessionCacheRef.current.size.toString()} />
        <Metric label="Pricing" value={settings.priceGuideProxyUrl.trim() ? "Guide" : "Manual"} />
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
              {track.inFlight ? <Loader2 size={13} className="rowSpinner spin" /> : <span className={`dot ${track.badgeTone}`} />}
              <span>
                <strong>{track.label}</strong>
                <small>{track.identity?.rawText || `${Math.round(track.detectionConfidence * 100)}% rectangle confidence`}</small>
                {track.priceLookup ? <small className={`priceStatus ${track.priceLookup.status}`}>{priceLookupLabel(track.priceLookup)}</small> : null}
              </span>
            </button>
          ))
        ) : (
          <p className="empty">Click the CardSync toolbar icon while a Whatnot live show is active. Card outlines should appear first, then candidate pricing.</p>
        )}
      </section>

      {activeTrack ? <DetailPanel track={activeTrack} /> : null}

      <HistoryPanel items={historyItems} onClear={clearCurrentShowHistory} />
    </main>
  );
}

function badgeToneForStage(stage: TrackedCard["stage"], confidence: number, valuation?: Valuation): BadgeTone {
  if (stage === "error" || stage === "no-bid") return "red";
  if (stage === "comp-backed" && (valuation?.confidence ?? 0) >= 0.72) return "green";
  if (stage === "candidate" || stage === "fast-value") return "yellow";
  return confidence < 0.5 ? "red" : "gray";
}

function priceLookupState(status: PriceLookupState["status"], message: string): PriceLookupState {
  return {
    status,
    message,
    updatedAt: Date.now()
  };
}

function scanSignature(identity: CardIdentity, track: TrackedCard, crop: CropSnapshot): string {
  const key = identityKey(identity);
  return [
    key && identity.confidence >= 0.5 ? `identity:${key}` : `raw:${hashString(identity.rawText)}`,
    `visual:${crop.fingerprint}`,
    Math.round(track.box.width / 25),
    Math.round(track.box.height / 25)
  ].join("|");
}

function fingerprintCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): string {
  const sampleSize = 8;
  const values: number[] = [];
  for (let y = 0; y < sampleSize; y += 1) {
    for (let x = 0; x < sampleSize; x += 1) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) / sampleSize) * width));
      const sy = Math.min(height - 1, Math.floor(((y + 0.5) / sampleSize) * height));
      const pixel = ctx.getImageData(sx, sy, 1, 1).data;
      values.push(pixel[0] * 0.299 + pixel[1] * 0.587 + pixel[2] * 0.114);
    }
  }
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.map((value) => (value >= average ? "1" : "0")).join("");
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
  return Boolean(lastSeenAt && now - lastSeenAt < 2_500);
}

function rememberScanSignature(signatures: Map<string, number>, signature: string, now: number): void {
  if (!signature) return;
  signatures.set(signature, now);
  for (const [key, seenAt] of signatures) {
    if (now - seenAt > 15_000) signatures.delete(key);
  }
}

function isUsableVideoViewport(viewport: VideoViewport | undefined): viewport is VideoViewport {
  return Boolean(viewport?.viewportWidth && viewport.viewportHeight && viewport.viewportWidth >= 160 && viewport.viewportHeight >= 120);
}

function toSummary(track: TrackedCard): TrackSummary {
  const { firstSeenAt: _firstSeenAt, lastSeenAt: _lastSeenAt, stableSince: _stableSince, identifyRequestedAt: _identifyRequestedAt, ...summary } = track;
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

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl ? "invalid-endpoint" : "(empty)";
  }
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
          {track.freeComps?.[0] ? (
            <>
              <span>Last sold · {track.freeComps[0].source}</span>
              <strong>{formatPrice(track.freeComps[0].price)}</strong>
              {track.freeComps[0].soldDate ? <small>{track.freeComps[0].soldDate}</small> : null}
            </>
          ) : track.valuation.priceGuideQuote ? (
            <>
              <span>{valuationTitle(track.valuation)}</span>
              <strong>{formatPrice(track.valuation.priceGuideQuote.selectedPrice)}</strong>
              <small>{track.valuation.priceGuideQuote.selectedCondition} guide price</small>
            </>
          ) : (
            <>
              <span>{track.valuation.source === "ai-estimate" ? "Provisional estimate" : valuationTitle(track.valuation)}</span>
              <strong>{formatPrice((track.valuation.low + track.valuation.high) / 2)}</strong>
            </>
          )}
          <small>Suggested max bid: {formatPrice(track.valuation.maxBid)}</small>
          {track.priceLookup ? <small className={`priceStatus ${track.priceLookup.status}`}>{track.priceLookup.message}</small> : null}
        </div>
      ) : (
        <div className="valueBox muted">
          <span className="inlineStatus">
            {track.inFlight || track.priceLookup?.status === "pending" ? <Loader2 size={13} className="spin" /> : null}
            {track.priceLookup ? priceLookupLabel(track.priceLookup) : track.inFlight ? "Working comp lookup" : "No fast value yet"}
          </span>
          <strong>{track.priceLookup?.message || (track.inFlight ? "Checking identity and pricing" : "Comp search ready after identity")}</strong>
          <small>{track.compLinks.length ? "Card Ladder, eBay, 130 Point, and PSA APR are research links." : "Do not chase without confidence."}</small>
        </div>
      )}

      {track.identity ? <IdentityFacts identity={track.identity} /> : null}
      {track.valuation ? <ValuationNotes valuation={track.valuation} /> : null}
      {track.freeComps?.length ? <FreeCompsPanel comps={track.freeComps} /> : null}

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
  if (valuation.source === "free-comps") return "Best-effort Free Comps";
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
                <HistoryPriceSummary item={item} />
                <small>
                  <Clock3 size={12} />
                  {formatHistoryTime(item.lastSeenAt)} · {Math.round((item.identity?.confidence ?? item.detectionConfidence) * 100)}%
                </small>
                {item.priceLookup ? <small className={`priceStatus ${item.priceLookup.status}`}>{priceLookupLabel(item.priceLookup)}</small> : null}
                <HistoryDecisionDetails item={item} />
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

function HistoryPriceSummary({ item }: { item: ScanHistoryItem }): JSX.Element {
  const latestSale = item.freeComps?.[0];
  const guide = item.valuation?.priceGuideQuote;
  const estimate = item.valuation && item.valuation.source !== "none" ? (item.valuation.low + item.valuation.high) / 2 : undefined;
  const referencePrice = latestSale?.price ?? guide?.selectedPrice ?? estimate;
  const referenceLabel = latestSale ? `Last sold · ${latestSale.source}` : guide ? "Price guide" : estimate ? "Provisional estimate" : "No price found";

  return (
    <div className="historyPrice">
      <span>{referenceLabel}</span>
      <strong>{referencePrice ? formatPrice(referencePrice) : "—"}</strong>
      {latestSale?.soldDate ? <small>{latestSale.soldDate}</small> : null}
      {item.valuation && item.valuation.source !== "none" ? (
        <small>
          Suggested max bid: {formatPrice(item.valuation.maxBid)}
          {item.maxBidPercent !== undefined ? ` (${item.maxBidPercent}%)` : ""}
        </small>
      ) : null}
    </div>
  );
}

function HistoryDecisionDetails({ item }: { item: ScanHistoryItem }): JSX.Element {
  const valuation = item.valuation;
  const latestSale = item.freeComps?.[0];
  const guide = valuation?.priceGuideQuote;
  const referencePrice = latestSale?.price ?? guide?.selectedPrice ?? (valuation && valuation.source !== "none" ? (valuation.low + valuation.high) / 2 : undefined);
  const referenceSource = latestSale?.source ?? (guide ? `${guide.provider} · ${guide.selectedCondition}` : valuation?.source ?? "No priced source");
  const hasDetails = Boolean(item.freeComps?.length || item.compSearchAttempts?.length || valuation || item.identity?.evidence?.length);

  return (
    <details className="historyDecision">
      <summary>Price sources &amp; decision</summary>
      {hasDetails ? (
        <div className="historyDecisionBody">
          <section>
            <strong>Decision</strong>
            {referencePrice !== undefined ? <p>Reference: {formatPrice(referencePrice)} from {referenceSource}{latestSale?.soldDate ? ` (${latestSale.soldDate})` : ""}.</p> : <p>No usable price source was found.</p>}
            {valuation && valuation.source !== "none" ? (
              <p>
                {item.maxBidPercent !== undefined && referencePrice !== undefined
                  ? `${formatPrice(referencePrice)} × ${item.maxBidPercent}% = ${formatPrice(valuation.maxBid)} suggested max bid.`
                  : `Recorded suggested max bid: ${formatPrice(valuation.maxBid)}.`}
              </p>
            ) : null}
            {valuation?.reasons.map((reason, index) => <p key={`reason-${index}`}>Reason: {reason}</p>)}
            {valuation?.warnings.map((warning, index) => <p key={`warning-${index}`}>Caution: {warning}</p>)}
          </section>

          {item.compSearchAttempts?.length ? (
            <section>
              <strong>Search attempts</strong>
              {item.compSearchAttempts.map((attempt, index) => (
                <p key={`${attempt.source}-${attempt.query}-${index}`}>
                  {attempt.source} · “{attempt.query}” · {attempt.status} · {attempt.count} results — {attempt.message}
                </p>
              ))}
            </section>
          ) : null}

          {item.freeComps?.length ? (
            <section>
              <strong>Sales used for comparison</strong>
              {item.freeComps.map((comp, index) => (
                <a className="historySale" href={comp.url} key={`${comp.url}-${index}`} rel="noreferrer" target="_blank">
                  <span>{formatPrice(comp.price)} · {comp.source}{comp.soldDate ? ` · ${comp.soldDate}` : ""}{comp.verified ? " · Verified" : ""}</span>
                  <small>{comp.title}</small>
                </a>
              ))}
            </section>
          ) : null}

          {item.identity?.evidence?.length ? <section><strong>Card identity evidence</strong>{item.identity.evidence.map((entry, index) => <p key={`evidence-${index}`}>{entry}</p>)}</section> : null}
          {item.compLinks.length ? (
            <div className="miniLinks">
              {item.compLinks.map((link) => <a href={link.url} key={link.url} rel="noreferrer" target="_blank">{link.source}</a>)}
            </div>
          ) : null}
        </div>
      ) : <p>No pricing decision details were saved for this scan.</p>}
    </details>
  );
}

function DiagnosticsPanel({
  entries,
  copied,
  onCopy,
  onDownload,
  onClear
}: {
  entries: DiagnosticEntry[];
  copied: boolean;
  onCopy: () => void;
  onDownload: () => void;
  onClear: () => Promise<void>;
}): JSX.Element {
  return (
    <section className="diagnosticsPanel">
      <div className="sectionHeader">
        <div>
          <h2>Diagnostics</h2>
          <p>{entries.length} recent local events · keys and images are excluded</p>
        </div>
        <div className="diagnosticsActions">
          <button className="iconButton" type="button" title="Copy diagnostics" aria-label="Copy diagnostics" onClick={onCopy} disabled={!entries.length}>
            <Copy size={15} />
          </button>
          <button className="iconButton" type="button" title="Download diagnostics" aria-label="Download diagnostics" onClick={onDownload} disabled={!entries.length}>
            <Download size={15} />
          </button>
          <button className="iconButton" type="button" title="Clear diagnostics" aria-label="Clear diagnostics" onClick={() => onClear().catch(() => undefined)} disabled={!entries.length}>
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      {copied ? <small className="diagnosticsCopied">Copied. The log contains no API key or image data.</small> : null}
      {entries.length ? (
        <ol className="diagnosticsList">
          {[...entries].reverse().slice(0, 40).map((entry, index) => (
            <li key={`${entry.timestamp}-${entry.event}-${index}`}>
              <time dateTime={new Date(entry.timestamp).toISOString()}>{formatHistoryTime(entry.timestamp)}</time>
              <strong>{entry.event}</strong>
              {entry.details && Object.keys(entry.details).length ? <code>{JSON.stringify(entry.details)}</code> : null}
            </li>
          ))}
        </ol>
      ) : <p className="empty">No diagnostics recorded yet. Start scanning to capture the pipeline steps.</p>}
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

function FreeCompsPanel({ comps }: { comps: NonNullable<TrackedCard["freeComps"]> }): JSX.Element {
  return (
    <div className="freeComps">
      <h3>Recent Sales</h3>
      {comps.slice(0, 5).map((comp) => (
        <a href={comp.url} key={`${comp.title}-${comp.price}-${comp.url}`} rel="noreferrer" target="_blank">
          <strong>{formatPrice(comp.price)}</strong>
          <span>{comp.title}</span>
          {comp.soldDate || comp.verified ? <small>{[comp.soldDate, comp.verified ? "Card Ladder verified" : undefined].filter(Boolean).join(" · ")}</small> : null}
        </a>
      ))}
    </div>
  );
}

function IdentityFacts({ identity }: { identity: CardIdentity }): JSX.Element {
  const facts = [
    ["Player", identity.player],
    ["Card type", identity.cardType],
    ["Brand", identity.brand],
    ["Year", identity.year],
    ["Set", identity.set],
    ["Number", identity.cardNumber],
    ["Parallel", identity.parallel],
    ["Numbered", identity.numbered === undefined ? "Unclear" : identity.numbered ? identity.serialNumber || "Yes" : "No"],
    ["Autograph", identity.autograph === undefined ? "Unclear" : identity.autograph ? "Yes" : "No"],
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
        <span className="helper">
          {draft.provider.provider === "mock"
            ? "Page text only; it cannot identify cards from video or reliably find comps. Choose a vision provider and add its API key to identify cards and search comps."
            : preset.help}
        </span>
      </label>
      <label>
        Price guide proxy
        <input
          value={draft.priceGuideProxyUrl}
          onChange={(event) => setDraft({ ...draft, priceGuideProxyUrl: event.target.value })}
          placeholder="http://127.0.0.1:8787/v1/price-guide/lookup"
        />
        <span className="helper">Leave blank for free manual comp mode. Add a proxy URL only for optional paid/source-backed pricing.</span>
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
      <label>
        Suggested max bid: {draft.maxBidPercent}% of the reference price
        <input
          type="range"
          min={10}
          max={100}
          step={1}
          value={draft.maxBidPercent}
          onChange={(event) => setDraft({ ...draft, maxBidPercent: Number(event.target.value) })}
        />
        <span className="helper">Uses the latest sold comp when available, otherwise the configured price guide or provisional estimate.</span>
      </label>
      <label className="checkRow">
        <input type="checkbox" checked={draft.autoScan} onChange={(event) => setDraft({ ...draft, autoScan: event.target.checked })} />
        Auto scan cards and request AI identification
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
