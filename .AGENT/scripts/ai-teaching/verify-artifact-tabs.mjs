/**
 * 契约：AI 教学工件栏页签条的溢出可达性（v3.16.1 F-3）。
 *
 * 失败模式：页签条自己 `overflow-x-auto` + 隐藏滚动条，但没有滚轮横滚 / 渐隐 / 激活归位，
 * 鼠标用户够不到被裁掉的页签；更糟的是 ⤢ 全屏按钮和页签在同一个滚动容器里，页签一多
 * 按钮跟着滚出视野（功能入口直接消失）。
 *
 * 修法：复用页面条的 `useStripScroll` + `StripEdges`，并把固定动作移出滚动容器。
 *
 * 跑法：node .AGENT/scripts/ai-teaching/verify-artifact-tabs.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const read = (p) => stripComments(readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n'))

const pane = read('src/modules/ai-teaching/ArtifactsPane.tsx')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

console.log('=== A. 复用页面条溢出基建 ===')
ok(/import \{ useStripScroll, StripEdges \} from '\.\.\/\.\.\/components\/workbench\/useStripScroll'/.test(pane),
  'A1 import useStripScroll / StripEdges')
ok(/const strip = useStripScroll\(`\$\{activeId \?\? ''\}\|\$\{tabs\.length\}`\)/.test(pane),
  'A2 revealKey = 激活页签 + 页签数（切换 / 新增都会归位）')
ok(/ref=\{strip\.setNode\}/.test(pane), 'A3 滚动容器挂 strip.setNode')
ok(/<StripEdges edges=\{strip\.edges\} \/>/.test(pane), 'A4 渲染左右渐隐')
ok(/kb-edge-strip/.test(pane), 'A5 滚动容器走 .kb-edge-strip（隐藏滚动条，渐隐替代提示）')
ok(/data-wb-active=\{t\.id === activeId \? '1' : '0'\}/.test(pane),
  'A6 每个页签带 data-wb-active（useStripScroll 的激活选择器契约）')

console.log('\n=== B. 固定动作与可滚内容分离 ===')
ok(!/flex-1 min-w-\[8px\]/.test(pane), 'B1 旧的 flex-1 占位已删除（它会把 ⤢ 推进滚动区）')
ok(/<\/div>\s*<StripEdges edges=\{strip\.edges\} \/>\s*<\/div>\s*(?:\{\s*\})?\s*\{tab && !tab\.generating && tab\.rel && \(/.test(pane),
  'B2 ⤢ 按钮位于滚动容器与 StripEdges 之后（结构上不参与横向滚动）')
ok(/className="shrink-0 flex items-center gap-0\.5 px-2 pt-1\.5 pb-0 select-none"/.test(pane),
  'B3 页签行外层只负责左右布局，不再自己 overflow-x-auto')
ok(!/overflow-x-auto[^"]*\[scrollbar-width:none\]/.test(pane),
  'B4 负向：不再使用「隐藏滚动条且无提示」的裸滚动容器')

console.log('\n=== C. 行为口径（纯函数契约由 verify-strip-overflow 覆盖）===')
ok(/items-center gap-0\.5 overflow-x-auto/.test(pane), 'C1 滚动容器保留 flex 单行不换行')
ok(/max-w-\[170px\]/.test(pane), 'C2 页签宽度上限不变（外观不回归）')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
