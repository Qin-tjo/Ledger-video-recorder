# Ledger Video Recorder

A free, open-source **screen + webcam recorder** for macOS — record your screen and
camera together (Loom-style), then trim, split, reposition the camera bubble, add a
background, and drop in smooth zoom punch-ins, all in a simple built-in editor. Export
an MP4 and you're done.

> ⚠️ **Early project.** It works, but it's lightly tested. Expect rough edges, and please
> report issues.

## Features

- 🎥 **Record screen + camera + mic** together, with a live floating camera bubble
- ✂️ **Clip editor** — split, delete (ripple), and drag-to-trim clips on a thumbnail timeline
- 🔍 **One-click zoom punch-ins** — click a spot on the preview for a smooth zoom-in → hold → zoom-out
- 🟣 **Camera bubble** — circle/rounded/square, resizable, draggable, with corner snapping
- 🎨 **Backgrounds** — solid or gradient with padding, so the screen sits on a backdrop
- ↩️ **Undo / redo** everywhere
- 💾 **Export** to MP4 (H.264/AAC) or WebM, saved locally

## Privacy

Ledger Video Recorder runs **entirely on your machine**. It makes **no network requests** — no
telemetry, no analytics, no uploads. Your recordings are saved locally under the app's
data folder (`~/Library/Application Support/Ledger Video Recorder/recordings`). Don't take our word for
it — the code is right here.

## Download & install (macOS)

Grab the latest `.dmg` from the [Releases](../../releases) page, open it, and drag Ledger Video Recorder
to Applications.

Because the app isn't code-signed with an Apple Developer certificate yet, macOS will warn
you the first time:

1. Double-click the app — you'll see "Apple could not verify…". Click **Done**.
2. Go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.
3. Confirm **Open**. You only do this once.

On first record, macOS will ask for **Screen Recording**, **Camera**, and **Microphone**
permission — grant all three (the app links you straight to the right settings pane).

## Build from source

Requires **Node.js 18+**.

```bash
git clone <your-repo-url>
cd ledger-video-recorder
npm install
npm run dev        # run with hot reload
```

Other scripts:

```bash
npm run typecheck  # type-check the whole project
npm run build      # production build into ./out
npm run pack       # unpacked .app in ./dist for local testing
npm run dist:mac   # build the .dmg + .zip
```

## Tech stack

Electron + React + TypeScript ([electron-vite](https://electron-vite.org)), Tailwind CSS,
Zustand, Framer Motion, and FFmpeg (via `@ffmpeg-installer`) for MP4 transcoding. The
editor composites both video tracks on an HTML canvas — a single `renderFrame()` drives
both the live preview and the export, so what you see is what you get.

## License

Source code: **MIT** — see [LICENSE](LICENSE).

Packaged builds bundle FFmpeg, which includes GPL-licensed components — see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Contributing

Issues and PRs welcome. This is a hobby project maintained on a best-effort basis — no
guarantees on response time.
