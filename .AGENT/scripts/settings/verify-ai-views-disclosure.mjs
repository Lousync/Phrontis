#!/usr/bin/env node
/**
 * AI 设置区「披露 + 交互」契约（2026-10-14 随 v3.7.0 改版新增）。
 *
 * 背景：v3.7.0 把设置 → AI 六页改成「一行一物 · 点开才说 · 解释走 ⓘ」。
 * 这套口径有两类**会悄悄退化**的东西，而 `tsc` 与既有契约都测不出来：
 *
 *   A. 常显文案长回来。判据不能是「有没有某段文字」（说明是允许存在的），也不能只看结构
 *      （`verify-ai-tab-anchors.mjs` §8① 只认「</h2> 紧跟 <p>」一种形态）。所以这里改成
 *      **明文白名单**：视图里每个常显 `<p>` 段都必须命中白名单里的某一条（空态引导 /
 *      不可逆警告 / 故障诊断 / 指路），命中不了就是 FAIL —— 逼着后来者显式说明"这段为什么必须常显"。
 *
 *   B. 浮层退回就地绝对定位。折叠容器的内层 `overflow: hidden` 会把就地 absolute 的
 *      菜单/下拉裁掉半个（真机踩过）。所以负向断言：AI 视图里不得再出现
 *      `left-0 right-0 top-full` 这类就地下拉；面板一律走 `AnchoredLayer`（挂 body）。
 *
 * 另外钉住两件"改版时特意做对"的事：
 *   · 测试入口是 lucide 的 `Zap` 图标，**不是 emoji 字形**（emoji 在不同字体下大小/基线不一致）；
 *   · `.kb-hoveronly` 必须保留占位（只用 opacity，不许 display / visibility / max-width），
 *     否则鼠标划过时同行元素会位移跳版；且必须有 `:focus-within` 键盘兜底与 `.is-peek` 临时常显。
 *
 * 跑法：node .AGENT/scripts/settings/verify-ai-views-disclosure.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

/** 视图清单（六个页签 + 两个"每个页签都在用"的共用件） */
const VIEWS = [
  'src/modules/settings/views/AiModelsTab.tsx',
  'src/modules/settings/views/AiPermissionsTab.tsx',
  'src/modules/settings/views/AiToolsView.tsx',
  'src/modules/settings/views/AiUsageTab.tsx',
  'src/modules/settings/views/AiTeachingView.tsx',
  'src/modules/settings/views/AiToolsAdvanced.tsx',
  'src/modules/settings/components/SettingListPanel.tsx',
  'src/modules/settings/components/SettingsGroup.tsx',
]

/** 去掉注释再扫：注释里出现 ⚡ / 别名只是"说明这件事"，不该被当成界面文案 */
const stripComments = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/^[ \t]*\*.*$/gm, '')

const src = VIEWS.map(rel => ({ rel, raw: read(rel) }))
const srcNoComment = src.map(v => ({ rel: v.rel, text: stripComments(v.raw) }))

