const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  listDesktopSources: () => ipcRenderer.invoke("desktop-sources:list"),
  selectDesktopSource: (payload) =>
    ipcRenderer.invoke("desktop-sources:select", payload),

  getPermissionStatus: () => ipcRenderer.invoke("permissions:get-status"),
  requestCameraPermission: () =>
    ipcRenderer.invoke("permissions:request-camera"),
  requestMicrophonePermission: () =>
    ipcRenderer.invoke("permissions:request-microphone"),
  openSystemSettings: (pane) =>
    ipcRenderer.invoke("open-system-settings", pane),

  beginRecordingSave: (payload) =>
    ipcRenderer.invoke("recording:begin-save", payload),
  appendRecordingChunk: (payload) =>
    ipcRenderer.invoke("recording:append-chunk", payload),
  finishRecordingSave: () => ipcRenderer.invoke("recording:finish-save"),
  abortRecordingSave: () => ipcRenderer.invoke("recording:abort-save"),

  onFfmpegStatus: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("ffmpeg:status", handler);
    return () => ipcRenderer.removeListener("ffmpeg:status", handler);
  },

  onFfmpegProgressLog: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("ffmpeg:progress-log", handler);
    return () => ipcRenderer.removeListener("ffmpeg:progress-log", handler);
  },
});