#!/usr/bin/env node
/**
 * 契约验证：AI教学 · 素材注入的编号 + 引用纪律（`electron/lib/aiTeachingSourceRegistry.ts`
 * 的 `renderSourcesHint`）。
 *
 * 背景（2026-11-22）：旧 `electron/lib/aiTeachingSources.ts:resolveSourcesForInjection`
 * 里那套「行内标编号与页码 / 末尾附本次引用素材」纪律随链路切换掉了，现役只给素材清单。
 * 本脚本锁住回接后的三条硬口径：
 *   1. segment / review 有条目 → 条目按输出顺序 `[1] [2] …` 编号连续，且带引用纪律；
 *   2. 空清单 → 逐字退回改造前的文本（不出现引用纪律、不出现编号）——零噪音、prompt cache 不被打散；
 *   3. segment 的提取稿 / 未提取指引按条目现场出现（有提取稿才说「优先读提取稿」，
 *      有未提取才说「不要假装引用」），assistant 摘要角色不带规则、不带编号。
 *
 * 装载方式：把注册表模块的 import 全改成桩（`__mod(spec)`），保留函数本体后 import ——
 * `renderSourcesHint` 是纯格式化，不需要 electron / 仓库上下文。
 *
 * 运行（仓库根）：node .AGENT/scripts/ai-teaching/verify-source-citation.mjs [仓库路径]
 * 输出纯 ASCII（AGENTS.md：脚本禁用 emoji）；全部 PASS 且 exit=0。
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

const REGISTRY_REL = 'electron/lib/aiTeachingSourceRegistry.ts'
const COURSE_REL = 'electron/lib/aiTeachingCourse.ts'

// ---------------------------------------------------------------- 装载真实实现
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-citation-'))
fs.writeFileSync(path.join(tmpDir, 'stubs.mjs'), `
/** 任意 import 一律给一个恒等可调用的桩；renderSourcesHint 不触达任何外部 IO */
const generic = new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : generic),
  apply: () => undefined,
})
export function __mod() { return generic }
`)

const registrySrc = read(REGISTRY_REL)
const js = stripTypeScriptTypes(registrySrc, { mode: 'strip' })
const IMPORT_RE = /^import\s+([\s\S]*?)\s+from\s+'([^']+)';?[ \t]*$/gm
const leftovers = []
const rewritten = js.replace(IMPORT_RE, (whole, clause, spec) => {
  const c = clause.trim()
  if (/^type\b/.test(c)) return `/* type-only import: ${spec} */`
  const m = /^\{([\s\S]*)\}$/.exec(c)
  if (!m) { leftovers.push(whole); return whole }
  const names = m[1].split(',').map((s) => s.trim())
    .filter((s) => s && !/^type\s/.test(s))
    .map((s) => s.split(/\s+as\s+/)[0])
  return `const { ${names.join(', ')} } = __mod(${JSON.stringify(spec)})`
})
fs.writeFileSync(path.join(tmpDir, 'registry.mjs'), `${rewritten}\nimport { __mod } from './stubs.mjs'\n`)

console.log('\n=== 0. 装载（import 全桩化，函数本体是真身）===')
check('import 全部可机械改写（无默认 / 多行残留）', leftovers.length === 0, leftovers.join(' | '))
const mod = await import(pathToFileURL(path.join(tmpDir, 'registry.mjs')).href)
const { renderSourcesHint } = mod
check('renderSourcesHint 已导出且可调用', typeof renderSourcesHint === 'function', '')

const ITEM_EXACT = {
  title: '高等数学', type: 'pdf', path: 'SOURCES/高等数学.pdf', anchor: '第 1-30 页',
  extractPath: 'SOURCES/高等数学-p1-30.md', extractMatch: 'exact', pages: 300, chars: 12000,
}
const ITEM_MISSING = { title: 'lab.py', type: 'code', path: 'code/lab.py', anchor: '第 1-200 行', extractMatch: 'missing' }

console.log('\n=== 1. segment：有条目 → 引用纪律 + 连续编号 ===')
const seg = renderSourcesHint({ role: 'segment', items: [ITEM_EXACT, ITEM_MISSING] })
check('带「行内标注编号与页码/行号」规则', seg.includes('行内标注编号与页码/行号'), '')
check('带「本次引用素材」尾清单要求', seg.includes('本次引用素材'), '')
check('尾清单口径 = 只列实际用到的', seg.includes('只列实际用到的'), '')
check('带「没有用到素材的段落不要编造出处」', seg.includes('没有用到素材的段落不要编造出处'), '')
check('行内格式示例含 p.15', seg.includes('[1] p.15'), '')
check('code 行号格式示例含 [1] L120', seg.includes('[1] L120'), '')
check('网页素材引用格式有交代', seg.includes('网页写作 [1]'), '')
const segNums = [...seg.matchAll(/^- \[(\d+)\] /gm)].map((m) => Number(m[1]))
check('条目编号 = 输出顺序 1..N', JSON.stringify(segNums) === JSON.stringify([1, 2]), JSON.stringify(segNums))
check('编号按输入顺序（不按标题/类型重排）', /^- \[1\] 高等数学/m.test(seg) && /^- \[2\] lab\.py/m.test(seg), '')
check('编号从 1 起（无 [0]）', !/^- \[0\] /m.test(seg), '')
check('有提取稿的条目 → 优先读提取稿，仍标页码', seg.includes('有提取稿的条目优先读提取稿') && seg.includes('仍按原件标页码'), '')
check('有未提取条目 → 不要假装引用，先让用户提取', seg.includes('未提取的条目不要假装引用') && seg.includes('先让用户提取'), '')
check('条目自身的提取稿 / 未提取标注未被改口径', seg.includes('本章提取稿 SOURCES/高等数学-p1-30.md') && seg.includes('未提取（先 course.sources.extract 本段区间）'), '')

console.log('\n=== 2. segment：提取状态决定那两句（不掺进去无关噪音）===')
const segAllExact = renderSourcesHint({ role: 'segment', items: [ITEM_EXACT] })
check('全部有提取稿 → 不出现「不要假装引用」', !segAllExact.includes('不要假装引用'), '')
check('全部有提取稿 → 仍有「优先读提取稿」', segAllExact.includes('优先读提取稿'), '')
const segAllMissing = renderSourcesHint({ role: 'segment', items: [ITEM_MISSING] })
check('全部未提取 → 不出现「优先读提取稿」', !segAllMissing.includes('优先读提取稿'), '')
check('全部未提取 → 仍有「不要假装引用」', segAllMissing.includes('不要假装引用'), '')

console.log('\n=== 3. 空清单 / 摘要角色：逐字退回改造前文本（负向）===')
const SEG_EMPTY_EXPECTED = '【本段确认素材（只读这些，不要扫描 SOURCES 下未确认的文件）】\n（本段没有确认素材，按大纲讲；需要素材请先让用户在本章分配并开段确认）'
const segEmpty = renderSourcesHint({ role: 'segment', items: [] })
check('segment 空清单 = 改造前逐字文本', segEmpty === SEG_EMPTY_EXPECTED, JSON.stringify(segEmpty))
check('segment 空清单不出现引用纪律', !segEmpty.includes('本次引用素材') && !segEmpty.includes('行内标注编号'), '')
check('segment 空清单不出现编号', !/^- \[\d+\]/m.test(segEmpty), '')

const REVIEW_EMPTY_EXPECTED = '【本章素材（章级分配，复习用）】\n（本章没有分配素材，按已学知识点与各段交接复习）\n复习只围绕本章已学知识点；不要引入新知识点。'
const reviewEmpty = renderSourcesHint({ role: 'review', chapterSources: [] })
check('review 空清单 = 改造前逐字文本', reviewEmpty === REVIEW_EMPTY_EXPECTED, JSON.stringify(reviewEmpty))
check('review 空清单不出现引用纪律 / 编号', !reviewEmpty.includes('本次引用素材') && !/\[\d+\]/.test(reviewEmpty), '')

const ASSISTANT_EXPECTED = '【课程素材登记摘要（AI教学·课程助手）】\n已登记 3 条；已分配 2 条；未分配 1 条。\n素材登记走 course.sources.register；分章走 course.sources.assign。这里只给摘要，不要要求用户把整份素材贴进对话。'
const assistant = renderSourcesHint({ role: 'assistant', summary: '已登记 3 条；已分配 2 条；未分配 1 条。' })
check('assistant 摘要 = 改造前逐字文本（不编号不挂规则）', assistant === ASSISTANT_EXPECTED, JSON.stringify(assistant))
check('assistant 空摘要沿用旧占位', renderSourcesHint({ role: 'assistant' }) === ASSISTANT_EXPECTED.replace('已登记 3 条；已分配 2 条；未分配 1 条。', '（还没有登记素材）'), '')

console.log('\n=== 4. review：有条目 → 编号 + 同一套引用纪律 ===')
const review = renderSourcesHint({ role: 'review', chapterSources: ['高等数学（第 1-30 页）', '线性代数（整份）', '习题册（第 5-9 页）'] })
const reviewNums = [...review.matchAll(/^- \[(\d+)\] /gm)].map((m) => Number(m[1]))
check('review 条目编号连续 1..N', JSON.stringify(reviewNums) === JSON.stringify([1, 2, 3]), JSON.stringify(reviewNums))
check('review 带引用纪律', review.includes('本次引用素材') && review.includes('行内标注编号'), '')
check('review 不掺 segment 专属的提取稿指引', !review.includes('优先读提取稿') && !review.includes('不要假装引用'), '')
check('review 原有尾句保留', review.trimEnd().endsWith('复习只围绕本章已学知识点；不要引入新知识点。'), '')

console.log('\n=== 5. 稳定性（prompt cache）：纯函数 / 幂等 / 规则不被截断 ===')
const a1 = renderSourcesHint({ role: 'segment', items: [ITEM_EXACT, ITEM_MISSING] })
const a2 = renderSourcesHint({ role: 'segment', items: [{ ...ITEM_EXACT }, { ...ITEM_MISSING }] })
check('同输入两次输出逐字相同', a1 === a2, '')
check('第二条清单条目编号不随对象身份变化', a1.includes('- [2] lab.py'), '')
const many = renderSourcesHint({
  role: 'segment',
  items: Array.from({ length: 40 }, (_, i) => ({ ...ITEM_MISSING, title: `素材${i + 1}-${'很长的标题'.repeat(6)}` })),
  maxChars: 400,
})
check('清单过长被截断', many.includes('素材清单过长已截断'), '')
check('截断后引用纪律仍在（规则在条目之前）', many.includes('本次引用素材') && many.includes('不要假装引用'), '')
const numbered = many.split('\n').filter((l) => /^- \[\d+\] /.test(l)).map((l) => Number(/^- \[(\d+)\] /.exec(l)[1]))
check('截断后留下的编号仍是前缀连续 1..k', numbered.every((n, i) => n === i + 1) && numbered.length > 0, JSON.stringify(numbered))

// 2026-11-23：截断按 code point 切，不能把 emoji 的代理对劈成半个字符
const hasLoneSurrogate = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}
let emojiSplit = 0
for (let pad = 0; pad < 24; pad++) {
  const out = renderSourcesHint({
    role: 'segment',
    items: [{ ...ITEM_MISSING, title: '前缀'.repeat(pad) + '😀'.repeat(240) }],
    maxChars: 400,
  })
  if (hasLoneSurrogate(out)) emojiSplit++
}
check('★ emoji 边界：清单截断不产生半个代理对（24 组前缀位置）', emojiSplit === 0, `split=${emojiSplit}`)

console.log('\n=== 6. 接线：三处调用点仍然齐（静态）===')
const course = read(COURSE_REL)
check('assistant 角色仍走摘要', /renderSourcesHint\(\{ role: 'assistant'/.test(course), '')
check('review 角色传章级素材标题', /renderSourcesHint\(\{ role: 'review'/.test(course) && course.includes('chapterSourceTitles('), '')
check('segment 角色传段快照 items', /renderSourcesHint\(\{ role: 'segment', items \}\)/.test(course) && course.includes('resolveSegmentSources('), '')
check('注册表里引用纪律只定义一处（不复制到调用点）', (registrySrc.match(/行内标注编号与页码/g) ?? []).length === 1, String((registrySrc.match(/行内标注编号与页码/g) ?? []).length))

// ---------------------------------------------------------------- report
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? `  -> ${c.detail}` : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} - ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp cleanup failure does not change the verdict */ }
process.exit(failed.length === 0 ? 0 : 1)
