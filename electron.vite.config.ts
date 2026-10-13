import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          device: 'src/device/worker.ts',
          runner: 'src/runtime/worker.ts'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } }
  },
  renderer: {
    plugins: [
      react(),
      tailwind(),
      {
        name: 'decker-development-csp',
        apply: 'serve',
        transformIndexHtml: (html) =>
          html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      }
    ]
  }
})
