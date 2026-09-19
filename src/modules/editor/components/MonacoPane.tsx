/**
 * MonacoPane 已上移全仓共享层 `src/components/shared/MonacoPane.tsx`
 * （笔记合并 Phase 1 P1b，docs/notes-merge-phase1-design.md §1.2）——
 * 这里 re-export 保持编辑器模块既有 import 路径与 lazy 加载不变。
 * 结构化文档 PaneDoc / 多宿主监听 / modelPath 命名空间见共享层文件头注释。
 */
export { MonacoPane, addInlineSuggestBusyListener, addInlinePausedListener, setInlineAutoMode, setInlinePausedListener, setInlineSuggestBusyListener, cancelInlineSuggestInFlight, wikiContextTarget, wikiTargetTitle } from '../../../components/shared/MonacoPane'
export type { MonacoPaneHandle, PaneDoc, OnMount } from '../../../components/shared/MonacoPane'
