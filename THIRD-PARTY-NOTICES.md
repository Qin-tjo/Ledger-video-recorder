# Third-Party Notices

Ledger Video Recorder is MIT-licensed (see `LICENSE`). The application depends on, and its
distributed binaries bundle, third-party software under the licenses below.

## FFmpeg (important — GPL)

MP4 export uses **FFmpeg**, obtained at install time via
[`@ffmpeg-installer/ffmpeg`](https://github.com/kribblo/node-ffmpeg-installer).
The bundled FFmpeg build includes **libx264** (H.264 encoder), which is licensed
under the **GNU General Public License (GPL) v2 or later**. As a result, the
FFmpeg binary distributed with the app is covered by the GPL.

- FFmpeg: https://ffmpeg.org — licensed under LGPL-2.1+/GPL-2.0+ depending on build.
- libx264: https://www.videolan.org/developers/x264.html — GPL-2.0+.
- FFmpeg source (as required by the GPL): https://ffmpeg.org/download.html and
  https://git.ffmpeg.org/ffmpeg

Ledger Video Recorder invokes FFmpeg as a **separate executable** (a subprocess); the two are
not linked into a single program. When distributing release binaries you must:

1. Include this notice and the FFmpeg/x264 license texts alongside the download, and
2. Make the corresponding FFmpeg source available (a link to the official source
   download that matches the bundled version satisfies this).

> The FFmpeg source is **not** redistributed in this repository — it is downloaded
> from `@ffmpeg-installer` during `npm install`. Only packaged release builds
> contain the FFmpeg binary.

## Application frameworks & libraries

All under the permissive **MIT License** unless noted:

- Electron — MIT (bundles Chromium [BSD-style] and Node.js [MIT])
- React, React DOM — MIT
- Zustand — MIT
- Framer Motion — MIT
- fluent-ffmpeg — MIT
- Vite, electron-vite, @vitejs/plugin-react — MIT
- Tailwind CSS, PostCSS, Autoprefixer — MIT
- TypeScript — Apache-2.0
- electron-builder, @electron/notarize — MIT

Full license texts for each dependency are available in their respective
`node_modules/<package>/LICENSE` files and on their project pages.
