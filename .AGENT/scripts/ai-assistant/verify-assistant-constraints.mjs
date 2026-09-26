/**
 * 契约脚本：AI 助手独立要求 + 术语表（台账 N-5 / N-7，2026-09-26 落码）
 *
 * 覆盖的缺陷面：
 *   ① `.assistant/` 存放链 —— SOFT_ENTRY_NAMES 登记后若 listDirEntries 的点目录一刀切不放行，
 *      软件文件区永远见不到它（登记变成无效声明）；点目录放行必须**只限名单内**，
 *      否则 .knowbase/.attachments 全部漏进用户视野（数据区暴露）。
 *   ② 注入分叉 —— 教学三层约束（全局/工作区/会话）此前**未按 source 门控**，教学全局要求
 *      会漏进助手对话（与拍板「独立第二份，不共用」相悖）；助手自己的注入段必须存在且只对助手生效。
 *   ③ 术语表骨架的工具名 —— 写错工具名 = 给模型假指路（N-7 §八.②），必须逐个真实存在于
 *      builtinTools 注册表；骨架 8 行（N-7 四·乙）不得静默增减。
 *   ④ 博客检索缺口（N-7 §五 B+C）—— blog.search 工具（ondemand 折叠 + tool.request 清单）
 *      与 knowledge.search 的边界声明必须同批在位。
 *   ⑤ 面板入口（拍板④⑤）—— 三处宿主共用常驻入口；会话条目无会话时禁用；跳转带 from:'aiChat'
 *      吃 N-4 返回 chip 链。
 *   ⑥ 要求文件不预填骨架（拍板 H）—— ensure 落**空文件**，别把教学的示例条目带过来。
 *
 * 用法：node --experimental-strip-types .AGENT/scripts/ai-assistant/verify-assistant-constraints.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

/** 只剥注释、保留字符串字面量（同 workbench-shell 契约的状态机实现） */
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

/* ================= A. `.assistant/` 存放链（SOFT_ENTRY_NAMES + 点目录放行） ================= */
console.log('\n=== A. `.assistant/` 进软件文件区（workspaceManager） ===')
const srcWsRaw = read('electron/lib/workspaceManager.ts')
const srcWs = stripComments(srcWsRaw)
ok(/const SOFT_ENTRY_NAMES = new Set\(\['\.ignore', '\.assistant'\]\)/.test(srcWs),
  'A1 SOFT_ENTRY_NAMES 登记 .assistant（N-5 拍板②：存放位置=软件文件区可见的文件夹）')
ok(/name\.startsWith\('\.'\) && !SOFT_ENTRY_NAMES\.has\(name\.toLowerCase\(\)\)\) continue/.test(srcWs),
  'A2 listDirEntries 点目录放行规则：只放行名单内条目（.knowbase/.attachments 等仍隐藏）')
ok(!/if \(name\.startsWith\('\.'\)\) continue/.test(srcWs),
  'A3 负向：旧「点目录一刀切」写法已移除（否则 .assistant 永远进不了软件文件区）')

/* ================= B. assistantConstraints 模块本体（ensure / 读取 / 注册） ================= */
console.log('\n=== B. assistantConstraints.ts 本体 ===')
const srcAc = stripComments(read('electron/lib/assistantConstraints.ts'))
for (const fn of ['readAssistantGlobalConstraints', 'readAssistantSessionConstraints', 'readAssistantGlossary',
  'ensureAssistantGlobalConstraints', 'ensureAssistantSessionConstraints', 'ensureAssistantGlossary',
  'registerAssistantConstraintsHandlers']) {
  ok(new RegExp(`export function ${fn}`).test(srcAc), `B1 ${fn} 导出在位`)
}
ok(/assistantConstraints:ensureGlobal/.test(srcAc) && /assistantConstraints:ensureSession/.test(srcAc) && /assistantConstraints:ensureGlossary/.test(srcAc),
  'B2 三条 IPC channel 注册（ensure 命名与 preload 对齐）')
ok(/broadcastDataChanged\('knowledge'\)/.test(srcAc),
  'B3 ensure 落盘后广播 knowledge scope（铁律 1：软件文件区/文件树刷新的唯一通道）')
ok(!/回答默认用中文|先给结论/.test(srcAc),
  'B4 负向：助手要求文件不预填骨架（拍板 H：落空文件；教学的示例条目不得带过来）')
ok(/test\(id\)/.test(srcAc) && /A-Za-z0-9_-/.test(srcAc),
  'B5 会话 id 白名单校验（单段安全字符，防拼接路径）')

