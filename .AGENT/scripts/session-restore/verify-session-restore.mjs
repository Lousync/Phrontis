#!/usr/bin/env node
/**
 * 契约验证：分屏「内容指针」留存（2026-11-07 轮）。
 *
 * 为什么需要它：这一轮的失败模式全是**静默的** ——
 * ① workbenchLayout 新键解析写错（类型不对没丢弃 / 坏 JSON 炸启动）→ 恢复漂移或启动报错；
 * ② 恢复路径不过存在性校验 → 已删/改名页在重启后变成幽灵页签，点了没反应；
 * ③ AiTeachNav.arts 若把 content/pages 这类重数据写进 localStorage → 每次工件变化全量落盘，
 *    localStorage 膨胀且把「页签=指针」的契约打破；
 * ④ knowledge 恢复守卫丢了 → 加载期空数组把存档清掉（表象：重启后页签全没，无任何报错）；
 * ⑤ 助手恢复与日程助手「一天一个会话」打架 → 打开右栏 AI 被错误拉进昨天会话。
 *
 * 验证的是「持久化契约 + 恢复守卫」，不是「代码能不能跑」：
 *   §1 workbenchLayout 新键解析（strip-types 直跑，钝解析行为表）
 *   §2 App.tsx 恢复/写回 effect 与合法性校验
 *   §3 knowledge 页签指针：rootId 键 + loading 守卫 + 存在性校验
 *   §4 AI 教学 arts：只存 rel/kind/name + openSession 整组恢复 + silent
 *   §5 助手 lastSid：按来源分键 + autoResumeToday 互斥
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/session-restore/verify-session-restore.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseWorkbenchLayout, DEFAULT_WORKBENCH_LAYOUT } from '../../../src/lib/workbenchLayout.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
/** 去注释：块注释 + 行注释（契约断言只看代码本体，注释里的旧口径不算数） */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')

let failures = 0
const ok = (cond, label, detail = '') => {
  if (!cond) failures++
  console.log(`  ${cond ? '[OK]' : 'FAIL'} ${label}${!cond && detail ? '  -> ' + detail : ''}`)
}

console.log('=== §1 workbenchLayout 新键解析（strip-types 直跑） ===')
ok(typeof DEFAULT_WORKBENCH_LAYOUT.lastActiveTab === 'string' || DEFAULT_WORKBENCH_LAYOUT.lastActiveTab === null,
  'D1 DEFAULT.lastActiveTab 为 string|null')
ok(Array.isArray(DEFAULT_WORKBENCH_LAYOUT.lastOpenTabs) && DEFAULT_WORKBENCH_LAYOUT.lastOpenTabs.length === 0,
  'D2 DEFAULT.lastOpenTabs 为空数组')

const t = (raw) => parseWorkbenchLayout(raw)
ok(t(null).lastActiveTab === null && t(undefined).lastActiveTab === null,
  'P1 无存档 -> lastActiveTab=null（不炸）')
ok(t('{bad json').lastOpenTabs.length === 0, 'P2 坏 JSON 整体走默认（外壳状态坏了绝不炸启动）')
ok(t('{"lastActiveTab":42}').lastActiveTab === null, 'P3 类型不对的 lastActiveTab 被丢弃')
ok(t('{"lastActiveTab":"knowledge"}').lastActiveTab === 'knowledge', 'P4 合法 string 被收录')
ok(t('{"lastOpenTabs":["knowledge",1,null,"tool:demo",""]}').lastOpenTabs.join(','),
  'P5 lastOpenTabs 只收非空 string（数字/null/空串丢弃）', t('{"lastOpenTabs":["knowledge",1,null,""]}').lastOpenTabs.join(','))
ok(t('{"lastOpenTabs":"knowledge"}').lastOpenTabs.length === 0, 'P6 非数组的 lastOpenTabs 走默认')

