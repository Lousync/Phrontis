/**
 * 图谱数据契约（web 侧单源类型）。
 * electron 侧 `electron/lib/kbStore/graphIndex.ts` 反向 import 本文件（共享类型反向 import 先例）。
 * 结构对应 `.knowbase/cache/graph.json`（schemaVersion 1），字段勿单独改动——两端一致。
 */

export interface GraphNode {
  id: string
  title: string
  /** 仓库内相对路径；tag / dangling（未解析引用虚节点）为空串 */
  path: string
  kind: 'page' | 'tag' | 'dangling'
  /** 无向关联数（页页边 + 页标签边）；dangling 为引用它的源页数 */
  degree: number
  /**
   * tag 节点的「父目录」副线（学科/章节级），用关联度最高的 page 的 path 倒数第二段
   * 99d8871 修复仅覆盖 page 节点 → tag 节点在 GraphCanvas 单行显示英文短代码（kb-ds-8-7-3-1）用户读不懂
   * ISS-2026-09-04-05 数据层补：让 tag 节点在开启 showTags 时也能显示「学科/章节」副线
   */
  parentCtx?: string
}

/** 去重后的无向边（页-页 / 页-标签） */
export interface GraphEdge {
  s: string
  t: string
}

/** 未解析 [[引用]] 聚合成的虚节点数据 */
export interface UnresolvedRef {
  name: string
  /** 引用它的源页 id 列表（去重） */
  refs: string[]
}

export interface GraphIndexData {
  schemaVersion: 1
  builtAt: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  unresolved: UnresolvedRef[]
  /** resolved 反链索引：目标页 id → 引用它的源页 id 列表（供知识库反链面板） */
  incoming: Record<string, string[]>
}

/** 图谱视图设置（.knowbase/config.json graphView 段；默认值见 electron repoConfig.GRAPH_VIEW_DEFAULTS） */
export interface GraphViewConfig {
  linkDistance: number
  chargeStrength: number
  showTags: boolean
  showOrphans: boolean
  colorBySpace: boolean
  clusterForce: boolean
  labelThreshold: number
}
