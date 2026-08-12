# ScreenFace Recorder

An Electron app for recording your desktop and face cam together, with switchable layouts for vertical, square, and widescreen content. Exports MP4.

## Features

- In-app screen/window picker with live source thumbnails
- Camera and microphone selectors, with a live mic level meter
- 9:16, 16:9, and 1:1 canvas output
- Vertical stacked layout and overlay layout
- Screen fit modes: blur fill, contain, and crop fill with a left/center/right crop anchor
- Circle, square, and rectangle face cam masks
- Drag-to-position face cam in overlay mode
- MP4 export via ffmpeg (recorded as WebM, converted on stop)
- Chunked streaming to disk during recording, so long takes don't sit in memory
- Automatic recovery if the screen capture source drops mid-recording
- Basic macOS permission status panel

## Setup

```bash
npm install
```

```bash
npm run dev
```

MP4 export shells out to `ffmpeg`. It looks at `$FFMPEG_PATH` first, then `/opt/homebrew/bin/ffmpeg` and `/usr/local/bin/ffmpeg`, then whatever `ffmpeg` resolves to on `PATH`. Install it with `brew install ffmpeg` if you don't have it.

## macOS permissions

You will likely need to allow:
- Screen Recording
- Camera
- Microphone

For Screen Recording on macOS, you may need to quit and reopen the app after granting permission.

## How recording works

The output video is not the raw screen capture. Each frame is composited onto an offscreen canvas (screen + face cam + masks), and that canvas is what `MediaRecorder` captures.

This matters for background behavior: a canvas capture stream only produces a new frame when something repaints the canvas. Chromium suspends `requestAnimationFrame` when a window is hidden, minimized, or fully occluded, so a rAF-only draw loop causes the recording to freeze on its last painted frame the moment you switch apps or Spaces.

Two things prevent that:

- The main process disables renderer backgrounding, background timer throttling, and occluded-window backgrounding, and sets `backgroundThrottling: false` on the window.
- The draw loop uses rAF as a fast path but falls back to a 30fps timer watchdog whenever rAF goes quiet, so the record canvas keeps advancing regardless. Preview painting is skipped while the window is hidden.

If you touch the draw loop, keep that fallback — recording while the app is in the background is the normal case for this tool.

## Notes

Records the composited canvas plus microphone input. It does not yet merge system audio from the desktop source.

## Good next features

- Separate mic + system audio mixing
- Recording quality presets
- Preset templates for YouTube, Reels, and webinars
- Face-cam background blur
- Title bars / lower thirds
