// 契约验证：书市 AI 工具两枚 + 草案预填接线（S5 · 施工方案 §13.5 ①）
//
// 分工：`probe-s5-tools.mjs` 验**行为**（真 electron：工具在册、权限两档拦得住、草案真的落进表单）；
// 本脚本验**静态接线** —— 那些「漏了就静默降级」的东西：
//   ① 元数据：两枚工具的 tier / module / requires / readOnly（tier 缺省 = core，低频工具会白付每轮 token）
//   ② schema 红线：≤800 字符（借用 ai-tools-audit/measure-tool-schema.mjs 同一把尺子）
//   ③ 凭据负向：两枚工具的 inputSchema 零凭据字段（AI 永远拿不到凭据）
//   ④ tool.request 清单：含 booksource.draft、不含 booksource.list，且**覆盖全部写工具**
//      —— 铁律 18「新写工具同步补清单」的断言版：漏了 = 模型看不见 = 功能生而不可达
//   ⑤ 权限页有那一行（漏了 = 写权限永远开不出来，同样完全静默）
//   ⑥ 通道四处齐（BROADCAST_CHANNEL → preload → bus → App）+ 模块消费与表单预填
//   ⑦ 负向：工具文件不 import 凭据读取；草案那一跳不发数据变更
//
// 运行（仓库根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/book-market/verify-book-market-tools.mjs
// 期望：全部 ok + exit=0

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const code = (rel) => stripComments(read(rel))

const BT = 'electron/lib/builtinTools.ts'
const BUS_SRC = 'electron/main/windowBus.ts'
const PRELOAD = 'electron/preload/index.ts'
const TYPES = 'src/types/index.ts'
const APP = 'src/App.tsx'
const BUS = 'src/lib/bookSourceDraftBus.ts'
const MODULE = 'src/modules/bookmarket/index.tsx'
const FORM = 'src/modules/bookmarket/SourceFormSheet.tsx'
const PERMS_TAB = 'src/modules/settings/views/AiPermissionsTab.tsx'
const SETTINGS = 'src/lib/settings.ts'

const CHANNEL_KEY = 'bookMarketSourceDraft'
const CHANNEL_LITERAL = 'bookMarket:source-draft'

/* ================= 工具块解析（切块手法照 ai-tools-audit/measure-tool-schema.mjs） ================= */
const btSrc = code(BT)
const lines = btSrc.split(/\r?\n/)
const starts = []
lines.forEach((l, i) => { if (/^\s{2}registerTool\(\{/.test(l)) starts.push(i) })
const findClose = (from) => {
  for (let i = from + 1; i < lines.length; i++) if (/^ {2}\}\);?\s*$/.test(lines[i])) return i
  return lines.length - 1
}
/** inputSchema 的真实发包字符数：去换行 / 缩进 / 注释行（与 measure-tool-schema.mjs 同口径） */
const schemaChars = (text) => {
  const at = text.indexOf('inputSchema:')
  if (at < 0) return 0
  const start = text.indexOf('{', at)
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
          .split(/\r?\n/)
          .filter((l) => !/^\s*\/\//.test(l))
          .map((l) => l.trim())
          .join('').length
      }
    }
  }
  return 0
}

const pick = (text, re) => (text.match(re) || [])[1]
const tools = starts.map((s) => {
  const text = lines.slice(s, findClose(s) + 1).join('\n')
  const metaEnd = text.indexOf('\n  }, ')
  const meta = metaEnd < 0 ? text : text.slice(0, metaEnd)
  const schemaAt = meta.indexOf('inputSchema:')
  return {
    block: text,
    meta,
    name: pick(meta, /name:\s*'([^']+)'/) ?? '(unknown)',
    // description 按**源文件自己的引号**配对取：里面可能含另一种引号
    // （draft 的说明就带了 JSON 例子 `{"list":...}` —— 不区分配对会把说明从那里截断）
    description: pick(meta, /description:\s*'([^']*)'/) ?? pick(meta, /description:\s*"([^"]*)"/) ?? '',
    // 缺省 tier = core（每轮常驻）；缺省 requires = read（见 AgentTool 定义）
    tier: pick(meta, /tier:\s*'(\w+)'/) ?? 'core',
    requires: pick(meta, /requires:\s*'(\w+)'/) ?? 'read',
    readOnly: (pick(meta, /readOnly:\s*(true|false)/) ?? 'true') === 'true',
    module: pick(meta, /module:\s*'([^']+)'/) ?? '-',
    schema: schemaAt < 0 ? '' : meta.slice(schemaAt),
    schemaChars: schemaChars(meta),
  }
})
const byName = new Map(tools.map((t) => [t.name, t]))
const LIST = 'builtin.booksource.list'
const DRAFT = 'builtin.booksource.draft'

