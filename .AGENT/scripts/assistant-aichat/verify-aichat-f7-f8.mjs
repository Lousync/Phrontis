// 契约验证：正式版台账 F-7 / F-8（2026-10-05）
//
// F-7  aiChat 整页对话流的「回到底部」浮标：公共 MessageList 新增 jumpBottom 门控，
//      只有 ChatBody variant='page' 开启 —— 悬浮侧栏 / 右栏 docked / AiLearn 不开，
//      且未开启的宿主 DOM 结构必须原样（AiLearn 把 MessageList 根当 flex 子项用）。
// F-8  aiChat 整页划词「问 AI」就地接管：AiChatTab 注册 selection-ask 宿主（active 门），
//      选段收进本页引用胶囊（不自动发送）；引用合并格式单一真源 = selQuotes.ts 的
//      buildQuotedBody，悬浮侧栏与整页共用，禁止再出现内联副本（格式漂移会让两侧
//      发出的引用块不一致，且静默）。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/assistant-aichat/verify-aichat-f7-f8.mjs
// 期望：全部 PASS 且 exit=0

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildQuotedBody } from '../../../src/components/shared/AssistantPanel/selQuotes.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '[OK]' : '[FAIL]'} ${name}${ok || !detail ? '' : ` -- ${detail}`}`)
  if (!ok) failed++
}

// ── 一、buildQuotedBody 真函数断言（格式单一真源）───────────────────────────────
check('空引用 → 原文透传', buildQuotedBody([], '你好') === '你好')
check('空引用且无输入 → 空串', buildQuotedBody([], '') === '')
check('单条引用合并格式', buildQuotedBody(['第一段'], '问题') === '> 【引用 1】第一段\n\n问题')
check('多条引用逐行累积', buildQuotedBody(['甲', '乙'], '') === '> 【引用 1】甲\n> 【引用 2】乙')
check('空白折叠', buildQuotedBody(['a\n  b\tc'], '') === '> 【引用 1】a b c')
check('超 600 字截断加省略号', buildQuotedBody(['x'.repeat(601)], '') === `> 【引用 1】${'x'.repeat(600)}…`)
check('纯空白引用被过滤', buildQuotedBody(['   '], '问题') === '问题')

// ── 二、F-7：MessageList 浮标门控 ──────────────────────────────────────────────
const ml = read('src/components/shared/AssistantPanel/MessageList.tsx')
check('MessageList 有 jumpBottom 开关（默认关）', /jumpBottom = false/.test(ml))
check('未开启时原样返回（AiLearn 兼容）', ml.includes('if (!jumpBottom) return list'))
check('浮标仅包在 relative 宿主层内', /if \(!jumpBottom\) return list[\s\S]*relative h-full[\s\S]*kb-pop absolute right-3 bottom-3/.test(ml))
check('浮标进场走 kb-pop 动效令牌', ml.includes('kb-pop absolute right-3 bottom-3'))
check('浮标未用禁用的 transition-all', !ml.includes('transition-all'))
check('浮标点击回底有 rAF 补帧', /jumpToBottom[\s\S]*?requestAnimationFrame\(/.test(ml))

const cb = read('src/components/shared/AssistantPanel/ChatBody.tsx')
check('ChatBody 仅 page 态开浮标', cb.includes('jumpBottom={variant === \'page\'}'))

const aiLearn = read('src/components/shared/AiLearn/index.tsx')
check('AiLearn 未传 jumpBottom（行为不回归）', !aiLearn.includes('jumpBottom'))

// ── 三、F-8：AiChatTab 划词接管 + 引用胶囊 ─────────────────────────────────────
check('AiChatTab 注册划词宿主', cb.includes('registerSelectionAskHost'))
check('宿主注册挂 active 门（display:none 保活防抢划词）', /useEffect\(\(\) => \{\s*\n\s*if \(!active\) return\s*\n\s*return registerSelectionAskHost\(/.test(cb))
check('接管行为 = 引用胶囊（不自动发送）', /setSelQuotes\(prev => \{[\s\S]*?selQuotesRef\.current = next/.test(cb))
check('接管后聚焦输入区', /chat\.inputRef\.current\?\.focus\(\)/.test(cb))
check('整页输入区挂引用胶囊插槽', cb.includes('inputTop={quoteRow}'))
check('整页 prepareBody 走共享合并函数', /prepareBody: useCallback\(\(raw: string\) => \{[\s\S]*?buildQuotedBody\(qs, raw\)/.test(cb))

const ap = read('src/components/shared/AssistantPanel/index.tsx')
check('悬浮侧栏 prepareBody 同走共享函数', ap.includes('return buildQuotedBody(qs, raw)'))
check('内联合并格式已从悬浮侧栏移除（防格式漂移）', !ap.includes('> 【引用'))
check('内联合并格式已从 ChatBody 移除', !cb.includes('> 【引用'))

// ── 四、引用上限单一真源 ───────────────────────────────────────────────────────
const sq = read('src/components/shared/AssistantPanel/selQuotes.ts')
check('截断上限 600 只在 selQuotes.ts 定义', (sq.match(/600/g) ?? []).length >= 1
  && !ml.includes('600') && !cb.includes('slice(0, 600)'))

console.log(failed === 0 ? 'PASS' : `FAIL (${failed} 项)`)
process.exit(failed === 0 ? 0 : 1)
