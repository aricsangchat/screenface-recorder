# ScreenFace Recorder

A simple Electron starter app for recording your desktop and face cam together with switchable layouts for vertical, square, and widescreen content.

## Current starter features

- In-app screen/window picker with live source thumbnails
- Camera and microphone selectors
- 9:16, 16:9, and 1:1 canvas output
- Vertical stacked layout and overlay layout
- Circle, square, and rectangle face cam masks
- Drag-to-position face cam in overlay mode
- Local `.webm` recording export
- Basic macOS permission status panel

## Setup

```bash
npm install
npm run dev
```

## macOS permissions

You will likely need to allow:
- Screen Recording
- Camera
- Microphone

For Screen Recording on macOS, you may need to quit and reopen the app after granting permission.

## Notes

This starter currently records the composited canvas and microphone input. It does not yet merge system audio from the desktop source.

## Good next features

- MP4 export via ffmpeg
- Better recording quality presets
- Separate mic + system audio mixing
- Preset templates for YouTube, Reels, and webinars
- Face-cam background blur
- Title bars / lower thirds