/* ================= ① 元数据 ================= */
console.log('\n--- ① 工具元数据（tier / module / requires / readOnly） ---')
check('两枚工具都在册', byName.has(LIST) && byName.has(DRAFT), `共 ${tools.length} 个工具`)
check(`${LIST} = bookMarket / read / ondemand / readOnly`, (() => {
  const t = byName.get(LIST)
  return !!t && t.module === 'bookMarket' && t.requires === 'read' && t.tier === 'ondemand' && t.readOnly
})())
check(`${DRAFT} = bookMarket / write / ondemand / 非 readOnly`, (() => {
  const t = byName.get(DRAFT)
  return !!t && t.module === 'bookMarket' && t.requires === 'write' && t.tier === 'ondemand' && !t.readOnly
})())
check('负向：两枚都**不是** core（书源配置是低频动作，常驻等于每轮白付 token）',
  byName.get(LIST)?.tier !== 'core' && byName.get(DRAFT)?.tier !== 'core')
check('可达性：draft 的 description 指了 list（tool.request 清单只提写工具，只读工具无人提及就进不了视野）',
  /booksource\.list/.test(byName.get(DRAFT)?.description ?? ''))

/* ================= ② schema 红线 ================= */
console.log('\n--- ② schema 字符红线（≤800，AGENTS.md#16） ---')
check(`${LIST} schema ≤800`, (byName.get(LIST)?.schemaChars ?? 9999) <= 800, `${byName.get(LIST)?.schemaChars}`)
check(`${DRAFT} schema ≤800`, (byName.get(DRAFT)?.schemaChars ?? 9999) <= 800, `${byName.get(DRAFT)?.schemaChars}`)

/* ========== ②b enum 与执行体一致性（F-6 根因：schema 漏值 → 模型只能猜） ==========
 * 2026-09-23 F-6：`authType` 的 schema enum 曾只写 ['basic','bearer']，而执行体
 *   `bookSourceEnum(args.authType, ['basic','bearer','none'], 'none', ...)` 期望
 *   'none' = 免认证 —— 模型想表达「此源免认证」时**没有合法取值可用**，只能省略或猜，
 *   猜错就造出「配置说无需登录、探测说需要凭据」的矛盾源。
 * ★ 断言口径：执行体第一处 `['...'] as const` 里的全部字面量，必须**逐个出现在**
 *   该工具 schema 的 enum 里。少一个就是给模型的契约缺项。 */
