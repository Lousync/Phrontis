#!/usr/bin/env node
/**
 * 契约脚本：条目 ⑯「Word（docx）素材转写无从下手 —— 登记表单不给页码区间入口」
 *
 * 缺陷形态是**接线缺失**，不是算法错：v3.1.2 条目5 让 docx 进了提取/转写链路
 * （主进程 aiTeachingSources.ts 两处放行都改了），**唯独漏了登记表单那一行类型守卫**，
 * 于是「怎么填区间」在上游从来没给，登记与「再加区间」两条路同时死循环。
 *
 * 所以本脚本查四件事：
 *   ① 区间类型清单是否收敛为单点真相源、旧的三类型守卫是否零残留（负向）；
 *   ② 上游前提是否仍在（主进程 docx 放行 + addSource 的 `-` 语义未被顺手改坏）；
 *   ③ 轻版 B 的入口化是否落成（两个按钮一律渲染、无区间点击走 openRangeEntry）；
 *   ④ 切片**真实** `inferSrcType` 执行，锁住「.docx/.doc 归 docx」这条前提
 *      —— 抄一份映射表正好会掩盖「清单飘了」这类缺陷，与 startup-tab 同一教训。
 *
 * 用法：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/ai-teaching/verify-docx-range-entry.mjs
 */
import { readFileSync } from 'node:fs'
import { AI_TEXT_CODE_EXT_SET } from '../../../src/lib/aiTextExts.ts'

const ROOT = 'E:/Projects/KnowledgeRecorder'
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); return true }
  fails.push(label + (detail ? `  → ${detail}` : ''))
  console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ''}`)
  return false
}
const count = (s, sub) => s.split(sub).length - 1

/**
 * 只剥注释、**保留字符串字面量** —— 本脚本的负向断言正是要匹配被删掉的文案字面量
 * （旧警告「先登记页码区间（编辑 SOURCE.md 或重新登记）」），把字符串一起剥了就什么都查不到。
 * 用状态机而不是正则：正则会被字符串里的 `//`（如 'https://…'）或模板串骗到。
 */
function stripComments(src) {
  let out = ''
  let st = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (st === 'code') {
      if (c === '/' && n === '/') { st = 'line'; i++; out += '  '; continue }
      if (c === '/' && n === '*') { st = 'block'; i++; out += '  '; continue }
      if (c === "'") st = 'sq'; else if (c === '"') st = 'dq'; else if (c === '`') st = 'tpl'
      out += c; continue
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out += c } else out += ' '; continue }
    if (st === 'block') { if (c === '*' && n === '/') { st = 'code'; i++; out += '  ' } else out += c === '\n' ? '\n' : ' '; continue }
    if (st === 'sq' || st === 'dq' || st === 'tpl') {
      if (c === '\\') { out += c + (n ?? ''); i++; continue }
      if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) st = 'code'
      out += c; continue
    }
  }
  return out
}

const rawTeach = read('src/modules/ai-teaching/index.tsx')
const rawSrc = read('electron/lib/aiTeachingSources.ts')
const teach = stripComments(rawTeach)        // 剥注释（保留字符串字面量）
const srcSide = stripComments(rawSrc)

/** 从源码取出 `const XXX = ['a','b'] as const` 的成员数组（读真实字面量，不照抄） */
function tupleMembers(code, name) {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(code)
  if (!m) return null
  return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1])
}

// ── ① 区间类型清单：单点真相源 + 旧守卫零残留 ───────────────────────────────
console.log('\n[① 类型清单] RANGE_TYPES / TRANSCRIBE_TYPES')
const rangeTypes = tupleMembers(teach, 'RANGE_TYPES')
const transcribeTypes = tupleMembers(teach, 'TRANSCRIBE_TYPES')
ok(rangeTypes !== null, 'RANGE_TYPES 常量存在（区间类清单唯一真相源）')
ok(JSON.stringify(rangeTypes) === JSON.stringify(['pdf', 'pptx', 'docx', 'code']),
  'RANGE_TYPES = pdf / pptx / docx / code（含 docx）', `实际 ${JSON.stringify(rangeTypes)}`)
ok(JSON.stringify(transcribeTypes) === JSON.stringify(['pdf', 'pptx', 'docx']),
  'TRANSCRIBE_TYPES = pdf / pptx / docx（code 无视觉页）', `实际 ${JSON.stringify(transcribeTypes)}`)
