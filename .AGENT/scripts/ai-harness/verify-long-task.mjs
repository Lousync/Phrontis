// 契约脚本：长任务档（P1-5）
// 覆盖：续跑档位判定、长档预算数值、续跑现场持久化、system 提示、卡片说明、Vault 限额。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: L } = await loadTsModule(join(ROOT, 'electron/lib/agentLongTaskPure.ts'))
const { mod: I } = await loadTsModule(join(ROOT, 'electron/lib/agentInterruptPure.ts'))
const { mod: P } = await loadTsModule(join(ROOT, 'electron/lib/agentLoopPolicy.ts'))

// ── ① 续跑档位判定 ────────────────────────────────────────────────────────────
{
  ok('常规档中断 → 继续升长任务档', L.resolveResumeProfile('normal', 'assistant') === 'long')
  ok('没有 profile 字段（旧现场）→ 长任务档', L.resolveResumeProfile(undefined, 'assistant') === 'long')
  ok('已记长任务档 → 原样沿用', L.resolveResumeProfile('long', 'assistant') === 'long')
  ok('已记 long-1m → 不降档', L.resolveResumeProfile('long-1m', 'assistant') === 'long-1m')
  ok('已记 long-128k → 不降档', L.resolveResumeProfile('long-128k', 'assistant') === 'long-128k')
  ok('非法值按未记录处理', L.resolveResumeProfile('bogus', 'assistant') === 'long')
  ok('AI 教学交给长资料自动检测', L.resolveResumeProfile(undefined, 'aiTeaching') === undefined)
  ok('AI 教学已记档仍沿用', L.resolveResumeProfile('long-1m', 'aiTeaching') === 'long-1m')
  ok('日程 / 情报同样升长档', L.resolveResumeProfile(undefined, 'schedule') === 'long' && L.resolveResumeProfile(undefined, 'intel') === 'long')
  ok('长任务档 id 固定为 long', L.LONG_TASK_PROFILE === 'long')
}
{
  ok('长任务提示写明轮数 / 写入 / 历史', /60 轮推理/.test(L.LONG_TASK_HINT) && /150 次写入/.test(L.LONG_TASK_HINT) && /64k 历史/.test(L.LONG_TASK_HINT))
  ok('长任务提示要求先列清单', /builtin\.plan\.todo/.test(L.LONG_TASK_HINT))
  ok('长任务提示不放松「不得虚报完成」', /真正调用工具并拿到成功结果/.test(L.LONG_TASK_HINT))
}

// ── ② 中断卡：长任务档说明 ────────────────────────────────────────────────────
{
  const withLong = I.buildInterruptContent({ reason: '轮数用尽', rounds: 16, toolCalls: 20, canResume: true, longTaskResume: true })
  const without = I.buildInterruptContent({ reason: '轮数用尽', rounds: 16, toolCalls: 20, canResume: true })
  ok('可续 + 将升长档 → 卡片说明长任务档', /长任务档（最多 60 轮推理 \/ 150 次写入，你的自定义设置优先）/.test(withLong))
  ok('常规说明不凭空出现长档', !/长任务档/.test(without))
  const noResume = I.buildInterruptContent({ reason: 'x', rounds: 1, toolCalls: 1, canResume: false, longTaskResume: true })
  ok('不可续时不说长档（指向不存在的入口）', !/长任务档/.test(noResume) && !/继续/.test(noResume))
  ok('SessionResume 支持 profile 字段', /profile\?: string/.test(readFileSync(join(ROOT, 'electron/lib/agentInterruptPure.ts'), 'utf8')))
}

// ── ③ 预算数值 ────────────────────────────────────────────────────────────────
{
  ok('60 轮不撞轮数硬上限', P.clampMaxRounds(60) === 60)
  ok('150 次写入在合法区间', P.clampMaxSessionWrites(150) === 150)
}

const svc = readFileSync(join(ROOT, 'electron/lib/agentService.ts'), 'utf8')
ok('档位类型含 long', /export type ToolResultProfileId = 'normal' \| 'long' \| 'long-128k' \| 'long-1m'/.test(svc))
ok('长任务档循环预算 = 60 轮 / 150 写 / 64k / 3M',
  /long: \{ maxRounds: 60, runTokenBudget: 3_000_000, maxSessionWrites: 150, contextBudgetTokens: 64_000, parallelChunk: 4 \}/.test(svc))
ok('长任务档工具结果 profile 已定义', /long: \{ resultChars: 64_000, maxStringChars: 10_000, maxItems: 80/.test(svc))
ok('长任务档不参与长资料自动升档（防降轮数）', /if \(profileId === 'long-1m' \|\| profileId === 'long'\) return/.test(svc))
ok('续跑读取现场档位', /resolveResumeProfile\(rs\.profile, resumeSource\)/.test(svc))
ok('续跑把档位传给 runAgentLoop', /\{ resumeInjection: injection, profile \}/.test(svc))
ok('中断现场落档位', /profile: profileId,/.test(svc) && /profile && profile !== 'normal' \? \{ profile \}/.test(svc))
ok('三处 persistResume 都带档位', (svc.match(/persistResume\(/g) ?? []).length === 4 && /ctx\?\.profile\)/.test(svc) && (svc.match(/ictx\.profile\)/g) ?? []).length === 2)
ok('system 注入长任务提示', /const longTaskHint = profileId === 'long' \? LONG_TASK_HINT : ''/.test(svc) && /profileHint \+ longTaskHint/.test(svc))
ok('卡片提前说明继续会升档', /longTaskResume: source !== 'aiTeaching' && !isSideLane && !manual && profileId !== 'long'/.test(svc) && (svc.match(/longTaskResume: .*longTaskResume === true/g) ?? []).length === 2)

// ── ④ Vault 限额与既有契约面 ──────────────────────────────────────────────────
const bt = readFileSync(join(ROOT, 'electron/lib/builtinTools.ts'), 'utf8')
ok('VaultProfileId 含 long', /export type VaultProfileId = 'normal' \| 'long' \| 'long-128k' \| 'long-1m'/.test(bt))
ok('VAULT_TOOL_LIMITS 有 long 条目', /long: \{ readDefault: 32_000, readMax: 80_000/.test(bt))
ok('setVaultToolProfile 直接接受 long', /setVaultToolProfile\(profileId\)/.test(svc))

report('长任务档（P1-5）')
