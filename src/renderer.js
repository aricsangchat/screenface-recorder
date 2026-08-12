const els = {
  previewCanvas: document.getElementById("previewCanvas"),
  screenVideo: document.getElementById("screenVideo"),
  cameraVideo: document.getElementById("cameraVideo"),

  permissionsList: document.getElementById("permissionsList"),
  refreshPermissionsBtn: document.getElementById("refreshPermissionsBtn"),
  requestCameraBtn: document.getElementById("requestCameraBtn"),
  requestMicBtn: document.getElementById("requestMicBtn"),
  openScreenSettingsBtn: document.getElementById("openScreenSettingsBtn"),

  cameraSelect: document.getElementById("cameraSelect"),
  micSelect: document.getElementById("micSelect"),
  enableCameraBtn: document.getElementById("enableCameraBtn"),

  chooseSourceBtn: document.getElementById("chooseSourceBtn"),
  refreshSourcesBtn: document.getElementById("refreshSourcesBtn"),
  selectedSourceText: document.getElementById("selectedSourceText"),

  aspectRatioSelect: document.getElementById("aspectRatioSelect"),
  cameraShapeSelect: document.getElementById("cameraShapeSelect"),
  overlayPositionSelect: document.getElementById("overlayPositionSelect"),
  screenFitModeSelect: document.getElementById("screenFitModeSelect"),
  screenCropAnchorSelect: document.getElementById("screenCropAnchorSelect"),
  cameraSizeRange: document.getElementById("cameraSizeRange"),

  startRecordingBtn: document.getElementById("startRecordingBtn"),
  stopRecordingBtn: document.getElementById("stopRecordingBtn"),
  statusText: document.getElementById("statusText"),
  savePathText: document.getElementById("savePathText"),
  micTesterStatus: document.getElementById("micTesterStatus"),
  micTesterLevel: document.getElementById("micTesterLevel"),
  recordingAudioStatus: document.getElementById("recordingAudioStatus"),

  sourceModal: document.getElementById("sourceModal"),
  closeSourceModalBtn: document.getElementById("closeSourceModalBtn"),
  sourcesGrid: document.getElementById("sourcesGrid"),
  tabButtons: Array.from(document.querySelectorAll(".tab-btn")),
};

const state = {
  screenStream: null,
  cameraStream: null,
  micStream: null,
  composedStream: null,
  mediaRecorder: null,
  selectedSourceId: null,
  selectedSourceName: null,
  allSources: [],
  sourceFilter: "all",
  recording: false,
  stopping: false,
  finalizing: false,
  finalOutputPath: null,
  stopReason: null,
  pendingChunkWrites: 0,
  chunkWriteInProgress: false,
  chunkWriteQueue: [],
  chunkCount: 0,
  chunkBytesTotal: 0,
  recordingStartedAt: 0,
  recoveringScreen: false,
  overlayDrag: {
    active: false,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
  },
  layout: {
    aspectRatio: "16:9",
    cameraShape: "circle",
    overlayPosition: "bottom-left",
    cameraSizePercent: 24,
    screenFitMode: "blur",
    screenCropAnchor: "center",
    overlayX: 0.04,
    overlayY: 0.72,
  },
};

const previewCtx = els.previewCanvas.getContext("2d", { alpha: false });
const recordCanvas = document.createElement("canvas");
const recordCtx = recordCanvas.getContext("2d", { alpha: false });
const RECORDING_TIMESLICE_MS = 5000;

let drawLoopHandle = null;
let micAudioContext = null;
let micAnalyser = null;
let micAnalyserData = null;
let micAnalyserSource = null;
let recordingHealthLogTimer = null;

function setStatus(text) {
  els.statusText.textContent = text;
  console.log("[ScreenFace]", text);
}

function getTrackSnapshot(track) {
  if (!track) return null;

  return {
    kind: track.kind,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings:
      typeof track.getSettings === "function" ? track.getSettings() : null,
  };
}

function logDiag(eventName, details = {}) {
  const screenTrack = state.screenStream?.getVideoTracks()?.[0] || null;
  const micTrack = state.micStream?.getAudioTracks()?.[0] || null;

  const payload = {
    ts: new Date().toISOString(),
    event: eventName,
    recording: state.recording,
    stopping: state.stopping,
    finalizing: state.finalizing,
    selectedSourceId: state.selectedSourceId,
    selectedSourceName: state.selectedSourceName,
    recorderState: state.mediaRecorder?.state || "none",
    pendingChunkWrites: state.pendingChunkWrites,
    queuedChunks: state.chunkWriteQueue.length,
    chunkWriteInProgress: state.chunkWriteInProgress,
    chunkCount: state.chunkCount,
    chunkBytesTotal: state.chunkBytesTotal,
    screenTrack: getTrackSnapshot(screenTrack),
    micTrack: getTrackSnapshot(micTrack),
    ...details,
  };

  console.log(`[ScreenFace][diag] ${JSON.stringify(payload)}`);
}

function startRecordingHealthLogs() {
  if (recordingHealthLogTimer) {
    clearInterval(recordingHealthLogTimer);
  }

  recordingHealthLogTimer = setInterval(() => {
    logDiag("recording-health");
  }, 15000);
}

