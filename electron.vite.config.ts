import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// electron-vite 5 的版本映射表只到 Electron 39，40+ 会静默回退到 chrome142/node22.20。
// 钉死实际运行时版本，避免降级编译且不报错。
const NODE_TARGET = 'node24'
const CHROME_TARGET = 'chrome156'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      target: NODE_TARGET,
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
      target: NODE_TARGET,
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
    build: {
      target: CHROME_TARGET,
    },
    // electron-vite 5 has no --port CLI; `-- --port` goes to Electron.
    server: {
      port: 5175,
      strictPort: true,
      host: '127.0.0.1',
    },
  },
})
