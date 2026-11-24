#!/usr/bin/env node
/**
 * 契约验证：AI 教学重构 P0「产物命名」纯函数（`electron/lib/artifactNamePure.ts`）
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/Phrontis-AI教学-技术方案-2026-11-19.md` §2.4
 *       `/home/lousync/Projects/DesginProcess/Phrontis/方案与调研/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` §38.5
 *
 * 断言口径（全部跑真实实现，strip 类型后直接 import）：
 *   · 三种 scope 的命名形态 + 章段两位补零 + 缺省扩展名；
 *   · 标题非法字符清洗 / 首尾空白裁掉 / 超长截断（哈希后缀防撞名）；
 *   · build -> parse 往返（title 为清洗后形态）；
 *   · quiz 不可覆盖、其余可覆盖；
 *   · 排序锁定 `01-01 < 01-02 < 01 <章末复习> < 02 < 00<课程助手>`，不可解析项垫底。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-artifact-naming.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
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

const REL = 'electron/lib/artifactNamePure.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-naming-'))
const tmpFile = path.join(tmpDir, 'artifactNamePure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const {
  KIND_LABELS,
  DEFAULT_EXT_BY_KIND,
  buildArtifactName,
  parseArtifactName,
  sortKeyFor,
  isOverwriteKind,
} = await import(pathToFileURL(tmpFile).href)

const KINDS = ['handoff', 'note', 'lecture', 'quiz', 'review', 'visual', 'mindmap', 'image', 'knowledgecard', 'lessonplan']

console.log('\n=== 1. KIND_LABELS / DEFAULT_EXT_BY_KIND：十种产物全覆盖 ===')
check('10 种产物都有中文标签', KINDS.every((k) => typeof KIND_LABELS[k] === 'string' && KIND_LABELS[k].length > 0), JSON.stringify(KIND_LABELS))
check(
  '标签口径：交接 / 笔记 / 讲义 / 测验 / 复习 / 图 / 导图 / 图片 / 知识点卡 / 备课稿',
  KIND_LABELS.handoff === '交接' && KIND_LABELS.note === '笔记' && KIND_LABELS.lecture === '讲义'
    && KIND_LABELS.quiz === '测验' && KIND_LABELS.review === '复习' && KIND_LABELS.visual === '图'
    && KIND_LABELS.mindmap === '导图' && KIND_LABELS.image === '图片'
    && KIND_LABELS.knowledgecard === '知识点卡' && KIND_LABELS.lessonplan === '备课稿',
  JSON.stringify(KIND_LABELS),
)
check(
  '扩展名：md 类 .md / visual .html / mindmap .json / image .png',
  DEFAULT_EXT_BY_KIND.handoff === '.md' && DEFAULT_EXT_BY_KIND.note === '.md' && DEFAULT_EXT_BY_KIND.lecture === '.md'
    && DEFAULT_EXT_BY_KIND.quiz === '.md' && DEFAULT_EXT_BY_KIND.review === '.md' && DEFAULT_EXT_BY_KIND.knowledgecard === '.md'
    && DEFAULT_EXT_BY_KIND.lessonplan === '.md' && DEFAULT_EXT_BY_KIND.visual === '.html'
    && DEFAULT_EXT_BY_KIND.mindmap === '.json' && DEFAULT_EXT_BY_KIND.image === '.png',
  JSON.stringify(DEFAULT_EXT_BY_KIND),
)

console.log('\n=== 2. 三种 scope 的命名形态 ===')
check(
  '段：`01-01 讲义·进程调度.md`',
  buildArtifactName({ scope: 'segment', kind: 'lecture', chapterIndex: 1, segmentIndex: 1, title: '进程调度' }) === '01-01 讲义·进程调度.md',
  buildArtifactName({ scope: 'segment', kind: 'lecture', chapterIndex: 1, segmentIndex: 1, title: '进程调度' }),
)
check(
  '段无标题：`01-01 交接.md`',
  buildArtifactName({ scope: 'segment', kind: 'handoff', chapterIndex: 1, segmentIndex: 1 }) === '01-01 交接.md',
  buildArtifactName({ scope: 'segment', kind: 'handoff', chapterIndex: 1, segmentIndex: 1 }),
)
check(
  '章末复习：`02 章末复习·讲义.md`（忽略标题）',
  buildArtifactName({ scope: 'review', kind: 'lecture', chapterIndex: 2, title: '不该出现' }) === '02 章末复习·讲义.md',
  buildArtifactName({ scope: 'review', kind: 'lecture', chapterIndex: 2, title: '不该出现' }),
)
check(
  '课程助手：`00 课程助手·讲义·xxx.md`',
  buildArtifactName({ scope: 'assistant', kind: 'lecture', title: 'xxx' }) === '00 课程助手·讲义·xxx.md',
  buildArtifactName({ scope: 'assistant', kind: 'lecture', title: 'xxx' }),
)
check(
  '课程助手无标题：`00 课程助手·交接.md`',
  buildArtifactName({ scope: 'assistant', kind: 'handoff' }) === '00 课程助手·交接.md',
  buildArtifactName({ scope: 'assistant', kind: 'handoff' }),
)
check(
  '章段两位补零（3 / 12 -> 03-12）',
  buildArtifactName({ scope: 'segment', kind: 'quiz', chapterIndex: 3, segmentIndex: 12, title: '随堂' }) === '03-12 测验·随堂.md',
  buildArtifactName({ scope: 'segment', kind: 'quiz', chapterIndex: 3, segmentIndex: 12, title: '随堂' }),
)
check(
  '缺省章 / 段按 1 处理',
  buildArtifactName({ scope: 'segment', kind: 'lecture' }) === '01-01 讲义.md',
  buildArtifactName({ scope: 'segment', kind: 'lecture' }),
)

console.log('\n=== 3. 标题清洗 / 截断 / 扩展名 ===')
const ILLEGAL_TITLE = 'a/b\\c:d*e?f"g<h>i|j'
check(
  '非法字符 -> `_`（含 `|`）',
  buildArtifactName({ scope: 'segment', kind: 'lecture', chapterIndex: 1, segmentIndex: 1, title: ILLEGAL_TITLE }) === '01-01 讲义·a_b_c_d_e_f_g_h_i_j.md',
  buildArtifactName({ scope: 'segment', kind: 'lecture', chapterIndex: 1, segmentIndex: 1, title: ILLEGAL_TITLE }),
)
check(
  '首尾空白裁掉、内部空白折叠',
  buildArtifactName({ scope: 'segment', kind: 'lecture', chapterIndex: 1, segmentIndex: 1, title: '  进程   调度  ' }) === '01-01 讲义·进程 调度.md',
  buildArtifactName({ scope: 'segment', kind: 'lecture', chapterIndex: 1, segmentIndex: 1, title: '  进程   调度  ' }),
)
check(
  '控制字符 -> `_`',
  buildArtifactName({ scope: 'segment', kind: 'note', chapterIndex: 1, segmentIndex: 1, title: 'a\nb\tc' }) === '01-01 笔记·a_b_c.md',
  JSON.stringify(buildArtifactName({ scope: 'segment', kind: 'note', chapterIndex: 1, segmentIndex: 1, title: 'a\nb\tc' })),
)
check(
  '缺省扩展名取类型默认（图 .html / 导图 .json / 图片 .png）',
  buildArtifactName({ scope: 'segment', kind: 'visual', chapterIndex: 1, segmentIndex: 1, title: '进程状态' }) === '01-01 图·进程状态.html'
    && buildArtifactName({ scope: 'segment', kind: 'mindmap', chapterIndex: 1, segmentIndex: 1, title: '进程模型' }) === '01-01 导图·进程模型.json'
    && buildArtifactName({ scope: 'segment', kind: 'image', chapterIndex: 1, segmentIndex: 1, title: '时隙图' }) === '01-01 图片·时隙图.png',
  '',
)
check(
  '显式 ext 补点（`html` / `.JSON`）',
  buildArtifactName({ scope: 'segment', kind: 'lecture', chapterIndex: 1, segmentIndex: 1, title: 'x', ext: 'html' }) === '01-01 讲义·x.html'
    && buildArtifactName({ scope: 'segment', kind: 'lecture', chapterIndex: 1, segmentIndex: 1, title: 'x', ext: '.JSON' }) === '01-01 讲义·x.JSON',
  '',
)

const LONG_A = `${'a'.repeat(45)}-one`
const LONG_B = `${'a'.repeat(45)}-two`
const NAME_A = buildArtifactName({ scope: 'segment', kind: 'lecture', chapterIndex: 1, segmentIndex: 1, title: LONG_A })
const NAME_B = buildArtifactName({ scope: 'segment', kind: 'lecture', chapterIndex: 1, segmentIndex: 1, title: LONG_B })
const titleOf = (name) => parseArtifactName(name, 'lecture')?.title ?? ''
check('超长标题截断到 40 字以内', Array.from(titleOf(NAME_A)).length <= 40, `${Array.from(titleOf(NAME_A)).length} chars`)
check('同前缀超长标题不产生重复文件名（哈希后缀）', NAME_A !== NAME_B, `${NAME_A} vs ${NAME_B}`)
check('截断后标题不以空白结尾', !/\s$/.test(titleOf(NAME_A)), JSON.stringify(titleOf(NAME_A)))

console.log('\n=== 4. build -> parse 往返 ===')
const segInput = { scope: 'segment', kind: 'lecture', chapterIndex: 3, segmentIndex: 12, title: '进程/调度:入门' }
const segName = buildArtifactName(segInput)
const segParsed = parseArtifactName(segName, 'lecture')
check(
  '段往返：scope / 章 / 段 / ext / 清洗后 title 一致',
  segParsed && segParsed.scope === 'segment' && segParsed.chapterIndex === 3 && segParsed.segmentIndex === 12
    && segParsed.ext === '.md' && segParsed.title === '进程_调度_入门',
  JSON.stringify(segParsed),
)
const reviewParsed = parseArtifactName(buildArtifactName({ scope: 'review', kind: 'mindmap', chapterIndex: 4 }), 'mindmap')
check(
  '章末复习往返：chapterIndex 4 / ext .json / 无段号',
  reviewParsed && reviewParsed.scope === 'review' && reviewParsed.chapterIndex === 4
    && reviewParsed.segmentIndex === undefined && reviewParsed.ext === '.json',
  JSON.stringify(reviewParsed),
)
const assistParsed = parseArtifactName(buildArtifactName({ scope: 'assistant', kind: 'knowledgecard', title: '页表·要点' }), 'knowledgecard')
check(
  '课程助手往返：title 含 `·` 也能完整取回',
  assistParsed && assistParsed.scope === 'assistant' && assistParsed.title === '页表·要点' && assistParsed.ext === '.md',
  JSON.stringify(assistParsed),
)
check(
  '类型标签对不上 -> null（负向）',
  parseArtifactName('01-01 笔记·x.md', 'lecture') === null && parseArtifactName('随便一个.md', 'lecture') === null,
  '',
)
check(
  '路径形式入参只取文件名',
  parseArtifactName('AI教学/OS/产物/02-03 测验·随堂.md', 'quiz')?.segmentIndex === 3,
  '',
)

console.log('\n=== 5. 覆盖策略 ===')
check('quiz 不可原地覆盖（版本递增）', isOverwriteKind('quiz') === false, '')
check('其余 9 种可原地覆盖', KINDS.filter((k) => k !== 'quiz').every((k) => isOverwriteKind(k) === true), '')

console.log('\n=== 6. 排序键 ===')
const K_SEG1 = sortKeyFor({ rel: '产物/01-01 讲义·甲.md' })
const K_SEG2 = sortKeyFor({ rel: '产物/01-02 讲义·乙.md' })
const K_REVIEW1 = sortKeyFor({ rel: '产物/01 章末复习·讲义.md' })
const K_REVIEW2 = sortKeyFor({ rel: '产物/02 章末复习·讲义.md' })
const K_ASSIST = sortKeyFor({ rel: '产物/00 课程助手·讲义·丙.md' })
check('`01-01` < `01-02`', K_SEG1 < K_SEG2, `${K_SEG1} vs ${K_SEG2}`)
check('`01-02` < `01 章末复习`（章级排在段后）', K_SEG2 < K_REVIEW1, `${K_SEG2} vs ${K_REVIEW1}`)
check('`01 章末复习` < `02 章末复习`', K_REVIEW1 < K_REVIEW2, `${K_REVIEW1} vs ${K_REVIEW2}`)
check('`02` < `00 课程助手`（00 恒垫底）', K_REVIEW2 < K_ASSIST && K_ASSIST.startsWith('zz-'), `${K_REVIEW2} vs ${K_ASSIST}`)
check(
  '章号按数值排序（`10` 在 `02` 之后，不按字符串）',
  sortKeyFor({ rel: '产物/02-01 讲义·x.md' }) < sortKeyFor({ rel: '产物/10-01 讲义·x.md' }),
  `${sortKeyFor({ rel: '产物/02-01 讲义·x.md' })} vs ${sortKeyFor({ rel: '产物/10-01 讲义·x.md' })}`,
)
check(
  '解析不出前缀 -> `zz-zz-` 垫底',
  sortKeyFor({ rel: '产物/杂项.md' }).startsWith('zz-zz-') && K_REVIEW2 < sortKeyFor({ rel: '产物/杂项.md' }),
  sortKeyFor({ rel: '产物/杂项.md' }),
)

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
