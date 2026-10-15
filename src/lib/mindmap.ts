/**
 * 思维导图 · 纯函数（零依赖）
 *
 * 用途：AI 教学「思维导图」产物的**判别 / 解析 / 导出 / 布局**。
 * 三处共用同一实现，绝不各自复刻：
 *   - 渲染层 `src/components/shared/MindMapView.tsx`（布局与交互）
 *   - 笔记区 `PageEditor` / AI 教学 `openArtFile`（按内容识别 `looksLikeMindMap`）
 *   - 契约脚本 `.AGENT/scripts/ai-teaching/verify-mindmap.mjs`（strip-types 直接 import）
 *
 * 所以本文件**不得** import 任何 React / Node / 业务模块。
 *
 * 数据形态（会话产物 `{会话夹}/mindmaps/<slug>.json`）：
 *   { "kind":"mindmap", "version":1, "title":"…", "root":{ text, ref?, children? } }
 */

export interface MindMapNode {
  text: string
  /** 可选：知识库笔记的仓库相对路径（.md）；点击 → 打开该笔记 */
  ref?: string | null
  children?: MindMapNode[]
  /** 运行时折叠态（布局读取；不写回磁盘 JSON） */
  collapsed?: boolean
  /** 运行时节点 id（布局/编辑用；不写回磁盘 JSON）—— assignIds() 生成 */
  _id?: string
}

export interface MindMapDoc {
  kind: 'mindmap'
  version?: number
  title: string
  root: MindMapNode
}

/** 解析 JSON 文本为导图文档；非导图结构 / 非法 JSON → null（识别按内容，不按路径）。 */
export function parseMindmap(text: string): MindMapDoc | null {
  if (!text) return null
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (
    obj !== null && typeof obj === 'object'
    && (obj as { kind?: unknown }).kind === 'mindmap'
    && (obj as { root?: unknown }).root !== null
    && typeof (obj as { root?: { text?: unknown } }).root === 'object'
    && typeof (obj as { root: { text?: unknown } }).root.text === 'string'
  ) {
    const doc = obj as MindMapDoc
    if (!doc.title) doc.title = doc.root.text
    return doc
  }
  return null
}

/** 是否是一份思维导图（软件「识别到特征就渲染」的唯一判据）。 */
export function looksLikeMindMap(text: string): boolean {
  return parseMindmap(text) !== null
}

/** 节点总数（含根）。 */
export function countNodes(node: MindMapNode): number {
  let n = 1
  for (const c of node.children ?? []) n += countNodes(c)
  return n
}

/** 多级无序列表；带 ref 的节点渲染为指向笔记的链接（[查看](rel)）。 */
export function treeToList(node: MindMapNode, depth = 0): string {
  const indent = '  '.repeat(depth)
  const label = node.ref ? `[${node.text}](${node.ref})` : node.text
  const lines = [indent + '- ' + label]
  for (const c of node.children ?? []) lines.push(treeToList(c, depth + 1))
  return lines.join('\n')
}

/** Mermaid `mindmap` 块正文（根用 root((…))，逐层缩进两空格）。 */
export function treeToMermaid(node: MindMapNode, depth = 0): string {
  const pad = '  '.repeat(depth + 1)
  const head = depth === 0 ? `${pad}root((${node.text}))` : `${pad}${node.text}`
  const lines = [head]
  for (const c of node.children ?? []) lines.push(treeToMermaid(c, depth + 1))
  return lines.join('\n')
}