console.log('\n--- ②b schema enum 必须覆盖执行体接受的取值（F-6） ---')
const enumCov = (toolName, label) => {
  const t = byName.get(toolName)
  if (!t) return { ok: false, missing: ['(工具不存在)'] }
  // 执行体里 bookSourceEnum(...) 的第一个数组字面量 = 该参数接受的合法值全集
  const m = t.block.match(new RegExp(`bookSourceEnum\\(\\s*args\\.${label}\\s*,\\s*\\[([^\\]]+)\\]`))
  if (!m) return { ok: false, missing: ['(执行体未找到该参数)'] }
  const allowed = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  // schema 里该字段的 enum 数组（schema 是**源码文本**：字段名可能带引号也可能不带）
  const sm = (t.schema ?? '').match(new RegExp(`["']?${label}["']?\\s*:\\s*\\{[^}]*enum\\s*:\\s*\\[([^\\]]+)\\]`))
  if (!sm) return { ok: false, missing: allowed, allowed }
  const declared = sm[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  return { ok: allowed.every((v) => declared.includes(v)), allowed, declared, missing: allowed.filter((v) => !declared.includes(v)) }
}
for (const [label] of [['authType'], ['kind'], ['responseType']]) {
  const r = enumCov(DRAFT, label)
  check(`${DRAFT} · ${label}：schema enum 覆盖执行体全部取值`,
    r.ok,
    r.ok ? `[${r.declared.join(', ')}]` : `缺 ${(r.missing || []).join(', ')}（执行体接受 [${(r.allowed || []).join(', ')}]）`)
}

/* ================= ③ 凭据负向 ================= */
console.log('\n--- ③ 凭据负向（AI 永不接触凭据） ---')
const CRED_RE = /(username|password|passwd|token|apikey|api_key|secret|credential)/i
check(`${LIST} inputSchema 零凭据字段`, !CRED_RE.test(byName.get(LIST)?.schema ?? 'x'))
check(`${DRAFT} inputSchema 零凭据字段`, !CRED_RE.test(byName.get(DRAFT)?.schema ?? 'x'))
check(`${LIST} 只回「凭据是否已存」布尔（取自 bookSourceInfos，不在工具里另写一份过滤）`,
  /bookSourceInfos\(/.test(byName.get(LIST)?.block ?? '') && /hasCredential/.test(byName.get(LIST)?.block ?? ''))

/* ================= ④ tool.request 清单 ================= */
console.log('\n--- ④ builtin.tool.request 清单（铁律 18：新写工具必须同步补） ---')
const reqTool = byName.get('builtin.tool.request')
const reqNames = (reqTool?.description ?? '').split(/[（(]/).slice(1).join('（').split(/[）)]/)[0]
  .split('/').map((s) => s.trim()).filter(Boolean)
check('清单含 booksource.draft', reqNames.includes('booksource.draft'), `清单 ${reqNames.length} 项`)
check('清单**不含** booksource.list（读工具不进写工具清单）', !reqNames.includes('booksource.list'))
check('清单里的名字都是真实存在的工具（防手抄错名 → 申请必失败）',
  reqNames.every((n) => byName.has(`builtin.${n}`)),
  reqNames.filter((n) => !byName.has(`builtin.${n}`)).join(', ') || '全部命中')
// 清单覆盖范围 = 全部 `builtin.*` 写工具。★ `visual.html` 是**已知例外**：它是 AI 教学的
// 专用写工具，可发现性走 agentService 的专属提示（`tools="visual.html"`），不进这张清单 ——
// 所以下面既排掉它，又断言那条专属提示确实还在（例外不许变成静默）。
const writeTools = tools
  .filter((t) => t.requires === 'write' && !t.readOnly && t.name.startsWith('builtin.'))
  .map((t) => t.name.replace(/^builtin\./, ''))
const missing = writeTools.filter((n) => !reqNames.includes(n))
check(`清单覆盖全部内置写工具（写工具 ${writeTools.length} 个 / 清单 ${reqNames.length} 项）`,
  missing.length === 0 && reqNames.length === writeTools.length,
  missing.length ? `漏：${missing.join(', ')}` : '一一对应')
check('例外 visual.html 的可发现性有专属提示（agentService 里点名 + 教模型用 tool.request 申请）',
  /tools="visual\.html"/.test(code('electron/lib/agentService.ts')))

/* ================= ⑤ 权限接线 ================= */
console.log('\n--- ⑤ 权限页接线（漏了 = 写权限开不出来，且完全静默） ---')
const permsSrc = code(PERMS_TAB)
check('AiPermissionsTab.MODULES 含 bookMarket 行', /id:\s*'bookMarket'/.test(permsSrc))
check('该行有 label 与 writeDesc（写给用户看的「AI 能干什么」）',
  /id:\s*'bookMarket'[^}]*label:/.test(permsSrc) && /id:\s*'bookMarket'[^}]*writeDesc:/.test(permsSrc))
check('settings.ts 的 aiModulePermissions 默认串补了 bookMarket',
  /aiModulePermissions:[^\n]*"bookMarket":"read"/.test(code(SETTINGS)))

/* ================= ⑥ 通道四处齐 ================= */
console.log('\n--- ⑥ 草案通道：四处齐 + 模块消费 + 表单预填 ---')
const busSrc = code(BUS_SRC)
check('通道 ↔ BROADCAST_CHANNEL（唯一真相源）',
  new RegExp(`${CHANNEL_KEY}:\\s*'${CHANNEL_LITERAL}'`).test(busSrc))