console.log('\n=== §2 App.tsx 恢复/写回 effect ===')
{
  const src = stripComments(read('src/App.tsx'))
  ok(/tabsRestoredRef/.test(src), 'A1 存在一次性恢复守卫 tabsRestoredRef')
  ok(/lastOpenTabs\.filter\(\(t\) => isTabName\(t\)/.test(src),
    'A2 恢复路径逐项过 isTabName（不合法标签静默剔除）')
  ok(/!WORKBENCH_TABBAR_EXCLUDED\.includes\(t\)/.test(src),
    'A3 整窗/图标条面板不进恢复清单（它们不进标签条）')
  ok(/t !== 'vocab' \|\| VOCAB_ENTRY_ENABLED/.test(src),
    'A4 vocab 入口关闭时不恢复（与既有 activeTab 纠偏 effect 同规）')
  ok(/lastOpenTabs: nextTabs, lastActiveTab: nextActive/.test(src),
    'A5 写回把两个键一并落盘（结构对齐 pageSplit 写回）')
  ok(/lastModuleTabRef\.current/.test(src),
    'A6 工具/情报页签激活（activeTab=null）时落盘兜底到最后模块标签')
}

console.log('\n=== §3 knowledge 页签指针 ===')
{
  const src = stripComments(read('src/modules/knowledge/index.tsx'))
  ok(/kb\.knowledge\.pages\.\$\{rootId\}|kbPagesKey\(/.test(src) && /const kbPagesKey = \(rootId: string\)/.test(src),
    'K1 存储键带 rootId（页 id 是仓库身份，跨库不得串）')
  ok(/pagesRestoredRef\.current !== kbRootId/.test(src) && /pagesRestoredRef\.current === kbRootId\) return/.test(src),
    'K2 恢复一次性守卫 + 写回以「已恢复」为前提（加载期空数组不得清存档）')
  ok(/if \(!kbRootId \|\| loading \|\|/.test(src),
    'K3 恢复等 loading 结束（首拉未完成时 allPages 为空，会把存档误判为全部失效）')
  ok(/typeof x === 'string' && known\.has\(x\)/.test(src),
    'K4 恢复过存在性校验（改名/删除/进 ignore 的页静默剔除）')
  ok(/onRemoveSecondary\?\.\(sid\)/.test(src),
    'K5 副栏页签同样过校验，缺失走 onRemoveSecondary（PageSplitLayout「模块二次净化」承诺）')
  ok(/setOpenPageIds\(ids\)/.test(src) && !/pagesRestored[\s\S]{0,400}handleOpenPage/.test(src),
    'K6 恢复直接 setState（不污染导航历史 / 不触发预览槽替换）')
}

console.log('\n=== §4 AI 教学 arts 指针 ===')
{
  const src = stripComments(read('src/modules/ai-teaching/index.tsx'))
  ok(/arts\?: Array<\{ rel: string; kind: ArtTab\['kind'\]; name\?: string \}>/.test(src),
    'T1 AiTeachNav.arts 类型只含 rel/kind/name')
  ok(/arts: artTabs\.filter\(x => !x\.generating && x\.rel\)\.map\(x => \(\{ rel: x\.rel, kind: x\.kind, name: x\.name \}\)\)/.test(src),
    'T2 写盘只映射 rel/kind/name；生成中占位与空 rel 不入档')
  ok(!/arts: artTabs[\s\S]{0,200}(content:|pages:|bytes:)/.test(src),
    'T3 负向：arts 不得写入 content/pages/bytes 等重数据（localStorage 膨胀防线）')
  ok(/artActiveRel: artActive && !artActive\.startsWith\('gen:'\)/.test(src),
    'T4 gen: 占位不得成为激活落盘值')
  ok(/if \(nav\.arts\?\.length\)/.test(src) && /openArtFile\(a\.rel, \{ silent: true/.test(src),
    'T5 openSession 优先整组恢复，恢复路径走 silent（文件已删静默跳过）')
  ok(/else if \(nav\.docRel\)|else if \(nav\.readerRel/.test(src),
    'T6 旧存档（无 arts）回落单工件字段，向后兼容')
  ok(/activeIdRef\.current !== sid\) return/.test(src.replace(/[\s\S]*?(?=if \(nav\.arts)/, '').slice(0, 500)),
    'T7 恢复期间切走会话不回落激活页（结果属于发起恢复的那个会话）')
  ok(/silent\?: boolean/.test(src) && (src.match(/!opts\?\.silent/g) || []).length >= 3,
    'T8 openArtFile 的 silent 闸住全部错误 Toast 路径（pptx/无仓库/读文档失败）')
}

console.log('\n=== §5 助手 lastSid ===')
{
  const src = stripComments(read('src/components/shared/AssistantPanel/useAssistantChat.ts'))
  ok(/assistant\.lastSid\.\$\{draftSource\}/.test(src),
    'S1 键按来源分（assistant/schedule 各存各的，同表分流不串）')
  ok(/if \(!active \|\| autoResumeToday\) return/.test(src),
    'S2 日程助手走「一天一个会话」，不参与本恢复（互斥）')
  ok(/activeIdRef\.current\) return[\s\S]{0,300}list\.some\(s => s\.id === saved\)/.test(src),
    'S3 已有活动会话不恢复 + 存档 id 不在列表内静默放弃（已删/换库）')
  ok(/if \(!activeId\) return/.test(src.split('assistant.lastSid.')[1] ?? ''),
    'S4 只在有活动会话时写指针（取消选中不清指针）')
}

console.log(failures === 0 ? '\nPASS（契约全部满足）' : `\nFAIL（${failures} 项不满足）`)
process.exit(failures === 0 ? 0 : 1)
