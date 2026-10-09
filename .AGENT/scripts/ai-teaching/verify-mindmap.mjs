#!/usr/bin/env node
/**
 * 契约验证：AI 教学「思维导图」（.AGENT/.claude/plans/ai-teaching-mindmap.md）。
 *
 * 为什么需要它：导图的失败模式多是静默的 ——
 * ① 判别字段写错（`kind` 拼成 `type`）→ 打开文件只显示 JSON，不渲染、不报错；
 * ② 导出 Markdown 的 Mermaid 缩进错 → 知识库里图渲染不出、只显示代码块；
 * ③ 布局算法改坏 → 节点重叠 / 负坐标 / 折叠后仍排子节点，肉眼在开发机上不易撞到。
 *
 * 三类断言：
 *   A. 纯函数真实实现执行（strip-types import `src/lib/mindmap.ts`，零依赖）——
 *      判别 / 解析 / 导出 / 布局，不复刻逻辑。
 *   B. 主进程落点契约（`writeMindmap`：slug 白名单 / 重名递增 / 落 mindmaps/）。
 *   C. 接线静态断言（工具注册 / 分派分支 / IPC 清单），防「加了口子忘了接线」。
 *
 * 运行（项目根目录）：
 *   node .AGENT/scripts/ai-teaching/verify-mindmap.mjs [仓库路径]
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------- A. 纯函数真实实现
const PURE_REL = 'src/lib/mindmap.ts'
const pureSrc = read(PURE_REL)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-verify-'))
const tmpFile = path.join(tmpDir, 'mindmap.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))
const {
  parseMindmap, looksLikeMindMap, countNodes, treeToList, treeToMermaid, treeToMarkdown, layoutTree,
  assignIds, findNode, findParent, isDescendant, addChildNode, removeNode, moveNode, serializeMindmap,
} = await import(pathToFileURL(tmpFile).href)

const SAMPLE = {
  kind: 'mindmap',
  version: 1,
  title: '二叉树遍历',
  root: {
    text: '二叉树遍历',
    children: [
      { text: '深度优先 DFS', children: [
        { text: '前序：根→左→右', ref: '算法/二叉树遍历.md' },
        { text: '中序：左→根→右' },
      ] },
      { text: '广度优先 BFS', children: [
        { text: '层序遍历（队列）', ref: '算法/二叉树遍历.md' },
      ] },
    ],
  },
}
const sampleText = JSON.stringify(SAMPLE)

console.log('\n=== 1. 判别与解析（按内容识别） ===')
check('looksLikeMindMap(合法) === true', looksLikeMindMap(sampleText) === true)
check('looksLikeMindMap(空串) === false', looksLikeMindMap('') === false)
check('looksLikeMindMap(普通 JSON) === false', looksLikeMindMap('{"a":1}') === false)
check('looksLikeMindMap(非 JSON) === false', looksLikeMindMap('not json') === false)
check('looksLikeMindMap(缺 kind) === false', looksLikeMindMap('{"root":{"text":"x"}}') === false)
check('looksLikeMindMap(缺 root.text) === false', looksLikeMindMap('{"kind":"mindmap","root":{}}') === false)
const parsed = parseMindmap(sampleText)
check('parseMindmap 返回结构', !!parsed && parsed.kind === 'mindmap' && parsed.root.text === '二叉树遍历')
check('parseMindmap title 兜底 = root.text', (() => {
  const p = parseMindmap('{"kind":"mindmap","root":{"text":"只有根"}}')
  return !!p && p.title === '只有根'
})())

console.log('\n=== 2. 导出（多级列表 + Mermaid） ===')
check('countNodes 计数', countNodes(SAMPLE.root) === 6)
const list = treeToList(SAMPLE.root)
check('列表：根行', list.startsWith('- 二叉树遍历'))
check('列表：带 ref 渲染为链接', list.includes('[前序：根→左→右](算法/二叉树遍历.md)'))
check('列表：缩进两级存在', list.includes('\n    - ') || list.includes('\n      - '))
const mer = treeToMermaid(SAMPLE.root)
check('mermaid：根用 root((…))', mer.split('\n')[0].trim() === 'root((二叉树遍历))')
check('mermaid：首行缩进两空格', mer.startsWith('  root(('))
check('mermaid：子行缩进四空格', /\n {4}深度优先 DFS/.test(mer))
const md = treeToMarkdown(SAMPLE)
check('markdown：含标题', md.startsWith('# 二叉树遍历'))
check('markdown：含 mermaid 围栏', md.includes('```mermaid\nmindmap\n'))
check('markdown：含大纲段', md.includes('## 大纲'))
check('markdown：围栏成对', (md.match(/```/g) ?? []).length === 2)

console.log('\n=== 3. 布局（左→右 tidy 树） ===')
const lay = layoutTree(SAMPLE.root)
check('布局：节点数 = 6', lay.nodes.length === 6)
check('布局：边数 = 5', lay.edges.length === 5)
check('布局：根 depth=0 x 最小', lay.nodes[0].depth === 0 && lay.nodes[0].x === Math.min(...lay.nodes.map(n => n.x)))
check('布局：同深 x 相同', (() => {
  const d1 = lay.nodes.filter(n => n.depth === 1).map(n => n.x)
  return d1.length === 2 && d1.every(x => x === d1[0])
})())
check('布局：父 y = 首末子 y 中值', (() => {
  const root = lay.nodes[0]
  const kids = lay.nodes.filter(n => n.depth === 1)
  const mid = (kids[0].y + kids[kids.length - 1].y) / 2
  return Math.abs(root.y - mid) < 0.001
})())
check('布局：无负坐标', lay.nodes.every(n => n.x >= 0 && n.y >= 0))
check('布局：width/height 覆盖全部节点', lay.width > Math.max(...lay.nodes.map(n => n.x)) && lay.height > Math.max(...lay.nodes.map(n => n.y)))

console.log('\n=== 4. 布局 · 折叠（不展开子树） ===')
const folded = JSON.parse(JSON.stringify(SAMPLE))
folded.root.children[0].collapsed = true
const lay2 = layoutTree(folded.root)
check('折叠 DFS → 节点数 = 4（1+1+2）', lay2.nodes.length === 4)
check('折叠 DFS → 其子节点不出现', !lay2.nodes.some(n => n.node.text === '中序：左→根→右'))

// ---------------------------------------------------------------- B/C. 接线静态断言
console.log('\n=== 5. 接线静态断言（防「加了口子忘了接线」） ===')
const srcSources = read('electron/lib/aiTeachingSources.ts')
check('writeMindmap 已定义', /export function writeMindmap\(/.test(srcSources))
check('writeMindmap 落 mindmaps/', srcSources.includes("'mindmaps'"))
check('writeMindmap 复用 parseMindmap（单一判据）', srcSources.includes('parseMindmap'))
const srcTools = read('electron/lib/builtinTools.ts')
check("注册了 mindmap 工具", /name: 'mindmap'/.test(srcTools))
check('mindmap 工具 tier=ondemand', /name: 'mindmap'[\s\S]{0,2000}tier: 'ondemand'/.test(srcTools))
check('tool.request 清单含 mindmap', /terminal\.exec \/ mindmap/.test(srcTools))
const srcLoop = read('electron/lib/agentLoopPolicy.ts')
check('agentLoopPolicy 串行名单含 mindmap', srcLoop.includes("!== 'mindmap'"))
const srcCC = read('src/lib/chatCommands.ts')
check('/mindmap 在 aiTeaching 面放行（return false）', /name === 'mindmap' && ctx\.surface === 'aiTeaching'/.test(srcCC))
const srcAP = read('src/modules/ai-teaching/ArtifactsPane.tsx')
check('ArtifactsPane 渲染 MindMapView', srcAP.includes('MindMapView'))
const srcAI = read('src/modules/ai-teaching/index.tsx')
check('AI 教学 openArtFile 按内容识别导图', srcAI.includes('looksLikeMindMap'))
check('AI 教学斜杠注入 /mindmap', srcAI.includes('MINDMAP_SLASH_ITEM'))
const srcPE = read('src/modules/knowledge/components/PageEditor.tsx')
check('PageEditor 渲染 MindMapView', srcPE.includes('MindMapView') && srcPE.includes('isMindMapFile'))
const srcMP = read('src/components/shared/MarkdownPreview.tsx')
check('MarkdownPreview 接线 mermaid', srcMP.includes('MermaidBlock') && srcMP.includes("fenceLang === 'mermaid'"))
const srcPkg = read('package.json')
check('package.json 含 mermaid 依赖', /"mermaid"/.test(srcPkg))
const srcMMV = read('src/components/shared/MindMapView.tsx')
check('MindMapView 复用共享 layoutTree', srcMMV.includes('layoutTree'))
check('MindMapView 导出复用 treeToMarkdown', srcMMV.includes('treeToMarkdown'))

// ---------------------------------------------------------------- 6. 树编辑纯函数（Phase 2）
console.log('\n=== 6. 树编辑纯函数（Phase 2） ===')
const clone = (o) => JSON.parse(JSON.stringify(o))
const fresh = () => { const d = clone(SAMPLE); assignIds(d.root); return d }
{
  const d = fresh()
  const rootId = d.root._id
  const dfs = d.root.children[0]
  const bfs = d.root.children[1]
  check('assignIds 全树都有 id', (() => { let ok = true; const walk = n => { if (!n._id) ok = false; (n.children ?? []).forEach(walk) }; walk(d.root); return ok })())
  check('findNode 命中', findNode(d.root, dfs._id) === dfs)
  const loc = findParent(d.root, dfs.children[0]._id)
  check('findParent 正确（父 + 下标）', !!loc && loc.parent === dfs && loc.index === 0)
  check('findParent 根 → parent=null', findParent(d.root, rootId)?.parent === null)
  check('isDescendant 自身子树 true', isDescendant(d.root, dfs._id, dfs.children[1]._id) === true)
  check('isDescendant 跨分支 false', isDescendant(d.root, dfs._id, bfs._id) === false)

  const created = addChildNode(dfs, '新增')
  check('addChildNode 追加到末尾', dfs.children.length === 3 && dfs.children[2] === created && !!created._id)
  check('removeNode 叶子成功', removeNode(d.root, created._id) === true && dfs.children.length === 2)
  check('removeNode 根被拒', removeNode(d.root, rootId) === false && d.root.text === '二叉树遍历')

  check('moveNode child：重挂', moveNode(d.root, bfs._id, dfs._id, 'child') === true && dfs.children.includes(bfs) && !d.root.children.includes(bfs))
  const leafA = dfs.children[0]
  const leafB = dfs.children[1]
  check('moveNode before：插到前', moveNode(d.root, leafB._id, leafA._id, 'before') === true && dfs.children.indexOf(leafB) < dfs.children.indexOf(leafA))
  check('moveNode after：插到后', moveNode(d.root, leafB._id, leafA._id, 'after') === true && dfs.children.indexOf(leafB) > dfs.children.indexOf(leafA))
  check('moveNode 防环（拖进自身子孙）', moveNode(d.root, dfs._id, leafA._id, 'child') === false)
  check('moveNode 拖到自身被拒', moveNode(d.root, leafA._id, leafA._id, 'child') === false)

  d.root.children[0].collapsed = true
  const s = serializeMindmap(d)
  check('serialize 保留 kind:"mindmap"', JSON.parse(s).kind === 'mindmap')
  check('serialize 剥离运行时 _id / collapsed', !s.includes('_id') && !s.includes('collapsed'))
  check('serialize 往返可被 parseMindmap 识别', looksLikeMindMap(s) === true)
}

// ---------------------------------------------------------------- 7. 双链接入（导图可被关联跳转）
console.log('\n=== 7. 双链接入（导图可被关联跳转） ===')
const srcIdx = read('electron/lib/kbStore/knowledgeIndex.ts')
check('索引读导图 JSON title + 标 isMindmap', srcIdx.includes('parseMindmap') && srcIdx.includes('isMindmap'))
check('索引 schema 已 bump 到 7', /KNOWLEDGE_INDEX_SCHEMA_VERSION = 7/.test(srcIdx))
const srcGraph = read('electron/lib/kbStore/graphIndex.ts')
check('图谱 graphPages 含 isMindmap（导图进图）', /entryKind !== 'file' \|\| e\.isMindmap/.test(srcGraph))
check('mindmap 工具 ref 说明允许导图 .json', srcTools.includes('另一张思维导图'))
check('mindmapHint ref 说明允许导图 .json', read('electron/lib/agentService.ts').includes('另一张思维导图'))

// ---------------------------------------------------------------- 8. 关联网络面板重构
console.log('\n=== 8. 关联网络面板（引用/被引用 + 定位高亮） ===')
const srcRepo = read('electron/lib/kbStore/knowledgeVaultRepo.ts')
check('反链 DTO 含 linkText + path', /VaultBacklinkContextItem\b[\s\S]{0,400}linkText: string[\s\S]{0,200}path: string/.test(srcRepo))
const srcPE2 = read('src/modules/knowledge/components/PageEditor.tsx')
check('面板含「引用」节', srcPE2.includes('引用 · '))
check('面板含「被引用」节', srcPE2.includes('被引用 · '))
check('已移除「相关笔记」节', !srcPE2.includes('相关笔记 · '))
check('引用条目点击 → locateWiki', /onClick=\{\(\) => locateWiki\(/.test(srcPE2))
check('被引用条目 → pendingLocate + onNavigate', srcPE2.includes('setPendingLocate(') && /pendingLocate\.relPath/.test(srcPE2))
const srcMDP2 = read('src/components/shared/MarkdownPreview.tsx')
check('wiki span 带 data-wiki 定位锚', srcMDP2.includes('data-wiki={display}'))
check('高亮样式 .kb-wiki-flash 存在', read('src/styles/index.css').includes('.kb-wiki-flash'))

// ---------------------------------------------------------------- 汇总
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass || !c.detail ? '' : '  —— ' + c.detail}`)
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}  ${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