const preloadSrc = code(PRELOAD)
check('通道 ↔ preload 订阅', new RegExp(`ipcRenderer\\.on\\('${CHANNEL_LITERAL}'`).test(preloadSrc))
check('通道 ↔ preload 导出 onBookMarketSourceDraft（订阅即退订函数）', /onBookMarketSourceDraft:\s*\(cb/.test(preloadSrc) && /removeListener\('bookMarket:source-draft'/.test(preloadSrc))
check('通道 ↔ ElectronAPI 声明', /onBookMarketSourceDraft:\s*\(cb/.test(code(TYPES)))
check('通道 ↔ 主进程发送方（broadcast + 通道常量）',
  /broadcast\(BROADCAST_CHANNEL\.bookMarketSourceDraft/.test(byName.get(DRAFT)?.block ?? ''))
check('字面量一致性：preload 与 windowBus 用的是同一个通道名（不一致 = 静默收不到）',
  (busSrc.match(new RegExp(`'(${CHANNEL_LITERAL})'`)) ?? [])[1] === (preloadSrc.match(/ipcRenderer\.on\('([^']+)'/g) ?? []).map((s) => s.replace(/ipcRenderer\.on\('/, '').replace(/'$/, '')).find((c) => c === CHANNEL_LITERAL))
check('bus 三件套齐（请求 / 取暂存 / 清暂存）+ 事件名常量',
  /export function requestSourceDraftPrefill/.test(code(BUS)) &&
  /export function peekPendingSourceDraft/.test(code(BUS)) &&
  /export function clearPendingSourceDraft/.test(code(BUS)) &&
  new RegExp(`SOURCE_DRAFT_EVENT = '${CHANNEL_LITERAL}'`).test(code(BUS)))
check('bus 无 TTL（模块慢挂载时不能把草案丢掉；与 pluginCommandBus 的 5s 有意不同）',
  !/TTL/.test(code(BUS)))
check('dev-only 钩子：import.meta.env.DEV 守卫 + window.__kbBookSourceDraft',
  /import\.meta\.env\.DEV/.test(code(BUS)) && /__kbBookSourceDraft/.test(code(BUS)))
const appSrc = code(APP)
check('App 订阅广播 → 切模块 + 暂存 + toast',
  /onBookMarketSourceDraft\?\.\(/.test(appSrc) && /requestSourceDraftPrefill\(/.test(appSrc) && /setActiveTab\('bookMarket'\)/.test(appSrc) && /showToast\(/.test(appSrc))
const modSrc = code(MODULE)
check('模块挂载时消费暂存（广播可能早于挂载，只订阅会漏）',
  /peekPendingSourceDraft\(\)/.test(modSrc) && /onSourceDraftPrefill\(/.test(modSrc) && /clearPendingSourceDraft\(\)/.test(modSrc))
check('模块把草案送进表单 + 切「书源」视图', /setView\('sources'\)/.test(modSrc) && /draft=\{formDraft\}/.test(modSrc))
const formSrc = code(FORM)
check('表单收 draft prop（新增态用；source 优先）',
  /draft\?:\s*BookSourceDraft \| null/.test(formSrc) && /const d = source \? null : draft/.test(formSrc))
check('表单按草案预填 7 行映射', /d\?\.mapping\?\.\[k\]/.test(formSrc))
check('★ 凭据三框恒置空（草案里本就没有凭据字段）',
  /setUsername\(''\);\s*setPassword\(''\);\s*setToken\(''\)/.test(formSrc))
check('关闭即弃草案（否则下次点「新增书源」会带出旧草案）',
  /setFormOpen\(false\);\s*setFormDraft\(null\)/.test(modSrc))

/* ================= ⑦ 负向：AI 侧拿不到凭据 ================= */
console.log('\n--- ⑦ 负向断言 ---')
check('工具文件不 import 凭据读取（bookSourceCredentialFor / secretStore）',
  !/bookSourceCredentialFor/.test(btSrc) && !/secretStore/.test(btSrc))
check('草案那一跳不发数据变更（没写盘，data-changed 一条都不该动）',
  !/broadcastDataChanged/.test(byName.get(DRAFT)?.block ?? 'x'))
check('校验复用 repo（不新写一套判定）',
  /sanitizeBookSourcePatch\(/.test(byName.get(DRAFT)?.block ?? '') && /isAllowedSourceUrl\(/.test(byName.get(DRAFT)?.block ?? ''))

/* ================= 结尾 ================= */
console.log('\n========================================')
if (!existsSync(join(ROOT, FORM))) {
  console.log('❌ 找不到表单文件 —— 请从仓库根目录运行')
  process.exit(1)
}
if (pass) {
  console.log('✅ 书市 AI 工具与草案预填接线契约全部通过')
  process.exit(0)
}
console.log('❌ 有断言失败 —— 见上面的 fail 行')
process.exit(1)
