import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    // package.json "type": "module" would emit ESM index.mjs. Electron
    // sandbox cannot parse ESM preloads, so force CJS bytes at the path
    // main already loads (join(__dirname, '../preload/index.mjs')).
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.mjs',
          chunkFileNames: '[name]-[hash].cjs',
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [vue()],
    // electron-vite 5 has no --port CLI; `-- --port` goes to Electron.
    server: {
      port: 5175,
      strictPort: true,
      host: '127.0.0.1',
    },
  },
})