/** 导出为知识库笔记的 Markdown：标题 + Mermaid 块 + 多级大纲（同 Phrontis 视觉转写口径）。 */
export function treeToMarkdown(doc: MindMapDoc): string {
  const title = doc.title || doc.root.text || '思维导图'
  return [
    `# ${title}`,
    '',
    '## 思维导图',
    '',
    '```mermaid',
    'mindmap',
    treeToMermaid(doc.root),
    '```',
    '',
    '## 大纲',
    '',
    treeToList(doc.root),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 布局（左→右 tidy 树）—— 与渲染层同一实现，便于契约脚本直接验证
// ---------------------------------------------------------------------------

export interface LayoutOpts {
  nodeW?: number
  nodeH?: number
  gapX?: number
  gapY?: number
  pad?: number
}

export interface LayoutNode {
  node: MindMapNode
  x: number
  y: number
  depth: number
  hasChildren: boolean
}

export interface LayoutEdge {
  from: LayoutNode
  to: LayoutNode
}

export interface LayoutResult {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  width: number
  height: number
  nodeW: number
  nodeH: number
}

/**
 * 计算左→右 tidy 布局：按深度定 x，后序定 y（父节点 y = 首末子节点 y 的中值）。
 * 折叠节点（`node.collapsed`）不展开其子树。纯函数，不修改入参。
 */
export function layoutTree(root: MindMapNode, opts: LayoutOpts = {}): LayoutResult {
  const nodeW = opts.nodeW ?? 176
  const nodeH = opts.nodeH ?? 40
  const gapX = opts.gapX ?? 64
  const gapY = opts.gapY ?? 22
  const pad = opts.pad ?? 48

  const nodes: LayoutNode[] = []
  const edges: LayoutEdge[] = []
  let row = 0

  const place = (node: MindMapNode, depth: number, parent: LayoutNode | null): LayoutNode => {
    const ln: LayoutNode = {
      node,
      x: pad + depth * (nodeW + gapX),
      y: 0,
      depth,
      hasChildren: !!(node.children && node.children.length),
    }
    nodes.push(ln)
    if (parent) edges.push({ from: parent, to: ln })
    const kids = node.children ?? []
    if (!node.collapsed && kids.length) {
      const childLns = kids.map((k) => place(k, depth + 1, ln))
      ln.y = (childLns[0].y + childLns[childLns.length - 1].y) / 2
    } else {
      ln.y = pad + row * (nodeH + gapY)
      row++
    }
    return ln
  }

  place(root, 0, null)

  let maxX = 0
  let maxY = 0
  for (const n of nodes) {
    maxX = Math.max(maxX, n.x + nodeW)
    maxY = Math.max(maxY, n.y + nodeH)
  }
  return { nodes, edges, width: maxX + pad, height: maxY + pad, nodeW, nodeH }
}

// ---------------------------------------------------------------------------
// 树编辑（Phase 2）—— 全部原地修改 + 运行时 _id；渲染层与契约脚本共用
// ---------------------------------------------------------------------------

let _idSeq = 0

/** 给整棵树分配运行时 _id（每次载入 / 撤销恢复后调用）。 */
export function assignIds(root: MindMapNode): void {
  _idSeq = 0
  const walk = (n: MindMapNode): void => {
    n._id = 'n' + (_idSeq++)
    for (const c of n.children ?? []) walk(c)
  }
  walk(root)
}

/** 新建一个带新 _id 的节点。 */
export function makeNode(text = '新节点', ref: string | null = null): MindMapNode {
  return ref ? { text, ref, _id: 'n' + (_idSeq++) } : { text, _id: 'n' + (_idSeq++) }
}

/** 按 _id 找节点。 */
export function findNode(root: MindMapNode, id: string): MindMapNode | null {
  if (root._id === id) return root
  for (const c of root.children ?? []) {
    const r = findNode(c, id)
    if (r) return r
  }
  return null
}

/** 找节点的父与下标；根返回 { parent: null, index: -1 }；未找到返回 null。 */
export function findParent(root: MindMapNode, id: string): { parent: MindMapNode | null; index: number } | null {
  if (root._id === id) return { parent: null, index: -1 }
  const walk = (n: MindMapNode): { parent: MindMapNode; index: number } | null => {
    const kids = n.children ?? []
    for (let i = 0; i < kids.length; i++) {
      if (kids[i]._id === id) return { parent: n, index: i }
      const r = walk(kids[i])
      if (r) return r
    }
    return null
  }
  return walk(root)
}

/** id 是否在 ancestorId 的子树内（含自身）。拖拽防环用。 */
export function isDescendant(root: MindMapNode, ancestorId: string, id: string): boolean {
  const anc = findNode(root, ancestorId)
  if (!anc) return false
  let found = false
  const walk = (n: MindMapNode): void => {
    if (found) return
    if (n._id === id) { found = true; return }
    for (const c of n.children ?? []) walk(c)
  }
  walk(anc)
  return found
}

/** 给节点追加一个子节点（返回新节点）。 */
export function addChildNode(parent: MindMapNode, text = '新节点'): MindMapNode {
  const node = makeNode(text)
  if (!parent.children) parent.children = []
  parent.children.push(node)
  return node
}

/** 删除非根节点（根不可删）。 */
export function removeNode(root: MindMapNode, id: string): boolean {
  const loc = findParent(root, id)
  if (!loc || !loc.parent || loc.index < 0) return false
  loc.parent.children!.splice(loc.index, 1)
  if (loc.parent.children!.length === 0) delete loc.parent.children
  return true
}

/**
 * 移动节点：mode='child' 挂到 target 下；'before'/'after' 插到 target 同级前/后。
 * 拒绝：拖到自身 / 拖进自身子孙（防环）/ 目标不存在 / 拖根。
 */
export function moveNode(root: MindMapNode, dragId: string, targetId: string, mode: 'child' | 'before' | 'after'): boolean {
  if (dragId === targetId) return false
  if (isDescendant(root, dragId, targetId)) return false
  const dragLoc = findParent(root, dragId)
  if (!dragLoc || !dragLoc.parent || dragLoc.index < 0) return false
  if (!findNode(root, targetId)) return false
  const [dragged] = dragLoc.parent.children!.splice(dragLoc.index, 1)
  if (dragLoc.parent.children!.length === 0) delete dragLoc.parent.children
  if (mode === 'child') {
    const target = findNode(root, targetId)!
    if (!target.children) target.children = []
    target.children.push(dragged)
  } else {
    const tLoc = findParent(root, targetId)
    if (!tLoc || !tLoc.parent || tLoc.index < 0) { // target 是根 → 退化为挂到根下
      const target = findNode(root, targetId)!
      if (!target.children) target.children = []
      target.children.push(dragged)
      return true
    }
    const at = mode === 'before' ? tLoc.index : tLoc.index + 1
    tLoc.parent.children!.splice(at, 0, dragged)
  }
  return true
}

/** 序列化为磁盘 JSON（剥离运行时 _id / collapsed；保留 kind 判别字段）。 */
export function serializeMindmap(doc: MindMapDoc): string {
  const clean = (n: MindMapNode): MindMapNode => {
    const o: MindMapNode = { text: n.text }
    if (n.ref) o.ref = n.ref
    if (n.children && n.children.length) o.children = n.children.map(clean)
    return o
  }
  return JSON.stringify({ kind: 'mindmap', version: doc.version ?? 1, title: doc.title, root: clean(doc.root) }, null, 2)
}
