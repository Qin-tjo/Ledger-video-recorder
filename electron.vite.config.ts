import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Vite adds `crossorigin` to the built <script>/<link> tags. Under Electron's
// file:// protocol that forces a CORS fetch the opaque file:// origin can't
// satisfy, so the bundle fails with ERR_FILE_NOT_FOUND and the window is blank.
// Strip it so production loads correctly.
function stripCrossorigin() {
  return {
    name: 'strip-crossorigin',
    transformIndexHtml(html: string): string {
      return html.replace(/\s+crossorigin(=("|')[^"']*("|'))?/g, '')
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          bubble: resolve(__dirname, 'src/renderer/bubble.html')
        }
      }
    },
    plugins: [react(), stripCrossorigin()]
  }
})