function stopRecordingHealthLogs() {
  if (!recordingHealthLogTimer) return;
  clearInterval(recordingHealthLogTimer);
  recordingHealthLogTimer = null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getAspectDimensions(aspect) {
  if (aspect === "9:16") return { width: 1080, height: 1920 };
  if (aspect === "1:1") return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

function getPreviewDimensions(aspect) {
  if (aspect === "9:16") return { width: 405, height: 720 };
  if (aspect === "1:1") return { width: 720, height: 720 };
  return { width: 960, height: 540 };
}

function updateCanvasSizes() {
  const preview = getPreviewDimensions(state.layout.aspectRatio);
  els.previewCanvas.width = preview.width;
  els.previewCanvas.height = preview.height;

  const record = getAspectDimensions(state.layout.aspectRatio);
  recordCanvas.width = record.width;
  recordCanvas.height = record.height;

  // Do NOT force both CSS width and height. That can visually stretch preview.
  els.previewCanvas.style.width = `${preview.width}px`;
  els.previewCanvas.style.height = "auto";
  els.previewCanvas.style.aspectRatio = `${preview.width} / ${preview.height}`;
}

function permissionBadgeClass(status) {
  if (status === "granted") return "granted";
  if (status === "denied") return "denied";
  if (status === "restricted") return "restricted";
  if (status === "not-determined") return "not-determined";
  return "unknown";
}

async function refreshPermissions() {
  const status = await window.electronAPI.getPermissionStatus();

  els.permissionsList.innerHTML = [
    ["Camera", status.camera],
    ["Microphone", status.microphone],
    ["Screen", status.screen],
  ]
    .map(
      ([label, value]) => `
        <div class="permission-item">
          <span>${label}</span>
          <span class="permission-badge ${permissionBadgeClass(value)}">${escapeHtml(value)}</span>
        </div>
      `
    )
    .join("");
}

async function requestCameraPermission() {
  await window.electronAPI.requestCameraPermission();
  await refreshPermissions();
}

async function requestMicrophonePermission() {
  await window.electronAPI.requestMicrophonePermission();
  await refreshPermissions();
}

async function enumerateDevices() {
  let tempStream = null;

  try {
    tempStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
  } catch (_error) {
  } finally {
    if (tempStream) {
      tempStream.getTracks().forEach((track) => track.stop());
    }
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter((d) => d.kind === "videoinput");
  const audioDevices = devices.filter((d) => d.kind === "audioinput");

  els.cameraSelect.innerHTML = videoDevices
    .map(
      (d, index) =>
        `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(
          d.label || `Camera ${index + 1}`
        )}</option>`
    )
    .join("");

  els.micSelect.innerHTML = audioDevices
    .map(
      (d, index) =>
        `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(
          d.label || `Microphone ${index + 1}`
        )}</option>`
    )
    .join("");
}

async function enableCameraAndMic() {
  try {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((track) => track.stop());
      state.cameraStream = null;
    }

    if (state.micStream) {
      state.micStream.getTracks().forEach((track) => track.stop());
      state.micStream = null;
    }

    teardownMicMonitor();

    const videoDeviceId = els.cameraSelect.value;
    const audioDeviceId = els.micSelect.value;

    if (!videoDeviceId && !audioDeviceId) {
      setStatus("No camera or mic selected.");
      return;
    }

    if (videoDeviceId) {
      state.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: videoDeviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 24, max: 30 },
        },
        audio: false,
      });

      els.cameraVideo.srcObject = state.cameraStream;
      await els.cameraVideo.play().catch(() => {});
    }

    if (audioDeviceId) {
      state.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: audioDeviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      setupMicMonitor(state.micStream);
    }

    setStatus("Camera / mic ready.");
  } catch (error) {
    console.error(error);
    setStatus(`Camera/mic failed: ${error?.message || "unknown error"}`);
  }
}

function setBadgeStatus(el, text, tone = "") {
  if (!el) return;
  el.textContent = text;
  el.classList.remove("good", "warn", "bad");
  if (tone) {
    el.classList.add(tone);
  }
}

function teardownMicMonitor() {
  if (micAnalyserSource) {
    try {
      micAnalyserSource.disconnect();
    } catch (_error) {}
  }

  if (micAudioContext) {
    try {
      micAudioContext.close();
    } catch (_error) {}
  }

  micAudioContext = null;
  micAnalyser = null;
  micAnalyserData = null;
  micAnalyserSource = null;
}

function setupMicMonitor(stream) {
  teardownMicMonitor();

  if (!stream || stream.getAudioTracks().length === 0) return;

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    micAudioContext = new AudioCtx();
    micAnalyser = micAudioContext.createAnalyser();
    micAnalyser.fftSize = 1024;
    micAnalyser.smoothingTimeConstant = 0.8;
    micAnalyserData = new Uint8Array(micAnalyser.fftSize);
    micAnalyserSource = micAudioContext.createMediaStreamSource(stream);
    micAnalyserSource.connect(micAnalyser);
  } catch (error) {
    console.warn("[ScreenFace] mic monitor setup failed", error);
    teardownMicMonitor();
  }
}

function getMicLevelRms() {
  if (!micAnalyser || !micAnalyserData) return 0;

  micAnalyser.getByteTimeDomainData(micAnalyserData);

  let sumSquares = 0;
  for (let i = 0; i < micAnalyserData.length; i += 1) {
    const centered = (micAnalyserData[i] - 128) / 128;
    sumSquares += centered * centered;
  }

  return Math.sqrt(sumSquares / micAnalyserData.length);
}

