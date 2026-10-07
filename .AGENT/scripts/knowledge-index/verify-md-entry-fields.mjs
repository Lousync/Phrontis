// 契约验证：md 条目的 id / title / fileType 缺省补全（B-4 回归防线）。
//
// 背景（B-4）：`fileType` 的补全曾被写在「无 frontmatter id」的 auto 兜底分支里，
// 结果**应用内正式新建的页（有 id）反而没有 fileType**（旧 vaultCreatePage 从不写），
// 而渲染层所有严格 `=== 'md'` 的分支（左栏大纲按钮 / 沉浸阅读 / AI 续写）全部静默失效，
// 界面看着一切正常 —— 这类「悄悄少几处功能」的 bug 没有断言就必然复发。
//
// 覆盖：
//   ① normalizeMdEntryFields 纯函数用例（有 id / 无 id / 显式 fileType / 边界路径）
//   ② 负向：补全只认空串与缺失，不覆盖显式值（外部工具可能写别的类型）
//   ③ 源码断言：索引的 .md 分支**无条件**调用补全，且**不得**再出现分支内的 fileType 直写
//   ④ 写入侧：vaultCreatePage 真把 fileType 写进 frontmatter（不再是陷阱参数）
//   ⑤ 缓存失效杠杆：schemaVersion 已随语义变更 bump，且校验点读同一常量（不是散落的字面量）
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/knowledge-index/verify-md-entry-fields.mjs

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// ===== ① normalizeMdEntryFields 纯函数用例 =====
console.log('\n--- ① normalizeMdEntryFields：缺省补全 ---')
const { normalizeMdEntryFields } = await import('../../../electron/lib/kbStore/mdEntryFields.ts')

/** 造一条 frontmatter 并跑补全；返回补全后的对象 */
const run = (fm, rel) => { const o = { ...fm }; normalizeMdEntryFields(o, rel); return o }

// ★ 本 bug 的核心场景：应用内正式新建 / 导入的页 —— 有 id、title，但**没有** fileType
const formal = run({ id: 'uuid-1', title: '死锁', tags: ['os'], status: 'published' }, '408 学习空间/操作系统/死锁.md')
check('★ 有 id 无 fileType → 补成 md（B-4 主场景）', formal.fileType === 'md', String(formal.fileType))
check('已有 id 不被改写', formal.id === 'uuid-1')
check('已有 title 不被改写', formal.title === '死锁')
check('其余字段原样保留', Array.isArray(formal.tags) && formal.tags[0] === 'os' && formal.status === 'published')

// 无 id：身份统一（2026-09-20 拍板）—— auto:<relPath> + 文件名兜 title
const auto = run({}, 'notes/深度学习.md')
check('无 id → auto:<relPath>', auto.id === 'auto:notes/深度学习.md', auto.id)
check('无 title → 文件名去扩展名', auto.title === '深度学习', auto.title)
check('无 id 无 fileType → 同样补成 md', auto.fileType === 'md')

// 无扩展名 / 点在目录名里的边界
const noExt = run({}, 'dir.with.dots/README')
check('无扩展名的文件名 → title 原样不截', noExt.title === 'README', noExt.title)
check('目录名里的点不参与分割', run({}, 'a.b/c.md').title === 'c', run({}, 'a.b/c.md').title)

// ② 负向：显式值优先，只填空串与缺失
const explicit = run({ id: 'u2', fileType: 'txt' }, 'x.md')
check('② 显式 fileType 被尊重（不覆盖）', explicit.fileType === 'txt', explicit.fileType)
check('② 空串 fileType → 视为缺失并补 md', run({ id: 'u3', fileType: '' }, 'x.md').fileType === 'md')
check('② 全空白串按 asString 口径视为有值（不补，与旧实现一致）', run({ id: 'u4', fileType: '   ' }, 'x.md').fileType === '   ')
check('② 已有 id 时不动 title（即便缺失）', run({ id: 'u5' }, 'x.md').title === undefined)
check('② fileType 为 null → 补 md', run({ id: 'u6', fileType: null }, 'x.md').fileType === 'md')
check('② 非字符串 fileType（数字）→ 按 asString 口径视为有值，不覆盖', run({ id: 'u7', fileType: 7 }, 'x.md').fileType === 7)
check('② 幂等：跑两遍结果一致', JSON.stringify(run(run({ id: 'u8' }, 'k/a.md'), 'k/a.md')) === JSON.stringify(run({ id: 'u8' }, 'k/a.md')))

// ===== ③ 索引侧：无条件调用，且不再有分支内的 fileType 直写 =====
console.log('\n--- ③ knowledgeIndex：单一解析点 ---')
const idxSrc = stripComments(read('electron/lib/kbStore/knowledgeIndex.ts'))
check('索引的 .md 分支调用了 normalizeMdEntryFields', idxSrc.includes('normalizeMdEntryFields(doc.frontmatter, rel)'))
check('★ 索引内不再直写 frontmatter.fileType（兜底已收口到纯函数）', !/frontmatter\.fileType\s*=/.test(idxSrc))
check('★ 索引内不再直写 frontmatter.id（同上）', !/frontmatter\.id\s*=/.test(idxSrc))
// 欢迎页分支合成字段（fileType: 'html'）是独立条目形态，不受 md 补全影响 —— 保持原生对象字面量
check('欢迎页合成条目仍是 html 类型（未被 md 补全波及）', /fileType:\s*'html'/.test(idxSrc))
check('索引 import 了补全函数', /from '\.\/mdEntryFields'/.test(idxSrc))

// ④ 写入侧：vaultCreatePage 不再是「陷阱参数」
console.log('\n--- ④ vaultCreatePage：fileType 真写进 frontmatter ---')
const repo = stripComments(read('electron/lib/kbStore/knowledgeVaultRepo.ts'))
check('④ 建页 fm 含 fileType 且缺省 md', /fileType:\s*data\.fileType\s*\|\|\s*'md'/.test(repo))
check('④ 更新路径同样写 fileType（建页与更新口径对齐）', /if \(payload\.fileType\) fm\.fileType = payload\.fileType/.test(repo))

// ⑤ 缓存失效杠杆
console.log('\n--- ⑤ 索引缓存：bump 后校验点同源 ---')
check('⑤ schemaVersion 已抬到 6（语义变更须 bump）', /KNOWLEDGE_INDEX_SCHEMA_VERSION = 6/.test(idxSrc))
check('⑤ 接口声明读同一常量（不是散落字面量）', /schemaVersion:\s*typeof KNOWLEDGE_INDEX_SCHEMA_VERSION/.test(idxSrc))
check('⑤ 两处返回值读同一常量', (idxSrc.match(/schemaVersion:\s*KNOWLEDGE_INDEX_SCHEMA_VERSION/g) || []).length === 2)
check('⑤ 缓存校验点读同一常量', /cached\.schemaVersion === KNOWLEDGE_INDEX_SCHEMA_VERSION/.test(idxSrc))
check('⑤ 无遗留的 schemaVersion 字面量（5 或 6）', !/schemaVersion:\s*[56]\b/.test(idxSrc))

console.log(`\n${pass ? '✅ 全部通过' : '❌ 有失败项'}`)
process.exit(pass ? 0 : 1)
