const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  desktopCapturer,
  session,
  systemPreferences,
  shell,
} = require("electron");

// Keep the renderer running at full speed when the window is backgrounded,
// occluded, or on another Space. Without these the draw loop stalls and the
// recorded canvas freezes on whatever frame was last painted.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

let mainWindow = null;
let activeRecording = null;
let selectedDesktopSourceId = null;
const runtimeLogPath = path.join(__dirname, "..", "logs", "screenface-runtime.log");

function appendRuntimeLog(line) {
  try {
    fs.mkdirSync(path.dirname(runtimeLogPath), { recursive: true });
    fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} ${line}\n`);
  } catch (error) {
    console.error("Could not write runtime log", error);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    // The UI is laid out to fit the window with no scrolling, so the minimum
    // has to be tall enough for the full sidebar.
    minWidth: 900,
    minHeight: 730,
    title: "ScreenFace Recorder",
    backgroundColor: "#081120",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setBackgroundThrottling(false);

  mainWindow.webContents.on("console-message", (_event, ...args) => {
    let level = 0;
    let message = "";
    let line = 0;
    let sourceId = "unknown";

    if (args.length === 1 && args[0] && typeof args[0] === "object") {
      const details = args[0];
      level = details.level || 0;
      message = details.message || "";
      line = details.lineNumber || 0;
      sourceId = details.sourceId || "unknown";
    } else {
      [level, message, line, sourceId] = args;
    }

    const levelTag = level === 2 ? "WARN" : level >= 3 ? "ERROR" : "LOG";
    const lineText = `[renderer:${levelTag}] ${message} (${sourceId}:${line})`;
    console.log(lineText);
    appendRuntimeLog(lineText);
  });

  appendRuntimeLog("[main:LOG] BrowserWindow created");

  mainWindow.loadFile(path.join(__dirname, "index.html"));

}

function safeNativeImageToDataURL(image) {
  try {
    if (!image) return null;
    if (typeof image.isEmpty === "function" && image.isEmpty()) return null;
    if (typeof image.toDataURL !== "function") return null;
    const dataUrl = image.toDataURL();
    return dataUrl && dataUrl !== "data:," ? dataUrl : null;
  } catch (error) {
    console.warn("Could not convert NativeImage:", error);
    return null;
  }
}

function getFfmpegPath() {
  const candidates = [
    process.env.FFMPEG_PATH,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "ffmpeg",
  ].filter(Boolean);

  return candidates[0];
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("ffmpeg:progress-log", text);
      }
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `Could not start ffmpeg. Checked: ${ffmpegPath}. Original error: ${error.message}`
        )
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `ffmpeg exited with code ${code}\n\n${stderr || stdout || "No ffmpeg output"}`
          )
        );
      }
    });
  });
}

function makeTempWebmPath(baseOutputPath) {
  const dir = path.dirname(baseOutputPath);
  const ext = path.extname(baseOutputPath);
  const baseName = path.basename(baseOutputPath, ext);
  const stamp = Date.now();
  return path.join(dir, `${baseName}.__recording__.${stamp}.webm`);
}

function getDiskFreeBytes(targetPath) {
  try {
    const stat = fs.statfsSync(path.dirname(targetPath));
    return Number(stat.bavail) * Number(stat.bsize);
  } catch (_error) {
    return null;
  }
}

function hasEnoughSpaceForConversion(tempWebmPath, outputPath) {
  try {
    const tempSize = fs.statSync(tempWebmPath).size;
    const freeBytes = getDiskFreeBytes(outputPath);

    if (freeBytes == null) {
      return { ok: true };
    }

    // Keep headroom because output is created while temp WebM still exists.
    const minimumNeeded = Math.max(
      512 * 1024 * 1024,
      Math.ceil(tempSize * 1.25)
    );

    if (freeBytes < minimumNeeded) {
      const freeMb = Math.round(freeBytes / (1024 * 1024));
      const neededMb = Math.round(minimumNeeded / (1024 * 1024));

      return {
        ok: false,
        error: `Not enough free disk space for MP4 conversion. Free: ~${freeMb} MB, required: ~${neededMb} MB.`,
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `Could not check disk space: ${error?.message || "unknown error"}`,
    };
  }
}

function ensureMp4Extension(filePath) {
  if (filePath.toLowerCase().endsWith(".mp4")) return filePath;
  return `${filePath}.mp4`;
}

async function closeActiveRecording() {
  if (!activeRecording?.stream) return;

  const recording = activeRecording;
  activeRecording = null;

  await new Promise((resolve, reject) => {
    recording.stream.end((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  return recording;
}

app.whenReady().then(() => {
  appendRuntimeLog("[main:LOG] app ready");

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          fetchWindowIcons: true,
          thumbnailSize: {
            width: 320,
            height: 200,
          },
        });

        const selectedSource = selectedDesktopSourceId
          ? sources.find((source) => source.id === selectedDesktopSourceId)
          : null;

        if (!selectedSource) {
          appendRuntimeLog("[main:WARN] display media request had no selected source");
          callback({ video: null, audio: null });
          return;
        }

        appendRuntimeLog(`[main:LOG] display media request accepted source=${selectedSource.id}`);
        callback({
          video: selectedSource,
          audio: false,
        });
      } catch (error) {
        console.error("display media request failed", error);
        appendRuntimeLog(`[main:ERROR] display media request failed: ${error?.message || "unknown"}`);
        callback({ video: null, audio: null });
      }
    },
    { useSystemPicker: false }
  );

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("desktop-sources:list", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    fetchWindowIcons: true,
    thumbnailSize: {
      width: 320,
      height: 200,
    },
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id,
    kind: source.id.startsWith("screen:") ? "screen" : "window",
    thumbnailDataUrl: safeNativeImageToDataURL(source.thumbnail),
    appIconDataUrl: safeNativeImageToDataURL(source.appIcon),
  }));
});

ipcMain.handle("desktop-sources:select", async (_event, { sourceId }) => {
  selectedDesktopSourceId = sourceId || null;
  appendRuntimeLog(`[main:LOG] selected desktop source=${selectedDesktopSourceId || "none"}`);
  return { ok: true };
});

ipcMain.handle("permissions:get-status", async () => {
  const result = {
    platform: process.platform,
    camera: "unknown",
    microphone: "unknown",
    screen: "unknown",
    canAskForCamera: false,
    canAskForMicrophone: false,
  };

  if (process.platform === "darwin") {
    try {
      result.camera = systemPreferences.getMediaAccessStatus("camera");
    } catch (_error) {}

    try {
      result.microphone = systemPreferences.getMediaAccessStatus("microphone");
    } catch (_error) {}

    try {
      result.screen = systemPreferences.getMediaAccessStatus("screen");
    } catch (_error) {}

    result.canAskForCamera = result.camera === "not-determined";
    result.canAskForMicrophone = result.microphone === "not-determined";
  }

  return result;
});

ipcMain.handle("permissions:request-camera", async () => {
  if (process.platform !== "darwin") return false;
  return systemPreferences.askForMediaAccess("camera");
});

ipcMain.handle("permissions:request-microphone", async () => {
  if (process.platform !== "darwin") return false;
  return systemPreferences.askForMediaAccess("microphone");
});

ipcMain.handle("open-system-settings", async (_event, pane) => {
  if (process.platform !== "darwin") return false;

  const deepLinks = {
    screen:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    camera:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
    microphone:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  };

  return shell.openExternal(
    deepLinks[pane] ||
      "x-apple.systempreferences:com.apple.preference.security"
  );
});

ipcMain.handle("recording:begin-save", async (_event, { defaultFileName }) => {
  if (activeRecording) {
    return { ok: false, error: "A recording is already in progress." };
  }

  const videosDir = app.getPath("videos");
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Save recording as",
    defaultPath: path.join(videosDir, ensureMp4Extension(defaultFileName)),
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
  });

  if (canceled || !filePath) {
    return { ok: false, canceled: true };
  }

  const finalMp4Path = ensureMp4Extension(filePath);
  const tempWebmPath = makeTempWebmPath(finalMp4Path);

  try {
    const stream = fs.createWriteStream(tempWebmPath, { flags: "w" });

    await new Promise((resolve, reject) => {
      stream.once("open", resolve);
      stream.once("error", reject);
    });

    activeRecording = {
      stream,
      tempWebmPath,
      finalMp4Path,
      bytesWritten: 0,
      startedAt: Date.now(),
    };

    return {
      ok: true,
      tempWebmPath,
      finalMp4Path,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || "Could not open temp recording file.",
    };
  }
});

ipcMain.handle("recording:append-chunk", async (_event, { chunk }) => {
  if (!activeRecording?.stream) {
    return { ok: false, error: "No active recording file." };
  }

  try {
    let buffer;

    if (ArrayBuffer.isView(chunk)) {
      buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else if (chunk instanceof ArrayBuffer) {
      buffer = Buffer.from(chunk);
    } else if (Array.isArray(chunk)) {
      // Backward-compatible path for old renderer payloads.
      buffer = Buffer.from(chunk);
    } else {
      throw new Error("Unsupported chunk payload type.");
    }

    activeRecording.bytesWritten += buffer.length;

    await new Promise((resolve, reject) => {
      activeRecording.stream.write(buffer, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    return {
      ok: true,
      bytesWritten: activeRecording.bytesWritten,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || "Failed to append recording chunk.",
    };
  }
});

ipcMain.handle("recording:finish-save", async () => {
  if (!activeRecording?.stream) {
    return { ok: false, error: "No active recording file." };
  }

  const finished = await closeActiveRecording();

  try {
    const spaceCheck = hasEnoughSpaceForConversion(
      finished.tempWebmPath,
      finished.finalMp4Path
    );

    if (!spaceCheck.ok) {
      return {
        ok: false,
        error: spaceCheck.error,
        tempWebmPath: finished.tempWebmPath,
        finalMp4Path: finished.finalMp4Path,
      };
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ffmpeg:status", "Converting WebM to MP4...");
    }

    const ffmpegArgs = [
      "-y",
      "-i",
      finished.tempWebmPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      finished.finalMp4Path,
    ];

    await runFfmpeg(ffmpegArgs);

    try {
      fs.unlinkSync(finished.tempWebmPath);
    } catch (_error) {}

    return {
      ok: true,
      filePath: finished.finalMp4Path,
      bytesWritten: finished.bytesWritten,
      converted: true,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error?.message || "Recording finished, but MP4 conversion failed.",
      tempWebmPath: finished.tempWebmPath,
      finalMp4Path: finished.finalMp4Path,
    };
  }
});

ipcMain.handle("recording:abort-save", async () => {
  if (!activeRecording) return { ok: true };

  const recording = activeRecording;
  activeRecording = null;

  try {
    if (recording.stream) {
      recording.stream.destroy();
    }
  } catch (_error) {}

  try {
    if (recording.tempWebmPath && fs.existsSync(recording.tempWebmPath)) {
      fs.unlinkSync(recording.tempWebmPath);
    }
  } catch (_error) {}

  return { ok: true };
});