function updateAudioTesterUI() {
  const micTrack = state.micStream?.getAudioTracks()?.[0] || null;
  const micLive = Boolean(micTrack && micTrack.readyState === "live" && micTrack.enabled);
  const micLevel = micLive ? getMicLevelRms() : 0;
  const micPercent = Math.max(0, Math.min(100, Math.round(micLevel * 320)));

  if (els.micTesterLevel) {
    els.micTesterLevel.style.width = `${micPercent}%`;
  }

  if (!micLive) {
    setBadgeStatus(els.micTesterStatus, "Off", "bad");
  } else if (micPercent > 18) {
    setBadgeStatus(els.micTesterStatus, "Detecting", "good");
  } else if (micPercent > 6) {
    setBadgeStatus(els.micTesterStatus, "Low", "warn");
  } else {
    setBadgeStatus(els.micTesterStatus, "Silent", "bad");
  }

  const hasRecordingAudioTrack =
    state.recording &&
    state.composedStream &&
    state.composedStream
      .getAudioTracks()
      .some((track) => track.readyState === "live" && track.enabled);

  if (!state.recording) {
    setBadgeStatus(els.recordingAudioStatus, "Idle", "");
  } else if (hasRecordingAudioTrack) {
    setBadgeStatus(els.recordingAudioStatus, "Active", "good");
  } else {
    setBadgeStatus(els.recordingAudioStatus, "Missing", "bad");
  }
}

async function loadSources() {
  try {
    setStatus("Loading sources...");
    state.allSources = await window.electronAPI.listDesktopSources();
    renderSourceCards();
    setStatus("Sources loaded.");
  } catch (error) {
    console.error(error);
    setStatus(`Could not load sources: ${error?.message || "unknown error"}`);
  }
}

function renderSourceCards() {
  const sources = state.allSources.filter((source) => {
    if (state.sourceFilter === "all") return true;
    return source.kind === state.sourceFilter;
  });

  els.sourcesGrid.innerHTML = sources
    .map((source) => {
      const kindLabel = source.kind === "screen" ? "Screen" : "Window";
      const preview =
        typeof source.thumbnailDataUrl === "string" &&
        source.thumbnailDataUrl.length > 5
          ? `<img class="source-preview" src="${source.thumbnailDataUrl}" alt="${escapeHtml(
              source.name
            )} preview" loading="lazy" />`
          : `<div class="source-preview source-preview-empty">${kindLabel}</div>`;

      const icon =
        typeof source.appIconDataUrl === "string" &&
        source.appIconDataUrl.length > 5
          ? `<img class="source-app-icon" src="${source.appIconDataUrl}" alt="" />`
          : `<div class="source-app-icon-fallback">${kindLabel[0]}</div>`;

      return `
        <button class="source-card" data-source-id="${escapeHtml(source.id)}">
          ${preview}
          <div class="source-meta">
            ${icon}
            <div class="source-title-wrap">
              <div class="source-title">${escapeHtml(source.name)}</div>
              <div class="source-kind">${kindLabel}</div>
            </div>
          </div>
        </button>
      `;
    })
    .join("");

  Array.from(els.sourcesGrid.querySelectorAll(".source-card")).forEach((btn) => {
    btn.addEventListener("click", () => {
      const sourceId = btn.dataset.sourceId;
      const source = state.allSources.find((s) => s.id === sourceId);
      if (!source) return;
      chooseSource(source);
    });
  });
}

function openSourceModal() {
  els.sourceModal.classList.remove("hidden");
}

function closeSourceModal() {
  els.sourceModal.classList.add("hidden");
}

async function chooseSource(source) {
  try {
    if (state.screenStream) {
      state.screenStream.getTracks().forEach((track) => track.stop());
      state.screenStream = null;
    }

    state.selectedSourceId = source.id;
    state.selectedSourceName = source.name;
    els.selectedSourceText.textContent = source.name;
    logDiag("choose-source", { sourceId: source.id, sourceName: source.name });

    const selectResult = await window.electronAPI.selectDesktopSource({
      sourceId: source.id,
    });

    if (!selectResult?.ok) {
      throw new Error("Could not select desktop source.");
    }

    const stream = await getSelectedDisplayMediaStream();
    await attachScreenStream(stream);

    closeSourceModal();
    setStatus(`Selected source: ${source.name}`);
  } catch (error) {
    console.error(error);
    setStatus(`Source selection failed: ${error?.message || "unknown error"}`);
  }
}

async function getSelectedDisplayMediaStream() {
  // Capture the real native screen/window shape.
  // Do not force 1920x1080 here — that can crop/scale the source before we draw it.
  return navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: {
      frameRate: {
        ideal: 30,
        max: 30,
      },
    },
  });
}

async function recoverScreenDuringRecording() {
  const recorderIsActive =
    state.mediaRecorder && state.mediaRecorder.state !== "inactive";

  if (
    !state.recording ||
    state.stopping ||
    state.finalizing ||
    !recorderIsActive ||
    state.recoveringScreen ||
    !state.selectedSourceId
  ) {
    return;
  }

  state.recoveringScreen = true;
  setStatus("Screen capture interrupted. Attempting to recover...");
  logDiag("screen-recover-start");

  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const selectResult = await window.electronAPI.selectDesktopSource({
          sourceId: state.selectedSourceId,
        });

        if (!selectResult?.ok) {
          throw new Error("Could not re-select desktop source.");
        }

        const stream = await getSelectedDisplayMediaStream();
        await attachScreenStream(stream);
        logDiag("screen-recover-success", { attempt });
        setStatus("Screen capture recovered. Recording continues.");
        return;
      } catch (error) {
        logDiag("screen-recover-attempt-failed", {
          attempt,
          message: error?.message || "unknown",
        });

        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    state.stopReason = "Screen capture ended and recovery failed.";
    stopRecording("Screen capture ended and recovery failed.");
  } finally {
    state.recoveringScreen = false;
  }
}

