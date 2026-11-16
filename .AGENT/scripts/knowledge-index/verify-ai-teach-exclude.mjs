// 契约：AI教学产物根 = 系统排除根（P0-D，2026-11-16 用户拍板）
//
// 背景：改造后的笔记区被 AI教学 下的运行时文件挤满（CONSTRAINTS / 交接 / 课程 / 教材 /
// 练习 / visuals 里的 html，一台真机 545 个文件里 151 个来自 AI教学 产物根）。
// 方案 A：整个产物根从**知识库读层**排除 —— 笔记流 / 主题 / 总览统计 / 搜索 / 图谱 /
// 反链 / quiz 全部不再出现；AI教学模块与文件树「软件文件」节照旧可看可开。
//
// 这条链路最安静的失败模式：
//   - 排除只做了一半（目录剪枝了、分类节点没隐藏）→ 笔记区里留一堆空分类；
//   - 排除用 `.ignore` 实现 → 用户写 `!AI教学` 就漏回来，且会跟用户规则混在一起；
//   - 目录名写死成「AI教学」→ 用户改「AI教学产物根目录」设置后失效（还不报错）；
//   - 磁盘缓存不带排除集 → 根改名后冷启动收养旧索引，新旧两边都错。
//
// 覆盖：
//   ① 真实索引构建：产物根整棵不收录（md / html / 锚点 / 全深度），分类节点一并隐藏；
//      前缀相近的「AI教学2」不受影响；
//   ② 用户 `.ignore` 的 `!AI教学` 不能恢复（分区边界语义）；写 `AI教学/` 也不误报未匹配；
//   ③ 根改名后排除集跟随（旧名恢复、新名排除），进程内缓存随之失效；
//   ④ 源码接线：主进程三处重灌（启动 / 设置 / 清空数据）、设置名从 rootDirName 取不写死、
//      扫描顺序在 `.ignore` 之前、结构视图接 softNames。
//
// 运行（项目根目录）：node .AGENT/scripts/knowledge-index/verify-ai-teach-exclude.mjs

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const CORE = join(ROOT, '..', 'phrontis-core')

// ── 夹具：一个含「个人笔记 + AI教学产物根」的最小仓库 ───────────────────────────
const base = mkdtempSync(join(ROOT, 'tmp', 'kb-ai-teach-exclude-'))
const vault = join(base, 'vault')
const userData = join(base, 'userdata')
const put = (rel, text = '正文') => {
  const abs = join(vault, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, text, 'utf-8')
}
const putMd = (rel, id, title = '') => put(rel, `---\nid: ${id}\ntitle: ${title || id}\n---\n\n正文条目 ${id}\n`)

mkdirSync(join(vault, '.knowbase'), { recursive: true })
mkdirSync(userData, { recursive: true })

putMd('笔记/个人.md', 'page-personal', '个人笔记')
putMd('AI教学/课程.md', 'page-course', '课程')
putMd('AI教学/课程/段1/交接.md', 'page-handoff', '交接')
putMd('AI教学/课程/段1/教材·X.md', 'page-textbook', '教材')
put('AI教学/课程/段1/.session.json', JSON.stringify({ sessionId: 's1', v: 1 }))
put('AI教学/visuals/a.html', '<html><body>visual</body></html>')
putMd('AI教学2/保留.md', 'page-keep', '前缀相近')
// 分类节点：旧版本为产物根建过（目录仍在盘上 → 不会被 stale 清理），必须在产出层隐藏
mkdirSync(join(vault, '.knowbase', 'modules', 'knowledge'), { recursive: true })
writeFileSync(join(vault, '.knowbase', 'modules', 'knowledge', 'categories.json'), JSON.stringify({
  'cat-ai': { id: 'cat-ai', name: 'AI教学', type: 'folder', path: 'AI教学' },
  'cat-ai-course': { id: 'cat-ai-course', name: '课程', parent: 'cat-ai', type: 'folder', path: 'AI教学/课程' },
  'cat-notes': { id: 'cat-notes', name: '笔记', type: 'folder', path: '笔记' },
}, null, 2), 'utf-8')

// ── 载入真实实现（vaultContext + knowledgeIndex 必须同一个模块实例）─────────────
const entryDir = join(base, 'entry')
mkdirSync(entryDir, { recursive: true })
const entry = join(entryDir, 'entry.ts')
writeFileSync(entry, [
  "export { configureCore, setCurrentVault } from '../../../../phrontis-core/src/kbStore/vaultContext'",
  "export { rebuildKnowledgeIndex, getKnowledgeIndex, invalidateKnowledgeIndex, setSystemExcludeRoots, getSystemExcludeRoots } from '../../../../phrontis-core/src/kbStore/knowledgeIndex'",
].join('\n'), 'utf-8')
const { mod: K } = await loadTsModule(entry)

K.configureCore({ userDataDir: userData })
K.setCurrentVault({ rootId: 'v1', name: 'vault', rootPath: vault })

const pathsOf = (idx) => idx.pages.map((p) => p.path).sort()
const has = (idx, p) => idx.pages.some((x) => x.path === p)

// ── ① 真实索引构建：整棵排除（md / html / 锚点 / 任意深度）──────────────────────
K.setSystemExcludeRoots(['AI教学'])
ok('排除集已注入', K.getSystemExcludeRoots().join(',') === 'AI教学')