ok(!!transcribeTypes && transcribeTypes.every(t => (rangeTypes ?? []).includes(t)),
  'TRANSCRIBE_TYPES ⊆ RANGE_TYPES')
ok(count(teach, "RANGE_TYPES as readonly string[]).includes(detected)") === 1,
  '登记表单守卫由 RANGE_TYPES 判定（唯一 1 处）',
  `实际 ${count(teach, 'RANGE_TYPES as readonly string[]).includes(detected)')}`)
ok(count(teach, 'detected ===') === 0,
  '负向：旧的三类型字面量守卫（detected === …）零残留',
  `实际 ${count(teach, 'detected ===')} 处`)
ok(count(teach, "e.type === 'pdf'") === 0,
  '负向：卡片按钮不再各写一份类型字面量（e.type === \'pdf\' 零残留）',
  `实际 ${count(teach, "e.type === 'pdf'")}`)

// ── ② 上游前提：主进程放行 + addSource 写入口径 ──────────────────────────────
console.log('\n[② 上游前提] aiTeachingSources.ts')
ok(srcSide.includes("e.type !== 'pdf' && e.type !== 'pptx' && e.type !== 'docx' && e.type !== 'code'"),
  '区间提取放行含 docx（四类）')
ok(srcSide.includes("e.type !== 'pdf' && e.type !== 'pptx' && e.type !== 'docx'"),
  '视觉转写放行含 docx（三类）')
ok(srcSide.includes(": '-'"), 'addSource 空区间仍写 `-`（未登记语义未被顺手改坏）')
ok(srcSide.includes('docx: \'docx\', doc: \'docx\''), '扩展名 → 类型映射仍认 .docx / .doc')
ok(count(srcSide, 'export function addSource') === 1
  && !/export (async )?function (updateSource|editSource|setSourceRange|updateRange)/.test(srcSide),
  '未新增「改已有条目」API（轻版 B 拍板 = 新增一条，不就地改区间）')