async function attachScreenStream(stream) {
  state.screenStream = stream;
  els.screenVideo.srcObject = stream;
  await els.screenVideo.play().catch(() => {});

  await new Promise((resolve) => {
    if (els.screenVideo.videoWidth && els.screenVideo.videoHeight) return resolve();
    els.screenVideo.onloadedmetadata = () => resolve();
    setTimeout(resolve, 500);
  });

  console.log(
    "[ScreenFace][screen-video-size]",
    JSON.stringify({
      videoWidth: els.screenVideo.videoWidth,
      videoHeight: els.screenVideo.videoHeight,
      ratio: els.screenVideo.videoWidth / Math.max(1, els.screenVideo.videoHeight),
    })
  );

  const [videoTrack] = stream.getVideoTracks();
  if (videoTrack) {
    logDiag("screen-track-selected", {
      track: getTrackSnapshot(videoTrack),
    });

    videoTrack.addEventListener("mute", () => {
      logDiag("screen-track-muted", {
        track: getTrackSnapshot(videoTrack),
      });
    });

    videoTrack.addEventListener("unmute", () => {
      logDiag("screen-track-unmuted", {
        track: getTrackSnapshot(videoTrack),
      });
    });

    videoTrack.addEventListener("ended", () => {
      logDiag("screen-track-ended", {
        track: getTrackSnapshot(videoTrack),
      });
      state.screenStream = null;
      els.selectedSourceText.textContent = "Screen sharing interrupted";

      if (
        state.recording &&
        !state.stopping &&
        !state.finalizing &&
        state.mediaRecorder &&
        state.mediaRecorder.state !== "inactive"
      ) {
        void recoverScreenDuringRecording();
      } else {
        setStatus("Screen/window capture ended.");
      }
    });
  }

  stream.addEventListener("inactive", () => {
    logDiag("screen-stream-inactive");
  });
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawCoverVideo(ctx, video, x, y, width, height, options = {}) {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const sourceRatio = vw / vh;
  const targetRatio = width / height;

  let sx = 0;
  let sy = 0;
  let sWidth = vw;
  let sHeight = vh;

  if (sourceRatio > targetRatio) {
    sWidth = vh * targetRatio;
    const leftover = vw - sWidth;
    const anchor = options.horizontalAnchor || "center";

    if (anchor === "left") sx = 0;
    else if (anchor === "right") sx = leftover;
    else sx = leftover / 2;
  } else {
    sHeight = vw / targetRatio;
    sy = (vh - sHeight) / 2;
  }

  ctx.drawImage(video, sx, sy, sWidth, sHeight, x, y, width, height);
}

function drawContainVideo(ctx, video, x, y, width, height) {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const scale = Math.min(width / vw, height / vh);
  const drawWidth = Math.round(vw * scale);
  const drawHeight = Math.round(vh * scale);
  const drawX = Math.round(x + (width - drawWidth) / 2);
  const drawY = Math.round(y + (height - drawHeight) / 2);

  ctx.drawImage(video, 0, 0, vw, vh, drawX, drawY, drawWidth, drawHeight);
}

// A full-resolution ctx.filter="blur(34px)" costs several ms per frame at
// 1920x1080 and starves the recorder. Blur a downscaled copy instead and
// upscale it — visually equivalent, an order of magnitude cheaper.
const blurCanvas = document.createElement("canvas");
const blurCtx = blurCanvas.getContext("2d", { alpha: false });
const BLUR_SCALE = 0.125;

function drawBlurFillVideo(ctx, video, x, y, width, height, options = {}) {
  const bw = Math.max(1, Math.round(width * BLUR_SCALE));
  const bh = Math.max(1, Math.round(height * BLUR_SCALE));

  if (blurCanvas.width !== bw || blurCanvas.height !== bh) {
    blurCanvas.width = bw;
    blurCanvas.height = bh;
  }

  blurCtx.save();
  blurCtx.filter = `blur(${Math.max(2, Math.round(34 * BLUR_SCALE))}px) brightness(0.62) saturate(1.2)`;
  drawCoverVideo(blurCtx, video, -10, -10, bw + 20, bh + 20, options);
  blurCtx.restore();

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(blurCanvas, 0, 0, bw, bh, x, y, width, height);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = "rgba(5, 11, 20, 0.22)";
  ctx.fillRect(x, y, width, height);
  ctx.restore();

  // Foreground: actual screen, never stretched
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const scale = Math.min(width / vw, height / vh);
  const drawWidth = Math.round(vw * scale);
  const drawHeight = Math.round(vh * scale);
  const drawX = Math.round(x + (width - drawWidth) / 2);
  const drawY = Math.round(y + (height - drawHeight) / 2);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = Math.round(width * 0.018);
  ctx.shadowOffsetY = Math.round(height * 0.008);
  ctx.drawImage(video, 0, 0, vw, vh, drawX, drawY, drawWidth, drawHeight);
  ctx.restore();

  ctx.save();
  ctx.lineWidth = Math.max(2, Math.round(width * 0.002));
  ctx.strokeStyle = "rgba(255,255,255,0.32)";
  ctx.strokeRect(drawX, drawY, drawWidth, drawHeight);
  ctx.restore();
}

function drawScreenVideo(ctx, video, x, y, width, height) {
  const options = { horizontalAnchor: state.layout.screenCropAnchor };

  // Wide exports should never distort the source.
  // Blur and contain both draw the full screen/window with original proportions.
  if (state.layout.aspectRatio === "16:9") {
    if (state.layout.screenFitMode === "cover") {
      drawCoverVideo(ctx, video, x, y, width, height, options);
      return;
    }

    if (state.layout.screenFitMode === "blur") {
      drawBlurFillVideo(ctx, video, x, y, width, height, options);
      return;
    }

    drawContainVideo(ctx, video, x, y, width, height);
    return;
  }

  if (state.layout.screenFitMode === "contain") {
    drawContainVideo(ctx, video, x, y, width, height);
    return;
  }

  if (state.layout.screenFitMode === "blur") {
    drawBlurFillVideo(ctx, video, x, y, width, height, options);
    return;
  }

  drawCoverVideo(ctx, video, x, y, width, height, options);
}

function getOverlayRect(canvasWidth, canvasHeight) {
  const sizeFactor = state.layout.cameraSizePercent / 100;
  const position = state.layout.overlayPosition;

  if (position === "vertical-stack" && state.layout.aspectRatio === "9:16") {
    return {
      x: 0,
      y: Math.round(canvasHeight * 0.73),
      width: canvasWidth,
      height: canvasHeight - Math.round(canvasHeight * 0.73),
    };
  }

  const baseWidth =
    state.layout.aspectRatio === "9:16"
      ? Math.round(canvasWidth * 0.82)
      : Math.round(canvasWidth * sizeFactor);

  const width =
    state.layout.cameraShape === "rectangle"
      ? baseWidth
      : Math.round(Math.min(baseWidth, canvasHeight * 0.34));

  const height =
    state.layout.cameraShape === "rectangle"
      ? Math.round(width * 0.62)
      : width;

  const padding = Math.round(canvasWidth * 0.03);

  let x = padding;
  let y = canvasHeight - height - padding;

  if (position === "bottom-right") {
    x = canvasWidth - width - padding;
    y = canvasHeight - height - padding;
  } else if (position === "top-right") {
    x = canvasWidth - width - padding;
    y = padding;
  } else if (position === "top-left") {
    x = padding;
    y = padding;
  } else if (position === "bottom-left") {
    x = padding;
    y = canvasHeight - height - padding;
  } else {
    x = Math.round(state.layout.overlayX * canvasWidth);
    y = Math.round(state.layout.overlayY * canvasHeight);
  }

  return { x, y, width, height };
}

function drawFrame(ctx, canvas) {
  const { width, height } = canvas;

  ctx.fillStyle = "#050b14";
  ctx.fillRect(0, 0, width, height);

  const hasScreen =
    state.screenStream &&
    els.screenVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  const hasCamera =
    state.cameraStream &&
    els.cameraVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;

  if (state.layout.aspectRatio === "9:16" && state.layout.overlayPosition === "vertical-stack") {
    const topHeight = Math.round(height * 0.73);

    if (hasScreen) {
        drawScreenVideo(ctx, els.screenVideo, 0, 0, width, topHeight);
    } else {
      ctx.fillStyle = "#0d1829";
      ctx.fillRect(0, 0, width, topHeight);
      ctx.fillStyle = "#9bb0cf";
      ctx.font = `${Math.round(width * 0.035)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("No screen selected", width / 2, topHeight / 2);
    }

    if (hasCamera) {
      drawCoverVideo(ctx, els.cameraVideo, 0, topHeight, width, height - topHeight);
    } else {
      ctx.fillStyle = "#101b2d";
      ctx.fillRect(0, topHeight, width, height - topHeight);
      ctx.fillStyle = "#9bb0cf";
      ctx.font = `${Math.round(width * 0.03)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("No camera enabled", width / 2, topHeight + (height - topHeight) / 2);
    }

    return;
  }

  if (hasScreen) {
    drawScreenVideo(ctx, els.screenVideo, 0, 0, width, height);
  } else {
    ctx.fillStyle = "#0d1829";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#9bb0cf";
    ctx.font = `${Math.round(width * 0.03)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("Choose a screen or window", width / 2, height / 2);
  }

  if (!hasCamera) return;

  const rect = getOverlayRect(width, height);

  ctx.save();

  if (state.layout.cameraShape === "circle") {
    ctx.beginPath();
    ctx.arc(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
      rect.width / 2,
      0,
      Math.PI * 2
    );
    ctx.closePath();
    ctx.clip();
  } else if (state.layout.cameraShape === "square") {
    roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 28);
    ctx.clip();
  } else {
    roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 24);
    ctx.clip();
  }

  drawCoverVideo(ctx, els.cameraVideo, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();

  ctx.save();
  ctx.lineWidth = Math.max(4, Math.round(width * 0.004));
  ctx.strokeStyle = "rgba(255,255,255,0.9)";

  if (state.layout.cameraShape === "circle") {
    ctx.beginPath();
    ctx.arc(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
      rect.width / 2,
      0,
      Math.PI * 2
    );
    ctx.stroke();
  } else if (state.layout.cameraShape === "square") {
    roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 28);
    ctx.stroke();
  } else {
    roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 24);
    ctx.stroke();
  }

  ctx.restore();
}

const TARGET_FRAME_MS = 1000 / 30;
let lastRecordDrawAt = 0;
let drawWatchdogHandle = null;

// requestAnimationFrame stops firing when the window is hidden, minimized, or
// fully covered. If the record canvas stops being redrawn, its captureStream
// keeps emitting the same frame and the recording looks frozen. So rAF is only
// the fast path — a timer watchdog keeps painting when rAF goes quiet.
function renderTick() {
  const now = performance.now();
  if (now - lastRecordDrawAt < TARGET_FRAME_MS - 1) return;
  lastRecordDrawAt = now;

  drawFrame(recordCtx, recordCanvas);

  if (document.visibilityState === "visible") {
    drawFrame(previewCtx, els.previewCanvas);
    updateAudioTesterUI();
  }
}

function startDrawLoop() {
  if (drawLoopHandle) cancelAnimationFrame(drawLoopHandle);
  if (drawWatchdogHandle) clearInterval(drawWatchdogHandle);

  const loop = () => {
    renderTick();
    drawLoopHandle = requestAnimationFrame(loop);
  };

  loop();

  drawWatchdogHandle = setInterval(() => {
    if (performance.now() - lastRecordDrawAt >= TARGET_FRAME_MS) {
      renderTick();
    }
  }, TARGET_FRAME_MS);
}

function buildComposedStream() {
  if (state.composedStream) {
    state.composedStream.getTracks().forEach((track) => track.stop());
    state.composedStream = null;
  }

  const canvasStream = recordCanvas.captureStream(30);
  const tracks = [...canvasStream.getVideoTracks()];

  if (state.micStream) {
    tracks.push(...state.micStream.getAudioTracks());
  }

  state.composedStream = new MediaStream(tracks);
  return state.composedStream;
}

function queueRecordingChunk(chunk) {
  state.chunkWriteQueue.push(chunk);
}

async function flushRecordingChunkQueue() {
  if (state.chunkWriteInProgress) return;

  state.chunkWriteInProgress = true;

  try {
    while (state.chunkWriteQueue.length > 0) {
      const chunk = state.chunkWriteQueue.shift();
      if (!chunk) continue;

      try {
        const result = await window.electronAPI.appendRecordingChunk({ chunk });

        if (!result.ok) {
          const message = result.error || "unknown error";

          if (message.includes("No active recording file") && (state.stopping || state.finalizing)) {
            console.warn("[ScreenFace] ignoring late chunk after stop");
            return;
          }

          console.error("[ScreenFace] chunk append failed:", message);
          state.stopReason = `Disk write failed: ${message}`;

          if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
            state.mediaRecorder.stop();
          }

          return;
        }
      } catch (error) {
        if (state.stopping || state.finalizing) {
          console.warn("[ScreenFace] ignoring chunk pipeline error during stop/finalize", error);
          return;
        }

        console.error("[ScreenFace] chunk pipeline failed:", error);
        state.stopReason = `Chunk pipeline failed: ${error?.message || "unknown error"}`;

        if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
          state.mediaRecorder.stop();
        }

        return;
      } finally {
        state.pendingChunkWrites = Math.max(0, state.pendingChunkWrites - 1);
      }
    }
  } finally {
    state.chunkWriteInProgress = false;
  }
}

function getRecorderMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];

  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
  }

  return "";
}

function buildDefaultFileName() {
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  return `screenface-recording-${stamp}.mp4`;
}

async function startRecording() {
  if (!state.screenStream) {
    setStatus("Choose a screen or window first.");
    return;
  }

  if (state.recording) return;

  try {
    state.stopReason = null;
    state.stopping = false;
    state.finalizing = false;
    state.pendingChunkWrites = 0;
    state.chunkWriteInProgress = false;
    state.chunkWriteQueue = [];
    state.chunkCount = 0;
    state.chunkBytesTotal = 0;
    state.recordingStartedAt = Date.now();

    const saveResult = await window.electronAPI.beginRecordingSave({
      defaultFileName: buildDefaultFileName(),
    });

    if (!saveResult.ok) {
      if (saveResult.canceled) {
        setStatus("Save canceled.");
        return;
      }
      throw new Error(saveResult.error || "Could not prepare save file.");
    }

    state.finalOutputPath = saveResult.finalMp4Path;
    els.savePathText.textContent = saveResult.finalMp4Path;

    const stream = buildComposedStream();
    const mimeType = getRecorderMimeType();
    const recorderOptions = mimeType ? { mimeType } : undefined;

    console.log("[ScreenFace] starting recorder with mimeType:", mimeType || "(default)");

    state.mediaRecorder = new MediaRecorder(stream, recorderOptions);

    state.mediaRecorder.onstart = () => {
      console.log("[ScreenFace] recorder started");
      logDiag("recorder-started");
      startRecordingHealthLogs();
    };

    state.mediaRecorder.ondataavailable = async (event) => {
      if (!event.data || event.data.size === 0) return;

      // Ignore late chunks after finalize has begun.
      if (state.finalizing) {
        console.log("[ScreenFace] ignoring late chunk during finalizing");
        return;
      }

      state.pendingChunkWrites += 1;

      try {
        const arrayBuffer = await event.data.arrayBuffer();

        // Check again after async conversion, because stop may have happened meanwhile.
        if (state.finalizing) {
          console.log("[ScreenFace] ignoring late chunk after buffer conversion");
          state.pendingChunkWrites = Math.max(0, state.pendingChunkWrites - 1);
          logDiag("chunk-dropped-during-finalize");
          return;
        }

        const chunk = new Uint8Array(arrayBuffer);
        queueRecordingChunk(chunk);
        state.chunkCount += 1;
        state.chunkBytesTotal += chunk.byteLength;

        if (state.chunkCount % 6 === 0) {
          logDiag("chunk-progress", {
            latestChunkBytes: chunk.byteLength,
            elapsedMs: Date.now() - state.recordingStartedAt,
          });
        }

        void flushRecordingChunkQueue();
      } catch (error) {
        state.pendingChunkWrites = Math.max(0, state.pendingChunkWrites - 1);
        if (state.stopping || state.finalizing) {
          console.warn("[ScreenFace] ignoring chunk pipeline error during stop/finalize", error);
          logDiag("chunk-error-during-stop", { message: error?.message || "unknown" });
          return;
        }

        console.error("[ScreenFace] chunk pipeline failed:", error);
        logDiag("chunk-pipeline-failed", { message: error?.message || "unknown" });
        state.stopReason = `Chunk pipeline failed: ${error?.message || "unknown error"}`;

        if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
          state.mediaRecorder.stop();
        }
      }
    };

    state.mediaRecorder.onerror = async (event) => {
      const message =
        event?.error?.message ||
        event?.name ||
        "unknown MediaRecorder error";

      console.error("[ScreenFace] MediaRecorder error:", event);
      logDiag("recorder-error", {
        errorMessage: message,
      });
      state.stopReason = `Recorder error: ${message}`;
      setStatus(`Recording failed: ${message}`);

      await window.electronAPI.abortRecordingSave();
      cleanupRecordingState();
    };

    state.mediaRecorder.onstop = async () => {
      try {
        logDiag("recorder-stop-begin", { stopReason: state.stopReason });
        state.stopping = true;
        await flushRecordingChunkQueue();

        // Wait briefly for any in-flight chunk writes to finish.
        let guard = 0;
        while (
          (state.pendingChunkWrites > 0 ||
            state.chunkWriteInProgress ||
            state.chunkWriteQueue.length > 0) &&
          guard < 100
        ) {
          await flushRecordingChunkQueue();
          await new Promise((resolve) => setTimeout(resolve, 50));
          guard += 1;
        }

        state.finalizing = true;

        const reasonPrefix = state.stopReason ? `${state.stopReason} ` : "";
        setStatus(`${reasonPrefix}Finalizing MP4...`);

        const result = await window.electronAPI.finishRecordingSave();

        if (!result.ok) {
          const fallbackText = result.tempWebmPath
            ? ` Temp WebM kept at: ${result.tempWebmPath}`
            : "";
          throw new Error((result.error || "Finalize failed.") + fallbackText);
        }

        if (state.stopReason) {
          setStatus(`${state.stopReason} Saved MP4 successfully.`);
        } else {
          setStatus("Saved MP4 successfully.");
        }

        logDiag("recorder-stop-finished", {
          outputPath: result.filePath,
          elapsedMs: state.recordingStartedAt
            ? Date.now() - state.recordingStartedAt
            : null,
        });

        els.savePathText.textContent = result.filePath;
      } catch (error) {
        console.error(error);
        logDiag("recorder-stop-finalize-failed", {
          message: error?.message || "unknown",
        });
        setStatus(`Finalize failed: ${error?.message || "unknown error"}`);
      } finally {
        cleanupRecordingState();
      }
    };

    state.mediaRecorder.start(RECORDING_TIMESLICE_MS);
    state.recording = true;
    els.startRecordingBtn.disabled = true;
    els.stopRecordingBtn.disabled = false;
    setStatus("Recording...");
  } catch (error) {
    console.error(error);
    setStatus(`Could not start recording: ${error?.message || "unknown error"}`);
    await window.electronAPI.abortRecordingSave();
    cleanupRecordingState();
  }
}

async function stopRecording(reason = null) {
  if (!state.mediaRecorder || state.mediaRecorder.state === "inactive") return;

  if (reason) {
    state.stopReason = reason;
  }

  state.stopping = true;
  setStatus(reason ? `${reason} Stopping...` : "Stopping...");
  els.stopRecordingBtn.disabled = true;

  try {
    state.mediaRecorder.stop();
  } catch (error) {
    console.error(error);
    setStatus(`Stop failed: ${error?.message || "unknown error"}`);
    cleanupRecordingState();
  }
}

function cleanupRecordingState() {
  stopRecordingHealthLogs();
  state.recording = false;
  state.stopping = false;
  state.finalizing = false;
  state.pendingChunkWrites = 0;
  state.chunkWriteInProgress = false;
  state.chunkWriteQueue = [];
  state.chunkCount = 0;
  state.chunkBytesTotal = 0;
  state.recordingStartedAt = 0;

  if (state.composedStream) {
    state.composedStream.getTracks().forEach((track) => track.stop());
    state.composedStream = null;
  }

  state.mediaRecorder = null;
  els.startRecordingBtn.disabled = false;
  els.stopRecordingBtn.disabled = true;
}

function updateLayoutFromControls() {
  state.layout.aspectRatio = els.aspectRatioSelect.value;
  state.layout.cameraShape = els.cameraShapeSelect.value;
  state.layout.overlayPosition = els.overlayPositionSelect.value;
  state.layout.screenFitMode = els.screenFitModeSelect.value;
  state.layout.screenCropAnchor = els.screenCropAnchorSelect.value;
  state.layout.cameraSizePercent = Number(els.cameraSizeRange.value);

  if (state.layout.aspectRatio === "9:16" && state.layout.overlayPosition !== "vertical-stack") {
    state.layout.overlayPosition = "vertical-stack";
    els.overlayPositionSelect.value = "vertical-stack";
  }

  if (state.layout.aspectRatio !== "9:16" && state.layout.overlayPosition === "vertical-stack") {
    state.layout.overlayPosition = "bottom-left";
    els.overlayPositionSelect.value = "bottom-left";
  }

  if (state.layout.overlayPosition !== "vertical-stack") {
    if (state.layout.overlayPosition === "bottom-left") {
      state.layout.overlayX = 0.04;
      state.layout.overlayY = 0.72;
    } else if (state.layout.overlayPosition === "bottom-right") {
      state.layout.overlayX = 0.72;
      state.layout.overlayY = 0.72;
    } else if (state.layout.overlayPosition === "top-right") {
      state.layout.overlayX = 0.72;
      state.layout.overlayY = 0.04;
    } else if (state.layout.overlayPosition === "top-left") {
      state.layout.overlayX = 0.04;
      state.layout.overlayY = 0.04;
    }
  }

  updateCanvasSizes();
}

function handlePreviewPointerDown(event) {
  if (state.layout.overlayPosition === "vertical-stack") return;
  if (!state.cameraStream) return;

  const rect = els.previewCanvas.getBoundingClientRect();
  const scaleX = els.previewCanvas.width / rect.width;
  const scaleY = els.previewCanvas.height / rect.height;

  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;

  const overlay = getOverlayRect(els.previewCanvas.width, els.previewCanvas.height);

  const inside =
    x >= overlay.x &&
    x <= overlay.x + overlay.width &&
    y >= overlay.y &&
    y <= overlay.y + overlay.height;

  if (!inside) return;

  state.overlayDrag.active = true;
  state.overlayDrag.startX = x;
  state.overlayDrag.startY = y;
  state.overlayDrag.origX = state.layout.overlayX;
  state.overlayDrag.origY = state.layout.overlayY;

  els.previewCanvas.style.cursor = "grabbing";
}

function handlePreviewPointerMove(event) {
  if (!state.overlayDrag.active) return;

  const rect = els.previewCanvas.getBoundingClientRect();
  const scaleX = els.previewCanvas.width / rect.width;
  const scaleY = els.previewCanvas.height / rect.height;

  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;

  const dx = (x - state.overlayDrag.startX) / els.previewCanvas.width;
  const dy = (y - state.overlayDrag.startY) / els.previewCanvas.height;

  state.layout.overlayX = Math.max(0, Math.min(1, state.overlayDrag.origX + dx));
  state.layout.overlayY = Math.max(0, Math.min(1, state.overlayDrag.origY + dy));
}

function handlePreviewPointerUp() {
  state.overlayDrag.active = false;
  els.previewCanvas.style.cursor = "default";
}

function bindEvents() {
  els.refreshPermissionsBtn.addEventListener("click", refreshPermissions);
  els.requestCameraBtn.addEventListener("click", requestCameraPermission);
  els.requestMicBtn.addEventListener("click", requestMicrophonePermission);
  els.openScreenSettingsBtn.addEventListener("click", () => {
    window.electronAPI.openSystemSettings("screen");
  });

  els.enableCameraBtn.addEventListener("click", enableCameraAndMic);

  els.chooseSourceBtn.addEventListener("click", async () => {
    await loadSources();
    openSourceModal();
  });

  els.refreshSourcesBtn.addEventListener("click", loadSources);
  els.closeSourceModalBtn.addEventListener("click", closeSourceModal);

  els.tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      els.tabButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.sourceFilter = btn.dataset.filter || "all";
      renderSourceCards();
    });
  });

  els.aspectRatioSelect.addEventListener("change", updateLayoutFromControls);
  els.cameraShapeSelect.addEventListener("change", updateLayoutFromControls);
  els.overlayPositionSelect.addEventListener("change", updateLayoutFromControls);
  els.screenCropAnchorSelect.addEventListener("change", updateLayoutFromControls);
  els.cameraSizeRange.addEventListener("input", updateLayoutFromControls);

  els.startRecordingBtn.addEventListener("click", startRecording);
  els.stopRecordingBtn.addEventListener("click", () => stopRecording());

  els.previewCanvas.addEventListener("pointerdown", handlePreviewPointerDown);
  window.addEventListener("pointermove", handlePreviewPointerMove);
  window.addEventListener("pointerup", handlePreviewPointerUp);

  // Coming back from hidden/minimized, the media elements are sometimes left
  // paused. Nudge them so the canvas doesn't keep compositing a stale frame.
  document.addEventListener("visibilitychange", () => {
    logDiag("visibility-change", { visibility: document.visibilityState });
    if (document.visibilityState !== "visible") return;

    [els.screenVideo, els.cameraVideo].forEach((video) => {
      if (video.srcObject && video.paused) {
        void video.play().catch(() => {});
      }
    });
  });

  window.electronAPI.onFfmpegStatus((message) => {
    setStatus(message);
  });

  window.electronAPI.onFfmpegProgressLog((_message) => {});
}

async function init() {
  bindEvents();
  updateLayoutFromControls();
  startDrawLoop();
  updateAudioTesterUI();
  await refreshPermissions();
  await enumerateDevices();
  setStatus("Ready.");
}

init().catch((error) => {
  console.error(error);
  setStatus(`Init failed: ${error?.message || "unknown error"}`);
});