let idx = K.rebuildKnowledgeIndex()
ok('个人笔记进索引', has(idx, '笔记/个人.md'))
ok('前缀相近的「AI教学2」不受影响', has(idx, 'AI教学2/保留.md'))
ok('产物根 md 整棵排除（根层课程.md）', !has(idx, 'AI教学/课程.md'))
ok('产物根 md 整棵排除（深层交接.md）', !has(idx, 'AI教学/课程/段1/交接.md'))
ok('产物根 md 整棵排除（教材·X.md）', !has(idx, 'AI教学/课程/段1/教材·X.md'))
ok('产物根 html 一并排除（visuals）', !has(idx, 'AI教学/visuals/a.html'))
ok('产物根锚点 .session.json 不收录', !idx.pages.some((p) => p.path.includes('.session.json')))
ok('索引页数 = 2（仅个人笔记 + 前缀相近）', idx.pages.length === 2, JSON.stringify(pathsOf(idx)))

const catPaths = idx.categories.map((c) => c.path).filter(Boolean)
ok('产物根分类节点从产出隐藏', !catPaths.some((p) => p === 'AI教学' || p.startsWith('AI教学/')))
ok('普通目录分类节点保留', catPaths.includes('笔记'))
ok('categories.json 仍保留全量（读层隐藏不改盘）',
  JSON.parse(readFileSync(join(vault, '.knowbase', 'modules', 'knowledge', 'categories.json'), 'utf-8'))['cat-ai']?.path === 'AI教学')

// ── ② .ignore 语义：`!` 救不回，而写 `AI教学/` 也不误报未匹配 ────────────────────
writeFileSync(join(vault, '.ignore'), '!AI教学\n', 'utf-8')
idx = K.rebuildKnowledgeIndex()
ok('用户 !AI教学 不能把产物根救回（分区边界，不可取反）', !has(idx, 'AI教学/课程.md'))
writeFileSync(join(vault, '.ignore'), 'AI教学/\n', 'utf-8')
idx = K.rebuildKnowledgeIndex()
ok('用户写 AI教学/ 正常算命中（不误报「未匹配到任何知识页」）',
  !idx.warnings.some((w) => w.includes('未匹配到任何知识页')), idx.warnings.join(' | '))
rmSync(join(vault, '.ignore'), { force: true })

// ── ③ 产物根改名：排除集跟随 + 进程内缓存失效 ──────────────────────────────────
K.setSystemExcludeRoots(['教学产物'])
idx = K.rebuildKnowledgeIndex()
ok('改名后旧名恢复可见', has(idx, 'AI教学/课程.md'))
ok('改名后新名整棵排除', !idx.pages.some((p) => p.path.startsWith('教学产物/')))

// 缓存对账：先让记忆化命中一次，再改排除集，下一次 getKnowledgeIndex 必须重读
K.setSystemExcludeRoots(['AI教学'])
let memo = K.getKnowledgeIndex()
ok('记忆化基线：旧名被排除', !has(memo, 'AI教学/课程.md'))
K.setSystemExcludeRoots([])
memo = K.getKnowledgeIndex()
ok('排除集清空后缓存已失效（产物根全部回来）', has(memo, 'AI教学/课程.md') && has(memo, 'AI教学/visuals/a.html'))
K.setSystemExcludeRoots(['AI教学'])

// ── ④ 源码接线 ────────────────────────────────────────────────────────────────
const read = (p) => readFileSync(join(ROOT, p), 'utf-8')
const coreIndex = read('../phrontis-core/src/kbStore/knowledgeIndex.ts')
const main = read('electron/main/index.ts')
const kbIndex = read('src/modules/knowledge/index.tsx')

ok('扫描顺序：系统排除在 .ignore 判定之前', (() => {
  const ex = coreIndex.indexOf('isSystemExcludedRel(relative(root, abs)')
  const ign = coreIndex.indexOf('if (ign) {', ex)
  return ex > 0 && ign > ex
})())
ok('排除集在 audit 收集之后（用户规则仍算命中）', (() => {
  const audit = coreIndex.indexOf('if (audit) {')
  const ex = coreIndex.indexOf('isSystemExcludedRel(relative(root, abs)')
  return audit > 0 && ex > audit
})())
ok('schema 已 bump（v9，旧缓存不得收养）', /KNOWLEDGE_INDEX_SCHEMA_VERSION = 9/.test(coreIndex))
ok('磁盘缓存带排除集', /systemExcludeRoots\?: string\[\]/.test(coreIndex))
ok('缓存收养校验排除集', /sameSystemExcludeRoots\(cached\.systemExcludeRoots/.test(coreIndex))
ok('核心库不写死目录名（只认注入，不认字面量）', !/['"]AI教学['"]/.test(coreIndex))

ok('主进程用 rootDirName 取设置名（不写死）',
  /function applyAiTeachIndexExclude\(\): void \{[\s\S]{0,300}?aiTeachRootDirName\(/.test(main))
ok('启动读完设置立即灌入', /settingsCache = loadSettingsFromDisk\(\)[\s\S]{0,200}?applyAiTeachIndexExclude\(\)/.test(main))
ok('改「AI教学产物根目录」后重灌（含改名迁移分支）',
  (main.match(/applyAiTeachIndexExclude\(\)/g) ?? []).length >= 3)
ok('清空所有数据重置后重灌',
  /settingsCache = \{\}[\s\S]{0,120}?applyAiTeachIndexExclude\(\)/.test(main))
ok('排除集变化广播 knowledge（笔记区重读）',
  /applyAiTeachIndexExclude[\s\S]{0,500}?broadcastDataChanged\('knowledge'\)/.test(main))

ok('结构视图接住 ws:listDir 的 softNames', /setTreeSoftNames\(res\.softNames \?\? \[\]\)/.test(kbIndex))
ok('结构视图把软件生成项交给 VaultTree', /softNames=\{treeSoftNames\}/.test(kbIndex))

report('verify-ai-teach-exclude')
rmSync(base, { recursive: true, force: true })
