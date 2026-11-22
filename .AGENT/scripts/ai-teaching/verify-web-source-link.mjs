#!/usr/bin/env node
/**
 * 契约验证：AI教学 · 网页素材（url）链路（2026-11-22 修复「url 永远拿不到提取稿」）
 *
 * 背景：现役素材模型是 `.knowbase/modules/aiTeaching/sources.json`，但旧抓取管线
 * （`aiTeachingSources.ts` 的 webProbeSource/webCrawlSource + `webCrawler.ts`）只写旧
 * `SOURCE.md`，抓到的章节**喂不进** sources.json；`WebSourceDialog` 也没有挂载点。
 * 结果：url 素材在现役链路里永远「未提取」。
 *
 * 本脚本锁住修复后的五条硬口径：
 *   1. 新入口四层接线齐全（main handler / preload / types / ipc.ts），签名是 `(wsId, sourceId, …)`；
 *   2. 抓取结果落 `SourceEntry.extractRel`（尾斜杠 = 目录），并刷新素材索引 / 广播刷新；
 *   3. `renderSourcesHint` 的 segment 角色：url 有章节 → 章节清单（排除 00-目录.md、上限 120、
 *      超量提示「其余 N 章见 00-目录.md」、明确「按需读单章，勿一次读全部」）；无抓取 → 不出现章节清单；
 *   4. 旧死入口（`aiTeachSrc:webProbe|webCrawl|webCancel`、`aiTeachSrcWeb*`）与旧
 *      `resolveSourcesForInjection` 已退役（负向断言，防两处并存）；
 *   5. UI 挂载点存在（CourseSources url 行按钮 + 对话框走新通道，窄栏不溢出、无 alert/confirm、
 *      动效只用既有令牌与 transform）。
 *
 * 抓取/探测本身**不联网**：`webCrawler` 的网络层只做结构断言，行为断言全部落在纯函数上。
 *
 * 装载方式：把注册表模块的 import 全改成桩（`__mod(spec)`），保留函数本体后 import ——
 * `renderSourcesHint` / `isWebExtractDir` 是纯函数，不需要 electron / 仓库上下文。
 *
 * 运行（仓库根）：node .AGENT/scripts/ai-teaching/verify-web-source-link.mjs [仓库路径]
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
const LEGACY_REL = 'electron/lib/aiTeachingSources.ts'
const PRELOAD_REL = 'electron/preload/index.ts'
const TYPES_REL = 'src/types/index.ts'
const IPC_REL = 'src/lib/ipc.ts'
const COURSE_SOURCES_REL = 'src/modules/ai-teaching/CourseSources.tsx'
const DIALOG_REL = 'src/modules/ai-teaching/components/WebSourceDialog.tsx'

const registrySrc = read(REGISTRY_REL)
const legacySrc = read(LEGACY_REL)
const preloadSrc = read(PRELOAD_REL)
const typesSrc = read(TYPES_REL)
const ipcSrc = read(IPC_REL)
const courseSourcesSrc = read(COURSE_SOURCES_REL)
const dialogSrc = read(DIALOG_REL)

// ---------------------------------------------------------------- 装载真实实现
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-source-link-'))
fs.writeFileSync(path.join(tmpDir, 'stubs.mjs'), `
/** 任意 import 一律给一个恒等可调用的桩；纯函数不触达任何外部 IO */
const generic = new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : generic),
  apply: () => undefined,
})
export function __mod() { return generic }
`)

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
const { renderSourcesHint, isWebExtractDir } = mod
check('renderSourcesHint 已导出且可调用', typeof renderSourcesHint === 'function', '')
check('isWebExtractDir 已导出且可调用', typeof isWebExtractDir === 'function', '')

console.log('\n=== 1. 提取目录字段口径：extractRel 尾斜杠 = 目录 ===')
check('尾斜杠 -> 目录', isWebExtractDir('AI教学/ws/SOURCES/web/py/') === true, '')
check('普通文件路径 -> 不是目录', isWebExtractDir('AI教学/ws/SOURCES/web.md') === false, '')
check('空串 / 纯斜杠 / null / undefined -> false', !isWebExtractDir('') && !isWebExtractDir('/') && !isWebExtractDir(null) && !isWebExtractDir(undefined), '')
check('反斜杠混排也按尾斜杠判定', isWebExtractDir('AI\\ws\\web\\py/') === true, '')
check('素材结构仍用 extractRel（不新增 dirRel 字段）', /extractRel\?: string \| null/.test(read('src/lib/aiTeachingSourcesPure.ts')) && !/dirRel\?:/.test(read('src/lib/aiTeachingSourcesPure.ts')), '')

console.log('\n=== 2. segment 注入：有章节 -> 章节清单 ===')
const chapters = Array.from({ length: 12 }, (_, i) => `AI教学/ws/SOURCES/web/py/${String(i + 1).padStart(2, '0')}-ch${i + 1}.md`)
const WEB_ITEM = {
  title: 'Python 教程', type: 'url', path: 'https://www.runoob.com/python3/', anchor: '整份',
  chapterDir: 'AI教学/ws/SOURCES/web/py/', chapters,
}
const seg = renderSourcesHint({ role: 'segment', items: [WEB_ITEM] })
check('条目仍是 [1] 编号', seg.includes('- [1] Python 教程'), '')
check('头部声明抓取目录与章数', seg.includes('网页抓取稿 AI教学/ws/SOURCES/web/py/（共 12 章，按需读单章，勿一次读全部）'), '')
check('每章一行、仓库相对路径', chapters.every((c) => seg.includes(`  - ${c}`)), '')
check('引用纪律仍在', seg.includes('本次引用素材') && seg.includes('行内标注编号与页码/行号'), '')
check('NEG: 有章节的 url 不说「未提取（先 course.sources.extract…）」', !seg.includes('未提取（先 course.sources.extract 本段区间）'), '')
check('NEG: 有章节时不出现「不要假装引用」噪音', !seg.includes('不要假装引用'), '')
check('NEG: 章节清单不含 00-目录.md（由列举函数排除）', !seg.includes('00-目录.md\n') && !/^  - .*00-目录\.md$/m.test(seg), '')
check('列举函数真的排除目录索引文件', /d\.name !== WEB_TOC_FILE/.test(registrySrc) && /const WEB_TOC_FILE = '00-目录\.md'/.test(registrySrc), '')
check('「按需读单章，勿一次读全部」是稳定文案', seg.includes('按需读单章，勿一次读全部'), '')

console.log('\n=== 3. 超量：上限 120 + 其余 N 章见 00-目录.md ===')
const many = Array.from({ length: 200 }, (_, i) => `web/big/${String(i + 1).padStart(3, '0')}-c${i + 1}.md`)
const big = renderSourcesHint({ role: 'segment', items: [{ ...WEB_ITEM, chapterDir: 'web/big/', chapters: many }], maxChars: 20000 })
const shownLines = big.split('\n').filter((l) => /^  - web\/big\/\d{3}-c\d+\.md$/.test(l))
check('章数超过 120 时最多列 120 行', shownLines.length === 120, String(shownLines.length))
check('超量提示给出真实余数（其余 80 章）', big.includes('…（其余 80 章，见 00-目录.md）'), '')
const defaultMax = renderSourcesHint({ role: 'segment', items: [{ ...WEB_ITEM, chapterDir: 'web/big/', chapters: many }] })
check('默认字符预算下仍保留「其余 N 章见 00-目录.md」', /其余 \d+ 章，见 00-目录\.md/.test(defaultMax), '')
check('默认预算下列出条数 <= 120', defaultMax.split('\n').filter((l) => /^  - web\/big\//.test(l)).length <= 120, '')
check('默认预算下头部声明不被截断', defaultMax.includes('共 200 章，按需读单章，勿一次读全部'), '')

console.log('\n=== 4. 负向：无抓取的 url / 其它角色不出章节清单 ===')
const noCrawl = renderSourcesHint({
  role: 'segment',
  items: [{ title: '未抓网页', type: 'url', path: 'https://example.com/doc', anchor: '整份', extractMatch: 'missing' }],
})
check('NO-CRAWL: 条目标「网页未抓取」并指路「展开网页」', noCrawl.includes('网页未抓取（右栏素材点「展开网页」）'), '')
check('NO-CRAWL: 不出现章节清单抬头', !noCrawl.includes('网页抓取稿') && !noCrawl.includes('按需读单章，勿一次读全部'), '')
check('NO-CRAWL: 不用 pdf 口径说「先 course.sources.extract」', !noCrawl.includes('未提取（先 course.sources.extract 本段区间）'), '')
check('NO-CRAWL: 给在线读单页 + 目录页提示', noCrawl.includes('builtin.web.read') && noCrawl.includes('「展开网页」抓取后再引用'), '')
const review = renderSourcesHint({ role: 'review', chapterSources: ['Python 教程（整份）'] })
check('review 角色不展开章节清单', !review.includes('网页抓取稿') && !review.includes('按需读单章'), '')
const assistant = renderSourcesHint({ role: 'assistant', summary: '已登记 1 条；已分配 1 条；未分配 0 条。' })
check('assistant 摘要不展开章节清单', !assistant.includes('网页抓取稿'), '')

console.log('\n=== 5. 四层接线（main / preload / types / ipc.ts）===')
for (const ch of ['webProbe', 'webCrawl', 'webCancel']) {
  check(`main handler: aiTeachCourse:${ch}`, registrySrc.includes(`ipcMain.handle('aiTeachCourse:${ch}'`), '')
  check(`preload: aiTeachCourse${ch[0].toUpperCase()}${ch.slice(1)} 通道名对应`, preloadSrc.includes(`ipcRenderer.invoke('aiTeachCourse:${ch}'`), '')
  check(`types: aiTeachCourse${ch[0].toUpperCase()}${ch.slice(1)} 声明`, new RegExp(`aiTeachCourse${ch[0].toUpperCase()}${ch.slice(1)}\\??: \\(wsId: string, sourceId: string`).test(typesSrc), '')
  check(`ipc.ts: aiTeachCourse${ch[0].toUpperCase()}${ch.slice(1)} 导出`, new RegExp(`export const aiTeachCourse${ch[0].toUpperCase()}${ch.slice(1)} = `).test(ipcSrc), '')
}
check('抓取入口签名 = (wsId, sourceId, chapters, getSetting)', /export async function crawlWebSource\(\s*wsId: string,\s*sourceId: string,\s*chaptersInput: Array<\{ url: string; title\?: string \}>,\s*getSetting: GetSetting,/.test(registrySrc), '')
check('探测入口签名 = (wsId, sourceId, getSetting, anchorUrl?)', /export async function probeWebSource\(\s*wsId: string,\s*sourceId: string,\s*getSetting: GetSetting,\s*anchorUrl\?: string\)/.test(registrySrc), '')
check('取消入口签名 = (wsId, sourceId)', /export function cancelWebSource\(wsId: string, sourceId: string\)/.test(registrySrc), '')
check('进度广播载荷 = { wsId, sourceId, done, total, current }', /BROADCAST_CHANNEL\.aiTeachWebCrawlProgress, \{[\s\S]{0,120}wsId: id, sourceId: sid, done: info\.done, total: info\.total, current: info\.current/.test(registrySrc), '')
check('进度事件类型也换成 wsId/sourceId', typesSrc.includes('onAiTeachWebProgress: (cb: (p: { wsId: string; sourceId: string; done: number; total: number; current: string }) => void)'), '')

console.log('\n=== 6. 抓取落库 + 刷新（结构断言，不联网）===')
check('复用 webCrawler.crawlQueue（不另写抓取内核）', /crawlQueue\(chapters, \{/.test(registrySrc) && /from '\.\/webCrawler'/.test(registrySrc), '')
check('设置项 webCrawlMaxPages / webCrawlDelayMs 仍生效', registrySrc.includes("getSetting('webCrawlMaxPages')") && registrySrc.includes("getSetting('webCrawlDelayMs')"), '')
check('目录沿用 SOURCES/web/{slug}/ 命名习惯', /`\$\{w\.rel\}\/SOURCES\/\$\{WEB_DIR\}\/\$\{sanitizeTitle\(source\.title\)/.test(registrySrc), '')
check('抓取结果写入现役字段 extractRel（尾斜杠目录）', /freshSrc\.extractRel = dirRel/.test(registrySrc) && /webDirRelFor\(/.test(registrySrc), '')
check('落库前重读 sources.json（不覆盖抓取期间的其它改动）', /const fresh = readFile\(\)/.test(registrySrc) && /writeFile\(fresh\)/.test(registrySrc), '')
check('抓完重建素材索引（extractRel 目录 -> files anchor）', /freshSrc\.index = buildSourceIndex\(freshSrc\)/.test(registrySrc), '')
check('抓完 status=ready + chars 累加', /freshSrc\.status = 'ready'/.test(registrySrc) && /freshSrc\.chars = totalChars/.test(registrySrc), '')
check('写 00-目录.md（标题 / 本地文件 / 源 URL / 失败项）', /WEB_TOC_FILE\), tocMd, 'utf-8'/.test(registrySrc) && /✗ \$\{x\.reason\}/.test(registrySrc), '')
check('广播三件套：tree-refresh + knowledge + course-refresh', /aiTeachTreeRefresh, \{ dirRel/.test(registrySrc) && /broadcastDataChanged\('knowledge'\)/.test(registrySrc) && /broadcastSources\(id\)/.test(registrySrc), '')
check('断点续抓：同名文件存在即跳过', /exists: \(rel\) => existsSync\(join\(dirAbs, rel\)\)/.test(registrySrc), '')
check('取消：AbortController 按 wsId+sourceId 认领', /crawlAborts\.set\(key, abort\)/.test(registrySrc) && /crawlAborts\.get\(abortKey\(/.test(registrySrc) && /a\.abort\(\)/.test(registrySrc), '')
check('extractSource 对 url 指路「展开网页」（不再说「不需要提取」）', /src\.type === 'url'[\s\S]{0,400}展开网页/.test(registrySrc), '')
check('resolveSegmentSources 读抓取目录并给 chapterDir/chapters', /const chapterDir = src\.type === 'url' \? webDirRelOf\(src, vault\?\.rootPath\)/.test(registrySrc) && /chapterDir: chapters \? chapterDir : undefined/.test(registrySrc), '')
check('章节列举只看顶层 md（不递归 web/ 以外）', /readdirSync\(dirAbs, \{ withFileTypes: true \}\)[\s\S]{0,200}d\.isFile\(\)/.test(registrySrc), '')

console.log('\n=== 7. 旧死入口已退役（负向，禁止两处并存）===')
const ALL_SRC = [registrySrc, legacySrc, preloadSrc, typesSrc, ipcSrc, courseSourcesSrc, dialogSrc].join('\n')
check('NEG: 无 aiTeachSrc:webProbe|webCrawl|webCancel handler', !/aiTeachSrc:web(Probe|Crawl|Cancel)/.test(ALL_SRC), '')
check('NEG: 无 aiTeachSrcWeb* preload/ipc/types 入口', !/aiTeachSrcWeb(Probe|Crawl|Cancel)/.test(ALL_SRC), '')
check('NEG: 旧 webProbeSource/webCrawlSource/webCrawlCancel 已删除', !/webProbeSource|webCrawlSource|webCrawlCancel/.test(legacySrc), '')
check('NEG: 旧 resolveSourcesForInjection 已退役', !/resolveSourcesForInjection/.test(legacySrc), '')
check('NEG: 旧注入私有 helper 一并退役（listDirFilesRecursive / TEXT_EXTS）', !/listDirFilesRecursive/.test(legacySrc) && !/\bTEXT_EXTS\b/.test(legacySrc), '')
check('NEG: 旧 SOURCE.md 抓取注释不再承认自己是「现役」', !/回写「已提取 ✓ → web\/\{slug\}\/」后由/.test(legacySrc), '')
check('NEG: 旧 webCrawlCancel 的 __workspace__ 中止槽已删', !/__workspace__/.test(legacySrc), '')

console.log('\n=== 8. UI：挂载点 + 交互口径 ===')
check('CourseSources 引入 WebSourceDialog', /import \{ WebSourceDialog \} from '\.\/components\/WebSourceDialog'/.test(courseSourcesSrc), '')
check('url 素材行有「展开网页 / 网页章节」按钮', /setWebSource\(src\)/.test(courseSourcesSrc) && /展开网页/.test(courseSourcesSrc) && /网页章节/.test(courseSourcesSrc), '')
check('对话框挂载并接新入口（wsId + source）', /<WebSourceDialog[\s\S]{0,400}wsId=\{wsId\}[\s\S]{0,200}source=\{\{ id: webSource\.id/.test(courseSourcesSrc), '')
check('抓完回调刷新素材列表', /onDone=\{\(\) => \{ void reload\(\); onReloadCourse\(\) \}\}/.test(courseSourcesSrc), '')
check('对话框探测/抓取/取消都走 aiTeachCourse:*', /aiTeachCourseWebProbe\(wsId, source\.id/.test(dialogSrc) && /aiTeachCourseWebCrawl\(wsId, source\.id/.test(dialogSrc) && /aiTeachCourseWebCancel\(wsId, source\.id\)/.test(dialogSrc), '')
check('进度事件按 wsId + sourceId 认领', /p\.wsId !== wsId \|\| p\.sourceId !== source\.id/.test(dialogSrc), '')
check('失败列表 + 重试失败项', /重试失败项/.test(dialogSrc) && /result\.failed!/.test(dialogSrc), '')
check('窄栏不溢出：面板 max-w 按视口收缩 + 文本 truncate', /max-w-\[calc\(100vw-16px\)\]/.test(dialogSrc) && /truncate/.test(dialogSrc), '')
check('NEG: 对话框不出现 alert( / confirm(', !/\balert\(|\bconfirm\(/.test(dialogSrc), '')
check('NEG: 不用 transition-all（铁律 13）', !/transition-all/.test(dialogSrc), '')
check('进度条只动 transform（scaleX + transition-transform，带 reduced-motion 兜底）', /transition-transform duration-300 motion-reduce:transition-none/.test(dialogSrc) && /scaleX\(/.test(dialogSrc), '')
check('弹层动效走既有令牌 .kb-overlay（首子元素继承）', /kb-overlay/.test(dialogSrc) && !/transition-all/.test(courseSourcesSrc), '')

// ---------------------------------------------------------------- report
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? `  -> ${c.detail}` : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} - ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp cleanup failure does not change the verdict */ }
process.exit(failed.length === 0 ? 0 : 1)