ok(/const submitSrcForm = async[\s\S]{0,900}aiTeachSrcAdd\(/.test(teach),
  '补区间提交走新增 API（addSource）—— 无就地改区间的调用')
ok(!/aiTeachSrc(Update|Edit|Patch)Source/.test(teach),
  '负向：渲染层不存在「改已有条目」的调用')

// ── ③ 轻版 B：按钮一律渲染、无区间点击走补区间入口 ──────────────────────────
console.log('\n[③ 入口化] 提取 / 转写按钮分流')
ok(teach.includes('const canExtract = rangeType && !extMatch'),
  '提取按钮可见性只取决于类型 + 是否已有提取稿（不含区间有效性）')
ok(teach.includes('const rangeValid = hasValidRange(e.range)'), '区间有效性由 hasValidRange 单点判定')
ok(teach.includes("if (rangeValid) void doExtract(e.no); else openRangeEntry(e)"),
  '提取按钮：区间有效 → 提取，无效 → 打开补区间入口')
ok(teach.includes("if (rangeValid) void doTranscribe(e.no); else openRangeEntry(e)"),
  '转写按钮：区间有效 → 转写，无效 → 打开补区间入口（原「点了才被拒」路径消失）')
ok(!teach.includes('onClick={() => { void doExtract(e.no) }}') && !teach.includes('onClick={() => { void doTranscribe(e.no) }}'),
  '负向：两个按钮都不再是无条件直呼（旧的直呼写法零残留）')
ok(teach.includes("'该条目区间无效——点卡片上的「再加区间」补一条带区间的条目（或编辑 SOURCE.md 修正），再视觉转写'"),
  'doTranscribe 兜底文案指向补区间入口（不再让用户去手编 SOURCE.md）')
ok(!teach.includes('先登记页码区间（编辑 SOURCE.md 或重新登记）'),
  '负向：旧的无出路警告文案零残留')
ok(teach.includes("const openRangeEntry = (e: AiTeachSourceEntry) => setSrcForm({"),
  'openRangeEntry 定义存在（补区间唯一入口）')
ok(count(teach, 'openRangeEntry') === 4,
  'openRangeEntry = 1 处定义 + 3 处调用（提取 / 转写 / 再加区间）', `实际 ${count(teach, 'openRangeEntry')}`)
ok(teach.includes("storage: '仅引用', rangeFrom: '', rangeTo: '', note: '', needRange: true,"),
  '补区间入口预填「仅引用」（原件不重复拷贝，与 2026-09-08 语义一致）')

// ── ④ 表单侧：焦点、防呆、口径文案 ──────────────────────────────────────────
console.log('\n[④ 表单侧] 焦点 / 防呆 / 文案')
ok(teach.includes('autoFocus={!!srcForm.needRange}'), '起始页输入框在补区间态获得焦点')
ok(teach.includes('autoFocus={!srcForm.needRange}'), '名称输入框在补区间态让出 autoFocus（不同时抢焦点）')
ok(teach.includes('!!srcForm.needRange && !srcForm.rangeFrom.trim()'),
  '补区间态未填起始页时「确定登记」禁用（防空条目）')
ok(teach.includes('原条目还没登记区间：确定后为同一原件新增一条带区间的条目（原件不重复拷贝，原条目保留）'),
  '补区间态给出提交语义说明（新增一条，不是就地改）')

const metaAt = teach.indexOf('function rangeFieldMeta')
const meta = metaAt >= 0 ? teach.slice(metaAt, metaAt + 1200) : ''
ok(meta.length > 0, 'rangeFieldMeta 存在（label/占位/悬浮说明按类型分口径）')
ok(meta.includes("if (type === 'code')") && meta.includes("label: '行号'"),
  'code 仍是「行号」口径（不回归条目10）')
ok(meta.includes("if (type === 'docx')") && meta.includes('转成 PDF 后阅读器显示的页码'),
  'docx 口径 = 转 PDF 后的页（不是书页印刷页码）')
ok(meta.includes('LibreOffice 路径'), 'docx 口径带上「未装 LibreOffice 时在设置里指定路径」的引导')
ok(meta.includes("label: '页码'"), 'pdf / pptx 仍是「页码」口径（不回归既有行为）')

// ── ⑤ 区间正则：与 doTranscribe 解析共用同一份 ──────────────────────────────
console.log('\n[⑤ 区间判定] RANGE_RE 单点')
ok(count(teach, '^(\\d+)\\s*(?:-\\s*(\\d+))?$') === 1,
  '区间正则只此 1 处（定义在 RANGE_RE；「是否登记」与「解析起止页」共用）',
  `实际 ${count(teach, '^(\\d+)\\s*(?:-\\s*(\\d+))?$')}`)
ok(teach.includes('const rm = RANGE_RE.exec(e.range.trim())'), 'doTranscribe 用 RANGE_RE 解析区间')

// ── ⑥ 切片真实 inferSrcType 执行 ────────────────────────────────────────────
console.log('\n[⑥ 真实实现] inferSrcType（切片执行，非照抄）')
let inferSrcType = null
try {
  const at = rawTeach.indexOf('function inferSrcType')
  const end = rawTeach.indexOf('\n}', at)
  if (at >= 0 && end > at) {
    // 只剥这一处签名上的 TS 类型注解；函数体原样，依赖（代码扩展名集合）注入真实值
    const body = rawTeach.slice(at, end + 2)
      .replace('function inferSrcType(path: string): string {', 'function inferSrcType(path) {')
    // eslint-disable-next-line no-new-func
    inferSrcType = new Function('AI_TEXT_CODE_EXT_SET', `${body}\nreturn inferSrcType`)(AI_TEXT_CODE_EXT_SET)
  }
} catch { /* 落到下面的 fail */ }
if (ok(typeof inferSrcType === 'function', '切片取得真实 inferSrcType（失败则后续用例不计入）')) {
  const cases = [
    ['作业.docx', 'docx'], ['C:/x/材料.doc', 'docx'],
    ['课件.pdf', 'pdf'], ['幻灯片.pptx', 'pptx'],
    ['main.ts', 'code'], ['笔记.md', 'md'],
    ['https://example.com/a', 'url'], ['a.xyz', 'other'],
  ]
  for (const [input, want] of cases) {
    const got = inferSrcType(input)
    ok(got === want, `inferSrcType(${input}) = ${want}`, `实际 ${got}`)
  }
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — ${pass} 断言通过 / ${fails.length} 失败`)
if (fails.length) { console.log('\n失败项：'); for (const f of fails) console.log('  - ' + f) }
process.exitCode = fails.length ? 1 : 0
