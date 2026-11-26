/**
 * 书中地图的类型定义在 `src/shared/atlas.ts`：主进程的原图识别与渲染层的 3D 地图
 * 使用同一份结构，避免两边各写一套。这里只做转出，渲染层的既有导入路径不变。
 *
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * `shared/atlas.ts`，Apache-2.0。许可文本见 third_party/infinite-reader/LICENSE。
 */
export type { AtlasPlace, BookMap, AtlasRecognition } from '@shared/atlas'
