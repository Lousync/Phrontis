#!/usr/bin/env node
/**
 * 设置 → AI → 模型页重做（2026-11-20，docs/settings-model-tab-rework-plan.md）的结构契约。
 *
 * 为什么需要它：这一轮改的全是「观感与层级」，`tsc` 与既有两个契约都测不出来，而退化方式都很安静：
 *   · 深色框线令牌被写回 --border-color（框线又看不见）；
 *   · 组合输入框退回「外壳一道 + input 一道」；
 *   · 页签丢了 role/aria-selected（读屏读不出当前页）；
 *   · 有人顺手用 transition-all 凑动效；
 *   · 设置搜索的 anchor 被改成表达式 / 被移进条件渲染（搜索跳不过去）。
 *
 * 跑法：node .AGENT/scripts/settings/verify-model-page-rework.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

const css = read('src/styles/index.css')
const search = read('src/modules/settings/components/SettingsSearchBox.tsx')
const catalog = read('src/modules/settings/views/ModelCatalogSection.tsx')
const modelsRaw = read('src/modules/settings/views/AiModelsTab.tsx')
const tabs = read('src/modules/settings/views/AiToolsView.tsx')
const picker = read('src/modules/settings/views/AiModelPicker.tsx')

/** 扫结构时不看注释：注释里出现 max-w-md / data-setting-anchor={...} 只是「说明这件事」 */
const stripComments = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/^[ \t]*\*.*$/gm, '')
const models = stripComments(modelsRaw)

