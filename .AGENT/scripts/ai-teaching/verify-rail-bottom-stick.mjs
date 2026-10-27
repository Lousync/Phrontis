/**
 * 契约验证：AI 教学左栏「资源管理器」贴底（对标 VS Code，方案见 docs/ui-animation-plan.md §M）。
 *
 * 为什么需要它：这件事**全部靠 CSS 成立**，而 CSS 挂掉的方式全是静默的 ——
 *   轨道类型一改就退化成离散跳变（动画没了，不报错）；
 *   align-content 丢了、容器没有定高、overflow-hidden 加上去（裁掉浮层）都不报错。
 * 所以这里把「让贴底成立的几条结构不变量」钉住。
 *
 * 用法（仓库根）：node .AGENT/scripts/ai-teaching/verify-rail-bottom-stick.mjs [仓库路径]
 * 全部 PASS 时 exit=0。输出纯 ASCII 标记，禁 emoji。
 */
import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const CSS_REL = 'src/styles/index.css'
const TSX_REL = 'src/modules/ai-teaching/index.tsx'

const cssRaw = read(CSS_REL)
const css = stripComments(cssRaw)
const tsx = stripComments(read(TSX_REL))

/** 取第一条 .kb-rail-secs 规则的声明体 */
const ruleBody = (src, selector) => {
  const i = src.indexOf(selector)
  if (i < 0) return null
  const open = src.indexOf('{', i)
  const close = src.indexOf('}', open)
  if (open < 0 || close < 0) return null
  return src.slice(open + 1, close)
}
const decl = (body, prop) => {
  if (!body) return null
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`, 'i').exec(body)
  return m ? m[1].trim() : null
}

// ---------------------------------------------------------------- 1. CSS 基建
console.log('\n=== 1. .kb-rail-secs 基建（index.css）===')
const base = ruleBody(css, '.kb-rail-secs {')
check('.kb-rail-secs 规则存在', base !== null, '')
check('display: grid', decl(base, 'display') === 'grid', String(decl(base, 'display')))
// 容器必须有确定高度，否则 align-content 没有剩余空间可分（原型阶段踩过：这行一漏，贴底整个失效）
check('min-height: 0（可在 flex 列里收缩）', decl(base, 'min-height') === '0', String(decl(base, 'min-height')))
check('flex: 1 1 0（撑满侧栏剩余 = 定高前提）', /^1\s+1\s+0$/.test(String(decl(base, 'flex'))), String(decl(base, 'flex')))
// overflow-hidden 会裁掉分区头里的绝对定位下拉菜单（「新建对话」）
const baseOverflow = decl(base, 'overflow')
check('容器未设 overflow:hidden（否则裁掉「新建对话」浮层）', baseOverflow === null || baseOverflow === 'visible', String(baseOverflow))

const baseTracks = String(decl(base, 'grid-template-rows')).split(/\s+/)
check('基础模板 4 轨 = max-content auto max-content 0fr',
  baseTracks.join(' ') === 'max-content auto max-content 0fr', baseTracks.join(' '))
// 基础态（课程收起）第 2 轨为 auto；课程展开时由 .kb-course-open 改为 1fr 优先分配高度
check('基础态第 2 轨 = auto', baseTracks[1] === 'auto', baseTracks[1])

const trans = String(decl(base, 'transition'))
check('过渡属性只有 grid-template-rows', /^grid-template-rows\b/.test(trans) && !/flex-grow/.test(trans), trans)

const stick = ruleBody(css, '.kb-rail-secs.kb-stick')
check('.kb-stick 用 align-content:normal(=stretch) 分配剩余高度',
  String(decl(stick, 'align-content')).toLowerCase() === 'normal', String(decl(stick, 'align-content')))
check('.kb-stick 不改轨道模板（贴底只换分配方式）', decl(stick, 'grid-template-rows') === null, String(decl(stick, 'grid-template-rows')))

const openExpl = ruleBody(css, '.kb-rail-secs.kb-open-explorer')
const openTracks = String(decl(openExpl, 'grid-template-rows')).split(/\s+/)
check('课程收起 + 资源管理器展开：第 4 轨 = 1fr', openTracks[3] === '1fr', openTracks.join(' '))

const courseOpen = ruleBody(css, '.kb-rail-secs.kb-course-open {')
const courseOpenRows = String(decl(courseOpen, 'grid-template-rows'))
check('课程展开：第 2 轨 = minmax(0, 1fr)（课程优先吃剩余高度）',
  courseOpenRows.includes('minmax(0, 1fr)'), courseOpenRows)

const courseOpenExpl = ruleBody(css, '.kb-rail-secs.kb-course-open.kb-open-explorer')
const courseOpenExplRows = String(decl(courseOpenExpl, 'grid-template-rows'))
check('课程展开 + 资源管理器展开：课程 1fr、资源管理器最多 32vh',
  courseOpenExplRows.includes('minmax(0, 1fr)') && courseOpenExplRows.includes('minmax(120px, 32vh)'),
  courseOpenExplRows)

const rmBlock = css.slice(css.indexOf('prefers-reduced-motion'))
check('有 prefers-reduced-motion 兜底', /\.kb-rail-secs\s*\{[^}]*transition:\s*none/.test(rmBlock), '')

// ---------------------------------------------------------------- 2. index.tsx 接线
console.log('\n=== 2. 左栏接线（index.tsx）===')
const iOpen = tsx.indexOf('kb-rail-secs')
check('左栏用 kb-rail-secs 承载两分区', iOpen > 0, '')
check('贴底态条件 = 会话展开 且 资源管理器收起',
  /\$\{!collapsedSec\.sessions && collapsedSec\.explorer \? 'kb-stick' : ''\}/.test(tsx), '')
check('展开态条件 = 资源管理器展开',
  /\$\{!collapsedSec\.explorer \? 'kb-open-explorer' : ''\}/.test(tsx), '')
check('会话体折叠走既有 .kb-collapse（不占外层轨）',
  /className=\{`kb-collapse min-h-0 \$\{collapsedSec\.sessions \? '' : 'open'\}`\}/.test(tsx), '')

// 两个分区头都必须在容器内（否则被撑高的是空气，条目不会下移）
const iClose = tsx.indexOf('</ResizablePanel>', iOpen)
const seg = tsx.slice(iOpen, iClose)
const headSessions = seg.indexOf('title="课程"')
const headExplorer = seg.indexOf('title="资源管理器"')
check('两个分区头都在容器内', headSessions > 0 && headExplorer > headSessions, `sessions@${headSessions} explorer@${headExplorer}`)
check('资源管理器体在资源管理器头之后（第 4 轨）', seg.indexOf('AiTeachFileTree') > headExplorer, '')

// 旧实现残留：flex-grow 过渡 / grow basis-0 / 内层自带 gridTemplateRows
check('已移除 flex-grow 过渡（布局属性，越出允许集）', !/transition-\[flex-grow/.test(tsx) && !/flex-grow/.test(seg), '')
check('已移除 grow basis-0 写法', !/grow basis-0/.test(seg), '')
const inlineRows = seg.match(/gridTemplateRows/g) || []
check('左栏内不再有内联 gridTemplateRows（高度全由 CSS 轨给出）', inlineRows.length === 0, String(inlineRows.length))
check('课程体高度由 CSS 轨给出（不再内联 38vh 上限）',
  !/max-h-\[38vh\]|h-\[38vh\]/.test(seg) && seg.includes('className="h-full min-h-0"'), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)
process.exit(failed.length === 0 ? 0 : 1)