/* ================= C. 术语表骨架（工具名必须真实存在 + 行数锁） ================= */
console.log('\n=== C. 术语表骨架 ↔ 工具注册表双向对账 ===')
// 提取用**原始源码**（不经 stripComments）：`name: 'builtin.*'` 声明形态唯一，
// 注释不会产生该形态；而 strip 状态机在含转义引号的大文件上可能错位丢匹配。
const rawBt = read('electron/lib/builtinTools.ts')
const rawAc = read('electron/lib/assistantConstraints.ts')
const skelAt = rawAc.indexOf('const GLOSSARY_SKELETON')
const skelEnd = rawAc.indexOf('\n}', skelAt)
const skel = rawAc.slice(skelAt, skelEnd)
const skelTools = [...new Set([...skel.matchAll(/builtin\.[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+/g)].map(m => m[0]))]
const registered = new Set([...rawBt.matchAll(/name: '(builtin\.[a-z0-9.-]+)'/g)].map(m => m[1]))
const unknownTools = skelTools.filter(t => !registered.has(t))
ok(unknownTools.length === 0,
  'C1 骨架里出现的工具名全部真实存在于注册表（假指路防线，N-7 §八.②）', unknownTools.join(', ') || `clean（${skelTools.length} 个）`)
const skelRows = (skel.match(/alias:/g) || []).length
ok(skelRows === 8, 'C2 骨架 8 行（N-7 四·乙：按「有 AI 工具的模块」定，增删模块须同步）', `实际 ${skelRows}`)
ok(/博客 \/ 日志 \/ 日记/.test(skel),
  'C3 「博客/日志/日记 → 博客日记」行在位（UI 叫博客、工具叫日记，术语表是唯一弥合缝 —— N-7 §六连带）')

/* ================= D. agentService 注入分叉 ================= */
console.log('\n=== D. 注入分叉（教学门控 + 助手段 + 术语表段） ===')
const srcAg = stripComments(read('electron/lib/agentService.ts'))
ok(/import \{ readAssistantGlobalConstraints, readAssistantSessionConstraints, readAssistantGlossary \} from '\.\/assistantConstraints'/.test(srcAg),
  'D1 agentService 引入助手约束/术语表读取器')
// 教学三层约束按 source 门控（修掉「教学全局要求漏进助手」的既有洞）
ok(/const rawConstraints = source === 'aiTeaching' \? resolveConstraintsForInjection/.test(srcAg),
  'D2 教学会话约束层按 source 门控')
ok(/const rawWs = source === 'aiTeaching' \? \(readWorkspaceConstraintsForSession/.test(srcAg),
  'D3 教学工作区约束层按 source 门控')
ok(/const rawGlobal = source === 'aiTeaching' \? \(readGlobalConstraints/.test(srcAg),
  'D4 教学全局约束层按 source 门控（此前未门控 = 漏进助手对话）')
// 助手段存在且只对助手生效、进入稳定前缀
ok(/const assistantConstraintHint = source === 'aiTeaching' \? '' : \(\(\) => \{/.test(srcAg),
  'D5 助手要求注入段存在且教学源为零注入（独立第二份，措辞不复用教学口径）')
ok(/const glossaryHint = source === 'aiTeaching' \? '' : \(\(\) => \{/.test(srcAg),
  'D6 术语表注入段存在且教学源为零注入')
ok(/\+ assistantConstraintHint \+ glossaryHint \+/.test(srcAg),
  'D7 两段进 systemFull 拼接（改动低频 = 稳定前缀合规；不走每轮现算的 extraPrefix）')
ok(/readAssistantSessionConstraints\(sessionId\)/.test(srcAg) && /本会话要求/.test(srcAg),
  'D8 会话层注入（按需升格的产物；优先级链 会话 > 全局，拍板 G）')
ok(/readAssistantGlossary\(\)/.test(srcAg) && /if \(!rows \|\| rows\.length === 0\) return ''/.test(srcAg),
  'D9 术语表空/坏 JSON → 零注入（不因 .assistant/glossary.json 损坏打断对话）')

/* ================= E. 博客检索缺口（N-7 §五 B+C） ================= */
console.log('\n=== E. blog.search 工具 + 边界声明 ===')
ok(/name: 'builtin\.blog\.search'/.test(rawBt), 'E1 builtin.blog.search 已注册（B 案：不动 knowledgeIndex 边界，给博客单独工具）')
const blogSearchDecl = rawBt.slice(rawBt.indexOf("name: 'builtin.blog.search'") - 400, rawBt.indexOf("name: 'builtin.blog.search'") + 900)
ok(/tier: 'ondemand'/.test(blogSearchDecl), 'E2 blog.search tier=ondemand（铁律 16：新工具默认折叠，≈7.7k tok/轮的常驻集不扩）')
ok(/readOnly: true/.test(blogSearchDecl) && /module: 'blog'/.test(blogSearchDecl),
  'E3 blog.search 只读 + 归 blog 模块（权限体系按模块预过滤）')
ok(/vaultSearchEntries\(q\)/.test(rawBt) && /import \{ vaultCreateEntry, vaultSearchEntries \} from '\.\/kbStore\/blogVaultRepo'/.test(rawBt),
  'E4 复用 blogVaultRepo 的 vaultSearchEntries（与博客 UI 同一份 .knowbase/blog 数据）')
const reqDesc = rawBt.slice(rawBt.indexOf("name: 'builtin.tool.request'"), rawBt.indexOf("name: 'builtin.tool.request'") + 1200)
ok(/blog\.search/.test(reqDesc),
  'E5 builtin.tool.request 的 description 清单补 blog.search（铁律 18：ondemand 工具的申请指路）')
const ksDesc = rawBt.slice(rawBt.indexOf("name: 'builtin.knowledge.search'"), rawBt.indexOf("name: 'builtin.knowledge.search'") + 700)
ok(/builtin\.blog\.search/.test(ksDesc),
  'E6 knowledge.search description 声明边界（C 案：消除「搜过了就是没有 → 乱找日程」）')

/* ================= F. IPC 三段链（preload ↔ types ↔ ipc.ts） ================= */
console.log('\n=== F. IPC 三段链对齐 ===')
const srcPreload = read('electron/preload/index.ts')
const srcTypes = read('src/types/index.ts')
const srcIpc = read('src/lib/ipc.ts')
for (const ch of ['assistantConstraintsEnsureGlobal', 'assistantConstraintsEnsureSession', 'assistantConstraintsEnsureGlossary']) {
  ok(srcPreload.includes(ch), `F1 preload 暴露 ${ch}`)
  ok(srcTypes.includes(ch), `F2 types/ElectronAPI 声明 ${ch}`)
  ok(srcIpc.includes(ch), `F3 ipc.ts 封装 ${ch}`)
}
const srcMain = stripComments(read('electron/main/index.ts'))
ok(/registerAssistantConstraintsHandlers\(\)/.test(srcMain) && /import \{ registerAssistantConstraintsHandlers \} from '\.\.\/lib\/assistantConstraints'/.test(srcMain),
  'F4 主进程注册 assistantConstraints handlers')

/* ================= G. 面板常驻入口（拍板④⑤，三处宿主） ================= */
console.log('\n=== G. AssistantEntry 三处宿主接线 ===')
const srcEntry = stripComments(read('src/components/shared/AssistantPanel/AssistantEntry.tsx'))
const srcPanel = stripComments(read('src/components/shared/AssistantPanel/index.tsx'))
const srcChatBody = stripComments(read('src/components/shared/AssistantPanel/ChatBody.tsx'))
const srcAiSide = stripComments(read('src/components/shared/AssistantPanel/AiChatSidebar.tsx'))
ok(/data-wb="assistantEntryBtn"/.test(srcEntry) && /data-wb="assistantEntryMenu"/.test(srcEntry),
  'G1 入口按钮 + 条目浮层（契约锚点在位）')
ok(srcPanel.includes('<AssistantEntryButton activeId={chat.activeId} />'),
  'G2 悬浮侧栏头部接线（拍板④：与 ☰/⤢/✕ 同排）')
ok(srcChatBody.includes('<AssistantEntryButton activeId={activeId} />'),
  'G3 右栏 AI 态轻头部接线（docked 宿主）')
ok(srcAiSide.includes('<AssistantEntryButton activeId={activeId} />'),
  'G4 aiChat 标签左栏会话侧栏接线（page 宿主，轻头部在该态不渲染）')
ok(/from: 'aiChat'/.test(srcEntry),
  'G5 跳转带 from:\'aiChat\'（吃 N-4 返回 chip 链：kb-open-note → 页面条「← 返回 AI对话」）')
ok(/disabled=\{!activeId\}/.test(srcEntry),
  'G6 会话条目无会话时禁用（会话文件夹只能挂在真实会话上）')
ok(/assistantConstraintsEnsureGlobal|assistantConstraintsEnsureSession|assistantConstraintsEnsureGlossary/.test(srcEntry) === true
  && ['assistantConstraintsEnsureGlobal', 'assistantConstraintsEnsureSession', 'assistantConstraintsEnsureGlossary'].every(fn => srcEntry.includes(fn)),
  'G7 三个条目分别走对应 ensure IPC（点哪个跳哪个，跳前 ensure 落文件）')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`❌ ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