// ===== 1. 常显段落白名单 =====
//
// 每条 = 一个必须出现在**该段自身**（`<p>` 到 `</p>` 之间）的标记。
// 分四类，与 `docs/help-disclosure-pattern.md` 的白名单一一对应；每条后面写清"为什么它必须常显"——
// 写不出理由的，就应该改成 ⓘ 悬停或删掉（这正是这道闸要拦的）。
//
// ⚠ 模态内的文案（MCP 添加向导 / CC Switch 导入）也在扫描范围内、也必须在册：
//   它们是"填到一半才看得到"的说明，收起来用户就没法边看边填了。
const ALWAYS_ON_ALLOW = [
  // ① 空态引导
  ['尚未配置供应商', '空态：还没有任何供应商，这句话本身就是入口指路'],
  ['还没有模型清单', '空态：该端点尚未拉过模型清单'],
  ['本月还没有模型调用记录', '空态：用量明细为空时的占位（2026-10-15 用量页方案 D 重排新增），没有它整块就是空白'],
  ['尚未添加 MCP 服务器', '空态：还没加过 MCP 服务器'],
  ['暂无已安装的 Skill', '空态：还没装过 Skill（含安装方式说明）'],
  ['暂无调用记录', '空态：审计日志还没有条目'],
  ['暂无条目', '空态：通用列表组件（SettingListPanel）的空列表提示'],
  ['读取中…', '进行中：CC Switch 导入弹层的读取态'],
  // ② 不可逆 / 边界说明（动手前的最后一道说明，收起来就是挖坑）
  ['AI 的写操作将', '不可逆警告：写权限开启后 AI 的改动直接生效'],
  ['此类型将在', '不可逆警告：stdio 型 MCP 会在本机执行任意命令'],
  ['保存后服务器处于', '行为说明：新加的 MCP 服务器默认禁用，不写清会以为没生效'],
  ['「跟随」的槽位（留空项）', '边界说明：批量改槽位不碰"跟随"的槽位'],
  ['单个对话自身的模型覆盖', '边界说明：本会话的模型覆盖不在批量改动范围内'],
  // ③ 故障诊断（出问题时必须当场看见，否则只能靠猜）
  ['该端点没有可用账号', '诊断：为什么这个端点的模型不出现在选择器里'],
  ['mascotDiagText', '诊断：吉祥物读不到 / 没启用 / 没加载起来的五种真相'],
  ['sofficeProbe', '即时反馈：LibreOffice 探到了没有、从哪儿探到的'],
  ['」连接失败', '诊断：MCP 服务器连不上，附原始错误'],
  ['当前为 opencode 旧地址', '诊断 + 一键修复入口：旧地址少了 10 个模型'],
  ['该地址未经在线核实', '提醒：这个预设的地址没联网复核过'],
  // ④ 指路 / 数据行（是导航或数据，不是对设置的复述）
  ['图片视觉转写模型不在本页', '指路：本页找不到它时告诉用户它其实在「模型」页'],
  ['接口地址：', '数据行：预设替你填好的地址（预设防呆的明写部分）'],
  ['按供应商/模型细分', '数据行：下面那串数字是哪个维度的细分'],
  ['来源：', '数据行：CC Switch 数据库路径'],
  ['未检测到 CC Switch', '故障提示：本机没装 / 没扫到（含获取入口）'],
  ['已检测到 CC Switch，但没有可导入的供应商', '故障提示：装是装了，里面没有可导入的项'],
  ['一键导入需本机已安装', '操作前置条件：不说清会以为软件坏了'],
  // ④ 防呆明写（预设添加表单：把"预设替你填了什么"摆出来，原型专门要求不藏进高级）
  ['预设带上', '防呆：预设替你填了哪些你本来不可能知道的东西（如会话头）'],
  ['要你补一步', '防呆：这个预设还差一样（接入点 ID），不说会被当成漏填'],
  ['preset.modelHint', '防呆：该平台模型那一栏怎么填的指路'],
  ['按官方文档', '出处标注 + 旧地址提醒（预设的地址与会话头取自 opencode 官方端点表）'],
]

console.log('\n[常显文案] 只有白名单里的四类能常驻（空态 / 不可逆警告 / 故障诊断 / 指路）')
{
  const offenders = []
  const PARA_RE = /<p\b[^>]*className="[^"]*text-\[1[0-9][^"]*"[^>]*>/g
  let seen = 0
  for (const v of srcNoComment) {
    PARA_RE.lastIndex = 0
    let m
    while ((m = PARA_RE.exec(v.text))) {
      seen++
      const start = m.index + m[0].length
      // 只取这一段**自身**的内容：到最近的 </p> 为止（取固定窗口会溢出到下一个元素，那是假阳性大户）
      const endIdx = v.text.indexOf('</p>', start)
      const body = v.text.slice(start, endIdx === -1 ? start + 400 : endIdx)
      const hit = ALWAYS_ON_ALLOW.find(([mark]) => body.includes(mark))
      if (!hit) offenders.push(`${v.rel}: ${body.replace(/\s+/g, ' ').slice(0, 70)}`)
    }
  }
  check(`扫到 ${seen} 个常显说明段（若为 0 说明扫描坏了，不是"很干净"）`, seen > 0, String(seen))
  check('负向：每个常显说明段都命中白名单（空态 / 不可逆警告 / 故障诊断 / 指路）',
    offenders.length === 0, offenders.join(' | '))
  check('白名单本身有登记（否则上一条是空断言）', ALWAYS_ON_ALLOW.length >= 8, String(ALWAYS_ON_ALLOW.length))
}

// ===== 2. 测试入口：lucide Zap 图标，不是 emoji =====

console.log('\n[连通性入口] 图标按钮 + 悬停显形')
{
  const models = read('src/modules/settings/views/AiModelsTab.tsx')
  const zapUses = [...models.matchAll(/<Zap size=\{\d+\}/g)].length
  check(`模型页三处测试入口都用 lucide \`Zap\`（实际 ${zapUses} 处）`, zapUses >= 3, String(zapUses))
  check('模型页确实 import 了 Zap', /import \{[^}]*\bZap\b[^}]*\} from 'lucide-react'/.test(models))

  const emoji = srcNoComment.filter(v => /[\u26A1\u2728\u2B50]/.test(v.text)).map(v => v.rel)
  check('负向：AI 视图里不用 emoji 当图标（⚡ / ✨ / ⭐ 一律改成 lucide 组件）',
    emoji.length === 0, emoji.join(', '))

  // 悬停动作：端点行 ⚡ / 账号行 ⚡ / 账号 ⋯ / 模型行 ⚡ 都该裹着它（类名有的是模板串、有的是普通串）
  const hoverCount = [...models.matchAll(/kb-hoveronly/g)].length
  check(`模型页的悬停动作确实裹了 .kb-hoveronly（${hoverCount} 处）`, hoverCount >= 5, String(hoverCount))
  check('保存后的临时常显用模板串拼 is-peek（不是两套 class）',
    /kb-hoveronly \$\{peek \? 'is-peek' : ''\}/.test(models))
}

