import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// electron-vite 5 的版本映射表只到 Electron 39，40+ 会静默回退到 chrome142/node22.20。
// 钉死实际运行时版本，避免降级编译且不报错。
const NODE_TARGET = 'node24'

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
      // 渲染层不降级：运行时是 Electron 45 / Chromium 156，esnext 语法直接可跑。
      // 顺带绕开 vite 7 + esbuild 0.28 的 transpile：它对超过约 1MB 的 chunk 走
      // 临时文件回传，本机 Windows 上删除该临时文件稳定报 "Access is denied"，
      // 大 chunk（renderer 主包 ~4MB）会直接把构建打断。
      target: 'esnext',
    },
    // electron-vite 5 has no --port CLI; `-- --port` goes to Electron.
    server: {
      port: 5175,
      strictPort: true,
      host: '127.0.0.1',
    },
  },
})
