/**
 * 契约：全局「插件」概念图标 = 箱子（2026-09-22 B-9）
 *
 * 锁三件事：
 *   ① **概念图标唯一** —— 「插件」这个概念全仓 15 处必须用 StyleAware 的 `PluginIcon`。
 *      直接用 lucide 名（`<Package …>`）当下看着一样，但用户把「设置→外观→侧边栏图标风格」
 *      切成手绘 / 插件图标包后**这些地方不跟随**、而左栏跟随 → 又一轮不一致。
 *      这正是 B-9 的成因：左栏 2026-09-17 就改成了箱子，其余 15 处直到 09-21 才发现还是拼图
 *      （list-drift 的典型形态：同一个图标被抄成多份）。
 *   ② **白名单是唯一例外** —— web-clipper 的拼图**必须保留**：那是「安装浏览器扩展」，
 *      Chrome 应用商店即拼图，是该场景的正确语汇。所以这里用的是**白名单**而非「全仓零命中」，
 *      否则下一次有人"顺手统一"就会把它一起改错。
 *   ③ **空态线宽**（B-9 实施要点 2）—— `IconProps` 必须能传 `strokeWidth`：40px 空态大图标
 *      原本就是 1.2，而手绘包默认 1.6，大尺寸下粗一档肉眼可辨。
 *
 * 跑法：node --experimental-strip-types .AGENT/scripts/plugin-icons/verify-plugin-icons.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments, walkSourceFiles } from '../shared/strip-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const read = (p) => stripComments(readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n'))

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(detail ? `${label}\n      ${detail}` : label)
  return false
}

/* ================= A. 概念图标唯一（唯一例外 = web-clipper） ================= */
console.log('\n=== A. 全 src 不得再有「插件概念 = 拼图」 ===\n')

const WHITELIST = ['src/modules/toolbox/components/web-clipper/index.tsx']
const srcFiles = walkSourceFiles(join(repo, 'src'), { skip: (p) => p.includes('vendor') })
ok(srcFiles.length > 100,
  'A1 源码遍历有效（防 skip 写错导致"空集假通过"）',
  `实际扫到 ${srcFiles.length} 个文件`)

const hits = []
for (const f of srcFiles) {
  const rel = f.slice(repo.length + 1).replace(/\\/g, '/')
  const body = stripComments(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))
  if (/\bPuzzle\b/.test(body)) hits.push(rel)
}
const unexpected = hits.filter((f) => !WHITELIST.includes(f))
ok(unexpected.length === 0,
  'A2 ★ 全 src 剥注释后 `Puzzle` 只出现在白名单（web-clipper）',
  unexpected.length ? '越界命中：' + unexpected.join('、') : '')

// 反向断言：白名单那处**必须仍在** —— 防「顺手统一」把浏览器扩展的拼图也改掉
const clipper = read(WHITELIST[0])
ok(/<Puzzle size=\{12\}/.test(clipper) && /安装浏览器扩展/.test(clipper),
  'A3 ★ 白名单反向断言：web-clipper 的「安装浏览器扩展」拼图仍在（Chrome 应用商店语汇）', '')

/* ================= B. 15 处目标位置逐点接线 ================= */
console.log('\n=== B. 15 处「插件」概念图标全部走 StyleAware PluginIcon ===\n')

const SRC_PAGEBAR = read('src/components/workbench/WorkbenchPageBar.tsx')
const SRC_MARKET = read('src/modules/plugins/index.tsx')
const SRC_TOOLREG = read('src/components/workbench/toolRegistry.tsx')
const SRC_KNOW = read('src/modules/knowledge/index.tsx')
const SRC_SLOT = read('src/components/shared/PluginSlotEntry.tsx')
const SRC_BLOGT = read('src/modules/blog/components/BlogTemplateModal.tsx')
const SRC_ONB = read('src/components/shared/Onboarding.tsx')
const SRC_ICONIMG = read('src/components/shared/PluginIconImg.tsx')
const SRC_APPEAR = read('src/modules/settings/views/AppearanceView.tsx')

// 1 / 2 / 3 / 4 / 5 / 6 / 7 / 8 / 9 / 10-12 / 13 / 14
ok(/plugins: <PluginIcon size=\{14\} \/>/.test(SRC_PAGEBAR),
  'B1 页面条 plugins 页签图标（与左栏不齐的那处）', '')
ok(/<PluginIcon size=\{40\} strokeWidth=\{1\.2\}/.test(SRC_MARKET),
  'B2 插件市场空态大图标（本次起因，线宽仍为 1.2）', '')
ok(/<PluginIcon size=\{12\} \/>/.test(SRC_MARKET),
  'B3 插件市场左栏标题「插件」', '')