// ===== 3. .kb-hoveronly 的规格（保留占位 + 键盘兜底 + 临时常显） =====

console.log('\n[悬停显形] .kb-hoveronly 规格')
{
  const css = read('src/styles/index.css')
  const block = css.match(/\.kb-hoveronly \{[\s\S]*?\}/)
  check('.kb-hoveronly 在 index.css 里有定义', !!block)
  if (block) {
    check('用 opacity 隐藏（保留占位）', /opacity:\s*0/.test(block[0]))
    check('负向：不用 display / visibility / max-width 隐藏（那会让同行元素位移跳版）',
      !/display\s*:|visibility\s*:|max-width\s*:\s*0/.test(block[0]), block[0].replace(/\s+/g, ' '))
  }
  check('宿主 :hover 与 :focus-within 都会显形（键盘 Tab 到该行同样看得到）',
    /\.kb-hoveronly-host:hover \.kb-hoveronly/.test(css) && /\.kb-hoveronly-host:focus-within \.kb-hoveronly/.test(css))
  check('.is-peek 临时常显在（保存成功后亮 3 秒用的）', /\.kb-hoveronly\.is-peek\s*\{\s*opacity:\s*1/.test(css))
  const models = read('src/modules/settings/views/AiModelsTab.tsx')
  check('保存成功后给该行挂 is-peek 并定时摘除', models.includes("is-peek") && models.includes('3000'))
  check('reduced-motion 下关掉过渡', /\.kb-hoveronly \{ transition: none; \}/.test(css))
}

// ===== 4. 浮层必须挂 body（不许就地绝对定位） =====

console.log('\n[浮层] 菜单 / 下拉一律走 AnchoredLayer（portal）')
{
  const inPlace = srcNoComment.filter(v => /left-0 right-0 top-full/.test(v.text)).map(v => v.rel)
  check('负向：AI 视图里没有就地绝对定位的下拉（会被折叠容器的 overflow:hidden 裁掉半个）',
    inPlace.length === 0, inPlace.join(', '))

  for (const rel of [
    'src/components/shared/HelpHint.tsx',
    'src/modules/settings/components/RowMenu.tsx',
    'src/modules/settings/views/AiModelPicker.tsx',
    'src/modules/settings/components/SettingListPanel.tsx',
  ]) {
    check(`${rel.split('/').pop()} 走 AnchoredLayer`, read(rel).includes('AnchoredLayer'))
  }
  const anchorLayer = read('src/components/shared/AnchoredLayer.tsx')
  check('AnchoredLayer 挂到 body', anchorLayer.includes('createPortal') && anchorLayer.includes('document.body'))
  check('浮层越界会夹回视口（锚点自身可能在视口外）',
    anchorLayer.includes('window.innerHeight - EDGE'))
  check('浮层内部滚动不算"页面滚了"（下拉列表可滚）',
    anchorLayer.includes('layerRef.current.contains(e.target)'))
}

// ===== 5. 折叠分组：外层常驻、内层懒挂 =====

console.log('\n[折叠] SettingsGroup 的外层常驻 / 内层懒挂')
{
  const g = read('src/modules/settings/components/SettingsGroup.tsx')
  check('用 .kb-collapse（既有高度动画令牌，不另造过渡）', g.includes('kb-collapse'))
  check('外层 grid 容器常驻、内层按 open || mounted 懒挂（展开才有起始态可过渡）',
    g.includes('open || mounted'))
  check('用 usePresence 延迟卸载（收起动画播完才卸）', g.includes('usePresence'))
  check('多锚点自动展开：anchorIds 认领 + 订阅', g.includes('claimPendingAnchor') && g.includes('subscribePendingAnchor'))
  check('标题行不套大按钮（ⓘ / 摘要 / 右侧动作是兄弟节点，否则嵌套 button 会被拆 DOM）',
    !/<button[\s\S]{0,400}<HelpHint/.test(g))
}

// ===== 6. 教学页那句指路（本轮修的缺陷） =====

console.log('\n[缺陷复查] 教学页的指路句真的渲染了')
{
  const teach = read('src/modules/settings/views/AiTeachingView.tsx')
  check('指路句以 JSX 文本渲染（不是注释）', /<p[^>]*>[\s\S]{0,80}图片视觉转写模型不在本页/.test(teach))
  check('负向：不再有"只留一句指路"这种只存在于注释里的自述',
    !/只留一句指路/.test(teach), '源码注释声称留了指路、界面却没有 —— 这正是本轮修掉的缺陷')
}

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
