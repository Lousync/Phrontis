/**
 * 契约验证：AI教学长资料方案（docs/ai-teaching-long-material-plan.md）P0 数据模型与纯函数。
 *
 * 纯函数真实实现执行（strip-types import），不复制逻辑；另钉关键静态接线。
 * 用法（仓库根）：node .AGENT/scripts/ai-teaching/verify-long-material.mjs .
 * 全部 PASS 时 exit=0；输出纯 ASCII 标记，禁 emoji。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'longmat-'))
async function load(rel, name) {
  const src = read(rel)
  check(`${rel} 零 import`, !/^\s*import\s/m.test(src), '')
  const file = path.join(tmp, `${name}.mjs`)
  fs.writeFileSync(file, stripTypeScriptTypes(src, { mode: 'strip' }))
  return import(pathToFileURL(file).href)
}

const pure = await load('src/lib/aiTeachingSourcesPure.ts', 'sourcesPure')

// ---------------------------------------------------------------- 1. anchorKey
console.log('\n=== 1. anchorKey 区间键 ===')
check('whole', pure.anchorKey({ kind: 'whole' }) === 'whole', pure.anchorKey({ kind: 'whole' }))
check('pages', pure.anchorKey({ kind: 'pages', from: 12, to: 41 }) === 'pages:12-41')
check('pages 单页', pure.anchorKey({ kind: 'pages', from: 12, to: 12 }) === 'pages:12-12')
check('headings 区间', pure.anchorKey({ kind: 'headings', from: '第1章', to: '第2章' }) === 'headings:第1章→第2章')
check('headings 单标题', pure.anchorKey({ kind: 'headings', from: '第1章' }) === 'headings:第1章')
check('files 排序后拼接', pure.anchorKey({ kind: 'files', paths: ['b.md', 'a.md'] }) === 'files:a.md,b.md', pure.anchorKey({ kind: 'files', paths: ['b.md', 'a.md'] }))
check('files 顺序无关', pure.anchorKey({ kind: 'files', paths: ['a.md', 'b.md'] }) === pure.anchorKey({ kind: 'files', paths: ['b.md', 'a.md'] }))
check('lines', pure.anchorKey({ kind: 'lines', from: 100, to: 250 }) === 'lines:100-250')
check('null/undefined 归 whole', pure.anchorKey(null) === 'whole' && pure.anchorKey(undefined) === 'whole')

// ---------------------------------------------------------------- 2. pickExtract
console.log('\n=== 2. pickExtract 匹配 ===')
const ex1 = { rel: '教材-p1-40.md', anchor: { kind: 'pages', from: 1, to: 40 }, textLayer: 'text', createdAt: '2026-11-08T00:00:00Z', pages: 40, chars: 30000 }
const ex2 = { rel: '教材-p41-80.md', anchor: { kind: 'pages', from: 41, to: 80 }, textLayer: 'text', createdAt: '2026-11-08T00:00:01Z', pages: 40, chars: 28000 }
const src = { extractRel: '教材-p41-80.md', extracts: [ex1, ex2] }
const hit = pure.pickExtract(src, { kind: 'pages', from: 41, to: 80 })
check('exact：anchorKey 完全一致命中', hit.match === 'exact' && hit.extract?.rel === '教材-p41-80.md', JSON.stringify(hit.match))
const fb = pure.pickExtract({ extractRel: '旧提取稿.md' }, { kind: 'pages', from: 81, to: 120 })
check('fallback：无精确匹配回退 extractRel', fb.match === 'fallback' && fb.extract?.rel === '旧提取稿.md', JSON.stringify(fb.match))
check('fallback 合成记录带请求 anchor', fb.extract?.anchor?.kind === 'pages' && fb.extract.anchor.from === 81, JSON.stringify(fb.extract?.anchor))
const miss = pure.pickExtract({}, { kind: 'whole' })
check('missing：无 extracts 无 extractRel', miss.match === 'missing' && miss.extract === null, JSON.stringify(miss.match))
check('同区间重复记录只取第一条命中', pure.pickExtract({ extractRel: null, extracts: [ex1, { ...ex1, rel: '重复.md' }] }, { kind: 'pages', from: 1, to: 40 }).extract?.rel === '教材-p1-40.md')

// ---------------------------------------------------------------- 3. detectLongMaterial
console.log('\n=== 3. detectLongMaterial 自动切档 ===')
const D = pure.detectLongMaterial
check('短素材 inactive normal', D([{ pages: 50, chars: 50000 }], 1_000_000).active === false)
check('页数 ≥100 命中', D([{ pages: 100, chars: 1000 }], 1_000_000).active === true)
check('字符 ≥100k 命中', D([{ pages: 1, chars: 100_000 }], 1_000_000).active === true)
check('多素材累加过线', D([{ pages: 60 }, { pages: 60 }], 1_000_000).active === true)
const bigDoc = { id: 's1', title: '教材', type: 'pdf', status: 'needs-extract', size: 4_000_000, anchor: { kind: 'whole' }, createdAt: '' }
check('未提取 >3MB 文档兜底命中', D([bigDoc], 0).active === true, D([bigDoc], 0).reason)
check('已提取大文档不再兜底', D([{ ...bigDoc, status: 'ready' }], 0).active === false)
check('ctxWindow ≥200k → long-1m', D([{ pages: 620 }], 200_000).profile === 'long-1m')
check('ctxWindow 1M → long-1m', D([{ pages: 620 }], 1_000_000).profile === 'long-1m')
check('ctxWindow 64k~200k → long-128k', D([{ pages: 620 }], 64_000).profile === 'long-128k' && D([{ pages: 620 }], 199_999).profile === 'long-128k')
check('ctxWindow 0（未设置）→ long-128k 保守档', D([{ pages: 620 }], 0).profile === 'long-128k')
check('ctxWindow <64k → normal', D([{ pages: 620 }], 32_000).profile === 'normal')
check('state 带总页数/字符数', (() => { const s = D([{ pages: 300, chars: 120000 }], 1_000_000); return s.pages === 300 && s.chars === 120000 })())
check('纯函数幂等（同参同果）', JSON.stringify(D([bigDoc], 1_000_000)) === JSON.stringify(D([bigDoc], 1_000_000)))

// ---------------------------------------------------------------- 4. 静态接线
console.log('\n=== 4. 静态接线 ===')
const pureSrc = read('src/lib/aiTeachingSourcesPure.ts')
const typesSrc = read('src/types/index.ts')
const settingsSrc = read('src/lib/settings.ts')
check('SourceEntry.status 含 needs-vision', /status:\s*'ready'\s*\|\s*'needs-extract'\s*\|\s*'needs-vision'\s*\|\s*'error'/.test(pureSrc))
check('SourceExtract 类型存在', pureSrc.includes('export interface SourceExtract'))
check('SourceEntry.extracts / pages / chars / size / textLayer 字段存在', /extracts\?:\s*SourceExtract\[\]/.test(pureSrc) && /pages\?:\s*number/.test(pureSrc) && /chars\?:\s*number/.test(pureSrc) && /size\?:\s*number/.test(pureSrc) && /textLayer\?:\s*SourceTextLayer/.test(pureSrc))
check('旧字段 extractRel 保留（兼容）', pureSrc.includes('extractRel?: string | null'))
check('镜像类型 AiTeachSource 同步 needs-vision', /status:\s*'ready'\s*\|\s*'needs-extract'\s*\|\s*'needs-vision'\s*\|\s*'error'/.test(typesSrc))
check('镜像类型 AiTeachSourceExtract 存在', typesSrc.includes('export interface AiTeachSourceExtract'))
check('AiTeachCourseState.longMaterial 存在', typesSrc.includes('longMaterial?'))
check('ctxWindow 默认值 = 1000000（拍板 ①）', /ctxWindow:\s*\{\s*default:\s*1000000,/.test(settingsSrc), (settingsSrc.match(/ctxWindow:\s*\{\s*default:\s*(\d+)/) || [])[1])
check('ctxWindow desc 提及长资料保守档', settingsSrc.includes('128k 保守档'))

// ---------------------------------------------------------------- 5. P1 转写链路
console.log('\n=== 5. P1 转写链路 ===')
const registrySrc = read('electron/lib/aiTeachingSourceRegistry.ts')
const docsReaderSrc = read('electron/lib/docsReader.ts')
check('docsReader 导出 extractPdfWhole（全本循环，无 200 页截断）', docsReaderSrc.includes('export async function extractPdfWhole'))
check('docsReader 注明 MAX_PDF_PAGES 只约束单次', docsReaderSrc.includes('MAX_PDF_PAGES 只约束'))
check('registry 引入 extractPdfWhole', registrySrc.includes('extractPdfWhole'))
check('registry 引入 pickExtract', registrySrc.includes('pickExtract'))
check('ExtractResult 结构化字段齐全', /needsVision\?:\s*boolean/.test(registrySrc) && /needsSoffice\?:\s*boolean/.test(registrySrc) && /estimatedVisionBatches\?:\s*number/.test(registrySrc) && /textLayer\?:\s*SourceTextLayer/.test(registrySrc))
check('全空不写 ready 提取稿', registrySrc.includes("textLayer === 'empty'"))
check('提取稿写进 extracts 且同 anchorKey 去重', registrySrc.includes('src.extracts') && registrySrc.includes('anchorKey(e.anchor)'))
check('extractRel 兼容字段保留并同步', registrySrc.includes('src.extractRel = relPath'))
check('docx 缺 soffice 返回结构化 needsSoffice', registrySrc.includes('needsSoffice: true'))
check('buildSourceIndex 上限 1000', /const MAX_INDEX = 1000/.test(registrySrc))
check('段素材提示区分 exact/fallback/missing', registrySrc.includes('本章提取稿') && registrySrc.includes('非本章区间，请先提取本章') && registrySrc.includes('未提取'))
check('段素材提示带页数/文本层', registrySrc.includes('it.pages') && registrySrc.includes('it.textLayer'))
check('扫描件文案「需要视觉转写」', registrySrc.includes('需要视觉转写'))

// ---------------------------------------------------------------- 6. P2 读取与结果治理
console.log('\n=== 6. P2 读取与结果治理 ===')
const toolsSrc = read('electron/lib/builtinTools.ts')
const agentSrc = read('electron/lib/agentService.ts')
check('vault.read 支持 offset 分页（nextOffset/hasMore）', toolsSrc.includes('nextOffset') && toolsSrc.includes('hasMore: nextOffset < text.length'))
check('vault.read 支持 pages 页码区间续读', toolsSrc.includes("pages: { type: 'string'") && toolsSrc.includes('nextPage'))
check('vault.read 10MB 预检不挡文档（80MB 档）', toolsSrc.includes('MAX_DOC_SIZE : MAX_VAULT_FILE'))
check('vault.list 返回真实 total + hasMore', /total: all\.length, offset, hasMore/.test(toolsSrc))
check('vault.search 返回 scanTruncated/skippedLarge（截断透明）', toolsSrc.includes('scanTruncated') && toolsSrc.includes('skippedLarge'))
check('walkAiFiles 撞预算置 truncated', /budget\.truncated = true/.test(toolsSrc))
check('vault 限额 profile 三档', toolsSrc.includes("'long-128k'") && toolsSrc.includes("'long-1m'") && toolsSrc.includes('setVaultToolProfile'))
check('agentService 结构化截断（capStructuredValue + CAP_KEEP_KEYS）', agentSrc.includes('capStructuredValue') && agentSrc.includes('CAP_KEEP_KEYS'))
check('agentService 截断提示带续读指令', agentSrc.includes('用 offset=') && agentSrc.includes('用 pages="'))
check('runAgentLoop 消费 profile（opts.profile）', /opts\?\.profile \?\? 'normal'/.test(agentSrc))
check('旧常量 MAX_TOOL_RESULT_CHARS 已退役', !agentSrc.includes('MAX_TOOL_RESULT_CHARS'))

// ---------------------------------------------------------------- 7. P3/P4 接线
console.log('\n=== 7. P3/P4 接线 ===')
const courseSrc = read('electron/lib/aiTeachingCourse.ts')
const courseSourcesTsx = read('src/modules/ai-teaching/CourseSources.tsx')
const policySrc = read('electron/lib/agentLoopPolicy.ts')
check('agentService 长资料自动检测（仅 AI 教学链路）', agentSrc.includes('detectLongMaterial') && agentSrc.includes("source === 'aiTeaching'"))
check('运行时兜底升档（>100k 字符 / >100 页）', agentSrc.includes('escalateProfile') && agentSrc.includes('100_000'))
check('循环预算 profile 表（写入 300 / 轮数 48）', agentSrc.includes('LOOP_BUDGET_PROFILES') && /maxSessionWrites:\s*300/.test(agentSrc) && /maxRounds:\s*48/.test(agentSrc))
check('budgetOf 默认值门槛（用户显式设置优先）', agentSrc.includes('budgetOf') && agentSrc.includes('SETTINGS'))
check('课程注入长资料纪律段', courseSrc.includes('【长资料模式】') && courseSrc.includes('一章一笔记'))
check('写入 clamp 上限 99→300', /Math\.min\(300, n\)/.test(policySrc))
check('settings 写入上限 max 300', /agentMaxSessionWrites:\s*\{[^}]*max:\s*300,/s.test(settingsSrc))
check('素材卡 needs-vision 状态「需转写」', courseSourcesTsx.includes('需转写'))
check('素材卡长资料 badge（detectLongMaterial 接入）', courseSourcesTsx.includes('detectLongMaterial') && courseSourcesTsx.includes('长资料 · '))
check('素材卡扫描件元信息', courseSourcesTsx.includes('扫描件（文本层为空）') && courseSourcesTsx.includes('部分扫描'))
check('提取工具失败不 throw（结构化 needsVision 透传）', /\/\/ 失败也不 throw：needsVision \/ needsSoffice \/ emptyPages 是结构化现场/.test(toolsSrc))
check('docsReader 区间分块（章区间可超 200 页）', docsReaderSrc.includes('extractPdfRangeChunked') && registrySrc.includes('extractPdfRangeChunked'))

// ---------------------------------------------------------------- 汇总
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`)
console.log(`\n${checks.length - failed.length}/${checks.length} PASS`)
process.exit(failed.length ? 1 : 0)
