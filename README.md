# Yoink ♡

A YouTube → Ableton Live sampler, built on the **Ableton Extensions SDK** (public beta). Right-click an audio track, paste a YouTube link, trim the exact section you want on a waveform, and it drops into your Set as a WAV — ready to chop. No bouncing out to a browser, a downloader, and a file manager mid-session.

Wrapped in a Y2K / Windows-2000 "MS Paint" aesthetic, because a sampling utility doesn't have to look like a settings panel.

## Download

**[⬇️ Download the latest `.ablx`](https://github.com/Austin-Imbastari/yoink/releases/latest)** — then double-click the file and Ableton Live installs the extension. Right-click any audio track → **Open Yoink ♡**.

## What it does

- **Paste a YouTube URL** into the link field.
- **Fetches** the video's title, channel, and audio.
- **Waveform trim** — drag the in/out handles, scroll to zoom, drag to pan, hit play to scrub and preview the selection before committing.
- **Drops the trimmed WAV** into the Arrangement on the selected (or a new) track, named from the video title, at your chosen sample rate.
- **Cleans up after itself** — the full download is deleted once the trimmed sample has been copied into your project.

## How it works

The host (Node, via the Extensions SDK) registers an `AudioTrack` context-menu action and orchestrates a small sequence of dialogs:

1. **Paste window** → returns the URL.
2. **Progress dialog** while `yt-dlp` downloads the audio and `ffmpeg` renders a compact preview.
3. **Trim window** — an HTML dialog with the preview inlined; the waveform is decoded and drawn client-side with the Web Audio API.
4. On confirm, `ffmpeg` trims to a WAV at the chosen sample rate, the SDK imports it into the project, and a clip is created on the track.

## Tech

- **TypeScript + Node** on the **Ableton Extensions SDK** (`@ableton-extensions/sdk`, 1.0.0 beta)
- **yt-dlp** + **ffmpeg** for fetching / trimming / converting audio
- **Web Audio API** for the waveform (peak extraction, zoom/pan, preview)
- **esbuild** to bundle the extension (with HTML inlined as text)
- **Node's built-in test runner** for the pure logic (URL parsing, clock conversion, filename sanitization, ffmpeg arg building)

## Prerequisites

`yt-dlp` and `ffmpeg` must be installed and on your `PATH`:

```sh
brew install yt-dlp ffmpeg
```

## Setup

```sh
npm install
cp .env.example .env   # then set EXTENSION_HOST_PATH for your machine
```

`EXTENSION_HOST_PATH` points at Ableton Live's Extension Host module (`ExtensionHostNodeModule.node`).

## Scripts

```sh
npm start          # build (dev) + run in Live's Extension Host
npm test           # run unit tests
npm run build      # production bundle
npm run package    # build + create a .ablx archive
```

## Limitations & SDK feedback

Notes from building on the beta SDK — hopefully useful feedback, and context for the design choices here:

- **Modal dialogs are single-shot.** A dialog returns one value when it closes (`close_and_send`); there's no persistent host↔dialog channel. So the waveform/preview can't be fed to an already-open dialog — the audio has to be inlined into the dialog up front, and the flow is split across separate windows.
- **Inline event handlers are blocked** by the dialog's content-security policy. `onclick="…"` silently does nothing; buttons must be wired with `addEventListener`.
- **No Set sample-rate getter**, so the output rate can't be auto-matched — the user picks 44.1 / 48 kHz instead.
- **No playhead / insert-position API**, so imported clips land at bar 1 of the Arrangement.
- **Embedded host runtime gotchas:** the `URL` global isn't reliably available (URLs are parsed by hand), and a GUI-spawned host inherits a minimal `PATH` (external tools are resolved to absolute paths).

## Notes

This downloads audio from YouTube, which is subject to YouTube's Terms of Service and to copyright. Intended for personal sampling use.
