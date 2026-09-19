/**
 * 页签策略已上移共享层 `src/lib/tabPolicy.ts`（笔记合并 Phase 1 §1.3）——
 * 这里 re-export 保持编辑器模块既有 import（`from './tabPolicy'`）与
 * 契约脚本 `.AGENT/scripts/editor/verify-tab-preview.mjs` 的引用不变。
 */
export { TAB_SOFT_CAP, previewReplacement, pickTabsToEvict, nextTabInCycle, landingAfterClose } from '../../lib/tabPolicy'
export type { PreviewReplacement, TabCapInput } from '../../lib/tabPolicy'