ok(/<PluginIcon size=\{12\} className="text-\[var\(--accent\)\]" \/>/.test(SRC_TOOLREG),
  'B4 插件工具页头部', '')
ok(/<PluginIcon size=\{14\} \/>/.test(SRC_KNOW) && /<PluginIcon size=\{12\} className="text-\[var\(--text-muted\)\]" \/>/.test(SRC_KNOW),
  'B5 知识库「插件视图入口」+ 全屏覆盖层头部（同文件两处）', '')
ok(/<PluginIcon size=\{14\} \/>/.test(SRC_SLOT) && /<PluginIcon size=\{12\} className="text-\[var\(--text-muted\)\]" \/>/.test(SRC_SLOT),
  'B6 PluginSlotEntry 两处（共享组件版，供其他模块用）', '')
ok(/<PluginIcon size=\{15\} className="text-\[var\(--accent\)\] shrink-0" \/>/.test(SRC_BLOGT),
  'B7 博客模板里「来自插件的模板」标记', '')
ok((SRC_ONB.match(/icon: PluginIcon/g) ?? []).length >= 1 && /<PluginIcon size=\{14\} \/>/.test(SRC_ONB),
  'B8 新手引导两处（模块卡片 / InfoRow；场景选择步骤已删）', '')
ok(/<PluginIcon size=\{size\} strokeWidth=\{1\.5\}/.test(SRC_ICONIMG),
  'B9 单个插件图标的兜底（PluginIconImg）', '')
ok(/<PluginIcon size=\{24\} \/>/.test(SRC_APPEAR),
  'B10 设置→外观「来自插件的主题」', '')

// 归一化断言：上述 9 个文件里不得再出现 lucide 名直写（B-9 实施要点 1 的防线）
const namedFiles = [
  ['WorkbenchPageBar.tsx', SRC_PAGEBAR], ['plugins/index.tsx', SRC_MARKET],
  ['toolRegistry.tsx', SRC_TOOLREG], ['knowledge/index.tsx', SRC_KNOW],
  ['PluginSlotEntry.tsx', SRC_SLOT], ['BlogTemplateModal.tsx', SRC_BLOGT],
  ['Onboarding.tsx', SRC_ONB], ['PluginIconImg.tsx', SRC_ICONIMG],
  ['AppearanceView.tsx', SRC_APPEAR],
]
const namedBad = namedFiles.filter(([, body]) => /<Package[\s/>]/.test(body)).map(([n]) => n)
ok(namedBad.length === 0,
  'B11 ★ 负向：这些位置不得直接写 lucide 名 `<Package …>`（会绕过 StyleAware，切图标风格时不跟随）',
  namedBad.length ? '命中：' + namedBad.join('、') : '')

/* ================= C. IconProps 线宽通道（B-9 实施要点 2） ================= */
console.log('\n=== C. IconProps / Svg 的 strokeWidth 通道 ===\n')

const SRC_ICONS = read('src/components/shared/ModuleIcons.tsx')
ok(/strokeWidth\?: number/.test(SRC_ICONS),
  'C1 IconProps 暴露可选 strokeWidth', '')
ok(/strokeWidth=\{strokeWidth \?\? 1\.6\}/.test(SRC_ICONS),
  'C2 ★ Svg 用调用方传入的线宽、缺省回 1.6（负向：不得忽略 props 写回裸 1.6）', '')
ok(!/strokeWidth=\{1\.6\}/.test(SRC_ICONS),
  'C3 ★ 负向：Svg 内不得再出现写死的 `strokeWidth={1.6}`', '')
ok(/<Fallback size=\{size\} className=\{className\} strokeWidth=\{strokeWidth\} \/>/.test(SRC_ICONS),
  'C4 StyleAware 把线宽透传给手绘包（classic140 / 插件 SVG 包各持自己的线宽，属既有设计）', '')

/* ================= D. helpDocs 默认图标名 ================= */
console.log('\n=== D. pluginService 的默认图标名 ===\n')

const SRC_SVC = read('src/lib/pluginService.ts')
ok(/: 'Package',/.test(SRC_SVC),
  'D1 helpDocs 缺 icon 时默认 `Package`（消费方是 lucide 名字解析）', '')
ok(!/:\s*'Puzzle',/.test(SRC_SVC),
  'D2 ★ 负向：默认名不得回到 `Puzzle`', '')

/* ================= 结果 ================= */
if (fails.length === 0) {
  console.log(`\nPASS  ${pass} 项断言全绿`)
  process.exit(0)
} else {
  console.log(`\nFAIL  ${pass} 通过 / ${fails.length} 失败\n`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
