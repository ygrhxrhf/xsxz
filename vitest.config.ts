import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, '.dsh/**', '.zcode/**'],
    // 不少用例要真的建库写盘（30 章建库、轮询水合、布隆索引），并发跑时 5s 的默认预算
    // 时不时不够，会让全量出现与改动无关的随机红。给足预算；个别更慢的用例再单独放宽。
    testTimeout: 20_000,
  },
})
