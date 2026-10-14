#!/usr/bin/env node
/**
 * 契约验证：模块权限的档位语义（src/lib/aiPermPresets.ts）。
 *
 * 为什么值得钉：权限预设是**一次点击改 8 个模块**的动作，语义错了两头都危险 ——
 *   · 「完全信任」若给"没有写操作的模块"也发 write，界面会显示"读写"而实际什么都没有
 *     （番茄专注就是这种模块），用户以为开了、其实没有；
 *   · 「最保守」若只改模块、忘了仓库文件，等于没保守住；
 *   · parsePerms 若把不认识的键丢掉，改任一模块权限时会**顺手抹掉 terminal 权限**
 *     （那个键不在本页渲染，但在 JSON 里、并且真的在管终端工具的读写档）。
 *
 * 跑法（任意目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/ai-perms/verify-ai-perms.mjs
 * 期望末尾 PASS 且 exit=0。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULES, PERM_LABEL, parsePerms, presetModulePerms, hasWriteOp, DAILY_WRITE_MODULES } from '../../../src/lib/aiPermPresets.ts'
import { SETTINGS } from '../../../src/lib/settings.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let failures = 0
const pass = (m) => console.log(`  [OK]   ${m}`)
const fail = (m) => { failures++; console.error(`  [FAIL] ${m}`) }
const check = (cond, msg) => { if (cond) pass(msg); else fail(msg) }

const LEGAL = new Set(['off', 'read', 'write'])
const ids = MODULES.map(m => m.id)

console.log('\n§1 模块清单')
check(MODULES.length === 8, `有 8 个模块（实际 ${MODULES.length}）`)
check(new Set(ids).size === ids.length, '模块 id 无重复')
check(MODULES.every(m => m.label && m.desc), '每个模块都有 label 与 desc')
check(ids.includes('pomodoro') && !hasWriteOp('pomodoro'), '番茄专注没有写操作（"读写"对它应置灰）')
check(MODULES.filter(m => m.id !== 'pomodoro').every(m => hasWriteOp(m.id)), '除番茄专注外都有写操作')

console.log('\n§2 「最保守」档：全部只读')
{
  const p = presetModulePerms('safe')
  check(ids.every(id => p[id] === 'read'), '每个模块都是 read')
  check(Object.values(p).every(v => LEGAL.has(v)), '只产出三个合法值')
  check(JSON.stringify(presetModulePerms('safe')) === JSON.stringify(p), '同一档位重复计算结果稳定（幂等）')
}

console.log('\n§3 「日常」档：日程与记账可写')
{
  const p = presetModulePerms('daily')
  check(DAILY_WRITE_MODULES.every(id => p[id] === 'write'), '日程与记账是 write')
  check(ids.filter(id => !DAILY_WRITE_MODULES.includes(id)).every(id => p[id] === 'read'), '其余都是 read')
  check(p.pomodoro === 'read', '番茄专注仍是 read（它本来就没有写操作）')
}

console.log('\n§4 「完全信任」档：有写操作的都可读写')
{
  const p = presetModulePerms('all')
  check(MODULES.filter(m => hasWriteOp(m.id)).every(m => p[m.id] === 'write'), '有写操作的模块都是 write')
  // ★ 负向：给一个不存在的写能力发权限 = 界面说"读写"、实际什么都没有
  check(p.pomodoro === 'read', '负向：没有写操作的番茄专注**不得**变成 write（否则是发一个不存在的许可）')
  check(Object.values(p).every(v => LEGAL.has(v)), '只产出三个合法值（不混进档位名）')
  check(!Object.keys(p).some(k => !ids.includes(k)), '只产出已知模块的键')
}

console.log('\n§5 解析存量设置')
{
  check(parsePerms('').knowledge === undefined, '空串 → 空表（不炸）')
  check(parsePerms('not json').knowledge === undefined, '坏 JSON → 空表（不炸）')

  const withBad = parsePerms('{"knowledge":"read","blog":"admin","x":"write"}')
  check(withBad.knowledge === 'read', '合法值保留')
  check(withBad.blog === undefined, '非法值被丢弃（"admin" 不是档位）')
  check(withBad.x === 'write', '未知模块的合法值仍保留（不认识的键不代表该丢）')

  // ★ 真实隐患：terminal 不在本页渲染，但它在同一份 JSON 里管着终端工具的档位。
  //   若解析时把它丢掉，改任一模块权限都会顺手把它抹掉 —— 终端权限静默消失。
  const def = String(SETTINGS.aiModulePermissions?.default ?? '')
  check(def.includes('"terminal"'), '设置默认值里确实有 terminal 键（它管终端工具的读写档）')
  const before = parsePerms(def)
  check(before.terminal === 'write', '解析后 terminal 仍是 write')
  const merged = { ...before, knowledge: 'off' }
  check(merged.terminal === 'write', '负向：改一个模块权限后 terminal 不该被抹掉')
}

console.log('\n§6 视图接线（源码文本）')
{
  const view = readFileSync(join(ROOT, 'src', 'modules', 'settings', 'views', 'AiPermissionsTab.tsx'), 'utf8')
  check(view.includes('最保守 · 全部只读'), '渲染了「最保守」预设按钮')
  check(view.includes('日常 · 读 + 日程/记账可写'), '渲染了「日常」预设按钮')
  check(view.includes('完全信任 · 全部可读写'), '渲染了「完全信任」预设按钮')
  check(!/<select/.test(view), '负向：下拉已被三态分段控件替换（视图里不该再出现 <select>）')
  check(view.includes('function PermCtl'), '分段控件 PermCtl 存在')
  check(view.includes('writeDead'), '「读写」对无写操作的模块置灰（writeDead）')
  // 2026-10-13 语气升级改过这句的措辞（「不会先问你」→「不会逐次请求确认」）。
  // 断言改成锁**这张警告卡本身**（有告警图标 + 说到"直接生效"），不再跟着句子走。
  check(view.includes('AlertTriangle') && view.includes('直接生效'), '有写入权限时的风险提示在位')
  check(view.includes('setConfirmAll') && view.includes('再点一次'), '「完全信任」是行内两步确认（不弹模态）')
  check(view.includes("presetModulePerms(mode)"), '预设走纯模块算出的结果，而不是视图里另写一套')
  check(view.includes("update('aiVaultFilePerm', 'read')"), '「最保守」连仓库文件一起收回只读')
  check(PERM_LABEL.off === '禁止' && PERM_LABEL.read === '只读' && PERM_LABEL.write === '读写', '三档文案是禁止 / 只读 / 读写')
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} —— 权限契约 ${failures} 处失败`)
process.exit(failures === 0 ? 0 : 1)
