#!/usr/bin/env node
/**
 * 契约验证：AI 输入区吉祥物「地基」（.claude/plans/ai-composer-mascot.md）。
 *
 * 断言：扩展点清单校验 + 扫描/IPC 三处接线 + 渲染层（活动状态 / 挂载壳 / 播放器 / 占位角色）
 * + 三处输入区挂载 + 设置项。全线为静态接线断言（本模块的漏接是静默的：槽名/通道名错一个字符，
 * 界面就「什么都没出现」，没有任何报错）。
 *
 * 跑法：node .AGENT/scripts/plugins/verify-mascot.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

console.log('\n[扩展点] pluginRegistry.ts')
const reg = read('electron/lib/pluginRegistry.ts')
check("KNOWN_CONTRIBUTIONS 含 'mascot'", reg.includes("'pets', 'mascot'"))
check('MASCOT_STATES 七态齐', ['idle', 'thinking', 'working', 'sweeping', 'notification', 'error', 'attention'].every(s => reg.includes(`'${s}'`)))
check("清单校验分支 key === 'mascot'", reg.includes("if (key === 'mascot')"))
check('校验：仅 UI 插件', reg.includes("mascot 贡献仅 UI 插件(type: ui)可声明"))
check('校验：mascot 为数组(1-8)', reg.includes('mascot 需为 1-8 只吉祥物的数组'))
check('校验：数组内 id 去重', reg.includes('mascot: 重复的 id'))
check('校验：states 指向未知动画被拒', reg.includes('mascot: states.') && reg.includes('指向未知动画'))
check('校验：sheets 路径 png + 禁越界', reg.includes('mascot: sheets.') && reg.includes('路径非法'))
check('scanPluginMascots 存在', reg.includes('function scanPluginMascots'))
check('scanPluginMascots 收集全部（非取首个）', reg.includes('const out: PluginMascotInfo[] = []') && reg.includes('out.push({'))
check('scanPluginMascots 拼 plugin:// URL', reg.includes('`plugin://${id}/${encodeURI(b)}`'))
check('plugin:listMascots handler', reg.includes("ipcMain.handle('plugin:listMascots'"))

console.log('\n[接线] preload / ipc.ts / types')
check('preload 通道 plugin:listMascots', read('electron/preload/index.ts').includes("ipcRenderer.invoke('plugin:listMascots'"))
check('ipc.ts 封装 pluginListMascots', read('src/lib/ipc.ts').includes('export const pluginListMascots'))
const types = read('src/types/index.ts')
check('types 定义 PluginMascotInfo', types.includes('export interface PluginMascotInfo'))
check('ElectronAPI 含 pluginListMascots', types.includes('pluginListMascots: () => Promise<PluginMascotInfo[]>'))

console.log('\n[渲染层] aiActivity / 挂载壳 / 播放器 / 占位角色')
const act = read('src/lib/aiActivity.ts')
check('AiActivity 七态导出', act.includes('export type AiActivity') && ['idle', 'thinking', 'working', 'sweeping', 'notification', 'error', 'attention'].every(s => act.includes(`'${s}'`)))
check('useAiActivity 订阅钩子', act.includes('export function useAiActivity'))
check('数据源：runstate + step', act.includes('onAssistantRunState') && act.includes('onAgentStep'))
check('时刻：出错 / 完成', act.includes("moment('error'") && act.includes("moment('attention'"))
const anchor = read('src/components/shared/AiMascot/AiMascotAnchor.tsx')
check('挂载壳读设置 aiMascot（字符串选择）', anchor.includes('s.aiMascot'))
check('挂载壳订阅插件变更刷新', anchor.includes('onPluginInstalledChanged'))
check('挂载壳优先插件角色、回落占位', anchor.includes('pluginListMascots()') && anchor.includes('<MascotPlayer') && anchor.includes('<PlaceholderMascot'))
check('挂载壳用 kb-mascot-anchor', anchor.includes('kb-mascot-anchor'))
const player = read('src/components/shared/AiMascot/MascotPlayer.tsx')
check('播放器 states 映射 + 逐帧网格播放', player.includes('mascot.states[activity]') && player.includes('setInterval') && player.includes('COLS = 8'))
check('播放器点击反应（tapLeft/Right/Flail + 指针）', player.includes('tapFlail') && player.includes('onPointerDown') && player.includes('tapAnim') || player.includes('playOnce'))
check('播放器 空闲小节目 + 入睡/惊醒 + 工作分档', player.includes('idleExtras') && player.includes("sheets.sleeping") && player.includes('workingTiers'))
check('anchor 传入忙数（工作分档）', anchor.includes('useAiBusy') && anchor.includes('busy={busy}'))
check('播放器 ink 遮罩 + reduced-motion 停帧', player.includes('maskImage') && player.includes('prefers-reduced-motion') || player.includes('prefersReduce'))
check('内置占位角色存在', read('src/components/shared/AiMascot/PlaceholderMascot.tsx').includes('export const PlaceholderMascot'))
check('index.css 有 .kb-mascot-anchor + bob', read('src/styles/index.css').includes('.kb-mascot-anchor') && read('src/styles/index.css').includes('kb-mascot-bob'))

console.log('\n[挂载] 三处输入区')
const cb = read('src/components/shared/AssistantPanel/ChatBody.tsx')
check('ChatBody 输入卡挂载（侧边/浮动/放大/日程）', cb.includes('<AiMascotAnchor />') && cb.includes("from '../AiMascot/AiMascotAnchor'"))
check('AI 教学对话主区挂载', read('src/modules/ai-teaching/index.tsx').includes('<AiMascotAnchor />'))
check('支线旁问挂载', read('src/modules/ai-teaching/SideLanePanel.tsx').includes('<AiMascotAnchor />'))

console.log('\n[设置] aiMascot 字符串选择 + 设置面板控件')
const st = read('src/lib/settings.ts')
check("settings aiMascot 默认 'auto'", /aiMascot:\s*\{\s*default:\s*'auto'/.test(st))
check('设置项保留 anchor ai.mascot', /aiMascot:[\s\S]{0,500}?anchor:\s*'ai\.mascot'/.test(st))
const at = read('src/modules/settings/views/AiToolsView.tsx')
check('设置面板有吉祥物选择控件', at.includes('data-setting-anchor="ai.mascot"') && at.includes('pluginListMascots'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
