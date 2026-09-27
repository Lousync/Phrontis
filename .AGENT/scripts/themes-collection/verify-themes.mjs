#!/usr/bin/env node
/**
 * 主题合集插件契约验证(四季主题 v1.6.0)。
 *
 * 防的回归:渲染层 pluginService.sanitizeVars 对 colors 表做白名单消毒,
 * 不合规的「键/值」会被【静默丢弃】——表现是主题卡片不出现或渐变不生效,无任何报错。
 * 本脚本离线复刻消毒规则,确保 plugin.json 里每个键值都能活着到达 <style> 注入。
 *
 * 运行:node .AGENT/scripts/themes-collection/verify-themes.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const errors = []
const fail = (msg) => errors.push(msg)

// --- 与 src/lib/pluginService.ts sanitizeVars 逐条对齐(改 sanitizeVars 必须同步这里) ---
function sanitizeVars(colors) {
  if (!colors || typeof colors !== 'object') return []
  const out = []
  for (const [k, v] of Object.entries(colors)) {
    if (!/^--[a-zA-Z0-9-]{1,64}$/.test(k)) continue
    if (typeof v !== 'string' || !v.length || v.length > 200) continue
    if (/url\s*\(|expression|@|{|}|<|>/i.test(v)) continue
    out.push(`${k}: ${v}`)
  }
  return out
}

function loadManifest(rel) {
  try {
    return JSON.parse(readFileSync(join(root, rel), 'utf-8'))
  } catch (e) {
    fail(`${rel} 解析失败: ${e.message}`)
    return null
  }
}

const market = loadManifest('resources/market-plugins/themes-collection/plugin.json')
const builtin = loadManifest('resources/builtin-plugins/themes-collection/plugin.json')

if (market && builtin) {
  if (JSON.stringify(market) !== JSON.stringify(builtin)) {
    fail('market-plugins 与 builtin-plugins 两份 plugin.json 不一致(双通道必须同步)')
  }
}

if (market) {
  // 版本与描述
  if (market.version !== '1.6.0') fail(`version 应为 1.6.0,实际 ${market.version}`)
  if (!/四季/.test(market.description || '')) fail('description 未提及四季主题')

  // 贡献结构
  const themes = market.contributes?.theme
  if (!Array.isArray(themes)) {
    fail('contributes.theme 缺失或不是数组')
  } else {
    if (themes.length !== 12) fail(`主题应为 12 套(8 旧 + 4 四季),实际 ${themes.length}`)

    const names = themes.map(t => t.name)
    const SEASONAL = ['春 · 嫩芽', '夏 · 骄阳', '秋 · 金秋', '冬 · 初雪']
    for (const s of SEASONAL) {
      if (!names.includes(s)) fail(`缺少四季主题「${s}」`)
    }

    // 每套主题逐键过消毒器,不允许静默丢键
    themes.forEach((t, i) => {
      if (typeof t?.name !== 'string' || !t.name.trim()) { fail(`theme[${i}] name 非法`); return }
      const keys = Object.keys(t.colors ?? {})
      const kept = sanitizeVars(t.colors)
      if (kept.length !== keys.length) {
        const dropped = keys.filter(k => !kept.some(line => line.startsWith(`${k}:`)))
        fail(`「${t.name}」有 ${keys.length - kept.length} 个令牌会被 sanitizeVars 静默丢弃: ${dropped.join(', ')}`)
      }
      // 四季主题必备令牌(基础色板 + 渐变 + 玻璃描边 + 拖拽高亮)
      if (SEASONAL.includes(t.name)) {
        const REQUIRED = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover', '--bg-selected',
          '--activitybar-bg', '--sidebar-bg', '--input-bg', '--card-bg',
          '--text-primary', '--text-secondary', '--text-muted', '--text-disabled',
          '--accent', '--accent-hover', '--danger', '--success', '--warning',
          '--border-color', '--warning-bg', '--drop-bg', '--drop-border',
          '--glass-edge', '--bg-gradient']
        for (const k of REQUIRED) {
          if (!(k in (t.colors ?? {}))) fail(`「${t.name}」缺少必备令牌 ${k}`)
        }
        const grad = t.colors?.['--bg-gradient'] ?? ''
        if (!grad.startsWith('linear-gradient(')) fail(`「${t.name}」--bg-gradient 应为 linear-gradient`)
        if (!/rgba\([^)]*0\.92\s*\)/.test(grad)) fail(`「${t.name}」--bg-gradient 停止点应带 0.92 alpha(对齐磨砂玻璃)`)
        if (!t.colors['--bg-gradient'] || sanitizeVars({ '--bg-gradient': t.colors['--bg-gradient'] }).length === 0) {
          fail(`「${t.name}」--bg-gradient 无法通过消毒器(渐变将不生效)`)
        }
      }
    })
  }
}

if (errors.length) {
  console.error(`✗ 主题合集契约验证失败(${errors.length}):`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log('✓ 主题合集契约验证通过:双通道一致,12 套主题全部令牌可过消毒器,四季主题令牌齐备')