// ===== 1. 深色框线令牌 =====
console.log('\n[框线] --field-border 三主题都有，且只作用于显式挂类的控件')
{
  const rootBlock = /:root \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  const lightBlock = /html\.theme-light \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  const dayBlock = /html\.theme-daycycle \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  check('深色 :root 定义了 --field-border（与 --border-color 分开）',
    /--field-border:\s*color-mix\(/.test(rootBlock) && /--field-border:\s*var\(--border-color\)/.test(rootBlock) === false)
  check('浅色主题的 --field-border 直接沿用 --border-color',
    /--field-border:\s*var\(--border-color\)/.test(lightBlock))
  check('昼夜主题有独立混色（其 --border-color 带 alpha，不能直接照搬）',
    /--field-border:\s*color-mix\(/.test(dayBlock))

  const strongAt = css.indexOf('\n.kb-field.kb-field-strong {')
  const focusAt = css.indexOf('\n.kb-field:focus-within {')
  check('.kb-field-strong 存在', strongAt >= 0)
  check('负向：.kb-field-strong 排在 :focus-within 之前（否则聚焦色被盖掉）',
    strongAt >= 0 && focusAt >= 0 && strongAt < focusAt,
    `strong@${strongAt} focus@${focusAt}`)
  check('.kb-field-input 有显式 :focus（未分层样式会压过 Tailwind focus:border-*）',
    /\.kb-field-input:focus\s*\{\s*border-color:\s*var\(--accent\)/.test(css))
  check('行内「内容型」输入有无分层类 .kb-inline-input（Tailwind 工具类压不过全局 input）',
    /\.kb-inline-input \{[\s\S]*?border-color:\s*transparent/.test(css)
    && /\.kb-inline-input:focus \{[\s\S]*?border-color:\s*var\(--accent\)/.test(css))
  check('负向：没有把全局 input / .kb-field 的边框整体替换成 --field-border',
    !/input,\s*textarea,\s*select\s*\{[^}]*--field-border/.test(css)
    && !/\n\.kb-field \{\s*[^}]*--field-border/.test(css))
}

// ===== 2. 组合输入框：唯一一道框 =====
console.log('\n[B 形态] 搜索框 / 上下文窗口不得出现框中框')
{
  check('全局搜索外壳用 .kb-field + .kb-field-strong', /kb-field kb-field-strong/.test(search))
  check('全局搜索内部控件用 .kb-field-control', /className="[^"]*kb-field-control/.test(search))
  check('清除按钮 22px 点击区 + aria-label',
    /w-\[22px\] h-\[22px\]/.test(search) && /aria-label="清除搜索"/.test(search))
  check('全局搜索 Esc 有文字先清空', /e\.key === 'Escape'[\s\S]{0,220}if \(query\) \{ onQueryChange\(''\)/.test(search))

  check('本地搜索外壳用 .kb-field + .kb-field-strong', /kb-field kb-field-strong/.test(catalog))
  check('上下文窗口用 .kb-field-sm + .kb-field-control', /kb-field kb-field-strong kb-field-sm/.test(catalog) && /kb-field-control min-w-0 flex-1 text-right/.test(catalog))
  check('上下文窗口有 K 后缀', />K<\/span>/.test(catalog))
  check('本地搜索 Esc 清空', /e\.key !== 'Escape'\) return[\s\S]{0,240}if \(query\) setQuery\(''\)/.test(catalog))
  check('本地搜索清除按钮 22px + aria-label',
    /w-\[22px\] h-\[22px\]/.test(catalog) && /aria-label="清除条目搜索"/.test(catalog))

  // 负向：组合框内部控件不许再带自己的边框工具类（那是框中框的来源）
  const innerSearches = [...search.matchAll(/className="([^"]*kb-field-control[^"]*)"/g)].map(m => m[1])
  check('负向：全局搜索内部控件没有 border-[ / ring / outline 工具类',
    innerSearches.length > 0 && innerSearches.every(c => !/border-\[|ring-|outline-/.test(c.replace(/outline-none/g, ''))),
    innerSearches.join(' | '))

  // ★ 类契约：index.css 的 .kb-field 只画边框/背景，不写 display —— 外壳必须自己给 flex。
  //   漏了它，内部 input 的 flex-1 变死属性、后缀（K）会掉到框外（2026-11-20 真机截图的漂移）。
  const shells = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (extname(name) !== '.tsx') continue
      const text = readFileSync(full, 'utf8')
      const rel = full.slice(ROOT.length + 1).replace(/\\/g, '/')
      for (const m of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const cls = m[1] ?? m[2] ?? ''
        if (!cls.split(/\s+/).includes('kb-field')) continue
        shells.push({ rel, cls })
      }
    }
  }
  walk(join(ROOT, 'src/modules/settings'))
  const badShells = shells.filter(({ cls }) => {
    const tokens = cls.split(/\s+/)
    return !tokens.includes('flex') || !tokens.includes('items-center')
  })
  check(`扫到 ${shells.length} 个 .kb-field 外壳（为 0 说明扫描坏了）`, shells.length >= 2, String(shells.length))
  check('每个 .kb-field 外壳都显式 flex + items-center（.kb-field 不写 display）',
    badShells.length === 0, badShells.map(s => `${s.rel}: ${s.cls.slice(0, 80)}`).join(' | '))
}

// ===== 3. 页签可访问性 =====
console.log('\n[页签] role / aria-selected')
{
  check('页签容器有 role="tablist"', /role="tablist"/.test(tabs))
  check('每个页签是 role="tab" 且 aria-selected 绑定当前页签', /role="tab"/.test(tabs) && /aria-selected=\{active\}/.test(tabs))
  check('页签仍是 button（键盘可聚焦）', /<button[\s\S]{0,260}role="tab"/.test(tabs))
}

// ===== 4. 条目行三层与长 id =====
console.log('\n[条目行] 三层 / 长 id 换行 / 单选圈 / 五个能力标签')
{
  check('默认条目是 role="radio" + aria-checked', /role="radio"/.test(catalog) && /aria-checked=\{isDefault\}/.test(catalog))
  check('六个能力标签常显（CAP_DEFS 六项，含「思考」）', [...catalog.matchAll(/label: '(工具|视觉|JSON|生图|改图|思考)'/g)].length === 6)
  check('能力组 flex-wrap + chip shrink-0（320 宽换行不溢出）',
    /aria-label="能力" className="flex flex-wrap items-center gap-1 min-w-0"/.test(catalog) && /shrink-0 h-5 px-1\.5/.test(catalog))
  check('「思考」chip 提示支持后对话里可调思考强度',
    /key === 'reasoning'[\s\S]{0,80}支持后对话里可调思考强度/.test(catalog))
  check('能力三态循环走纯函数', /nextCapabilityState\(cur\)/.test(catalog))
  check('条目标题输入用 .kb-inline-input（默认无框）', /kb-inline-input/.test(catalog))
  check('长 model id 用 anywhere 换行（不 truncate）',
    /\[overflow-wrap:anywhere\]/.test(catalog) && !/<code[^>]*truncate/.test(catalog))
  check('测试结果胶囊带 aria-expanded', /aria-expanded=\{detailOpen\}/.test(catalog))
  check('测试仍调 llmCatalogTest（不写回条目）', /llmCatalogTest\(entry\.id\)/.test(catalog))
  check('上下文窗口落盘仍是 token（K 只做展示）', /parseContextWindowK\(win\)/.test(catalog) && /contextWindow: parsed\.tokens/.test(catalog))
}

// ===== 5. 供应商行 / 场景表（行为不动的部分） =====
console.log('\n[供应商 / 场景] 重排版但不动语义')
{
  check('供应商行头 flex-wrap（窄宽换行而非溢出）', /flex flex-wrap items-center gap-2 px-3 py-2\.5 cursor-pointer/.test(models))
  check('状态点三态（绿 / 黄 / 灰）', /var\(--success\)/.test(models) && /var\(--warning\)/.test(models) && /var\(--text-disabled\)/.test(models))
  check('A 形态输入走 --field-border（kb-field-input）', /kb-field-input/.test(models))
  check('选择器触发器走 --field-border（按钮用工具类，保留 hover 强调）', /border-\[var\(--field-border\)\]/.test(picker))
  check('供应商正文与场景表不再收窄到 max-w-md', !/max-w-md/.test(models))
  check('四个设置锚点仍是字面量',
    ['aiTools.scenes', 'aiTeach.visionModel', 'aiTools.imageModel', 'aiTools.imageEditModel']
      .every(a => models.includes(`data-setting-anchor="${a}"`)))
  check('负向：没有把 anchor 写成表达式', !/data-setting-anchor=\{/.test(models))
  check('场景行标签 132px（原型口径）', /w-\[132px\]/.test(models))
}

// ===== 6. 动效 =====
console.log('\n[动效] 不另造过渡')
{
  const files = [
    'src/modules/settings/components/SettingsSearchBox.tsx',
    'src/modules/settings/views/ModelCatalogSection.tsx',
    'src/modules/settings/views/AiModelsTab.tsx',
    'src/modules/settings/views/AiToolsView.tsx',
  ]
  const offenders = files.filter(rel => /transition-all/.test(read(rel)))
  check('负向：本轮改到的视图没有 transition-all', offenders.length === 0, offenders.join(', '))
  check('条目行进场用 .kb-item-in', /kb-item-in/.test(catalog))
  check('胶囊 chevron 用 .kb-chevron（Tailwind rotate 收不到 transition-transform）', /kb-chevron/.test(catalog))
  check('折叠一律走 Collapsible / .kb-collapse', /<Collapsible/.test(catalog) && /kb-collapse/.test(css))
}

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
