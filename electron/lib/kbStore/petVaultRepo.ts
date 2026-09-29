import { readJson, writeJsonOrThrow } from './jsonStore'
import { getUsageTodayMinutes } from '../appUsageStore'
import { checkinCurrentStreak } from './habitStats'
import { vaultRecordsAll } from './habitVaultRepo'
import { getKnowledgeIndex } from './knowledgeIndex'
import { getAiUsageData } from '../agentUsage'
import { dateKeyOf } from '../appUsage'

/**
 * 桌宠 vault 数据仓库（2026-09-28，docs/pet-design.md）。
 *
 * 存储：.knowbase/modules/pet/pet.json —— 宠物状态唯一真相源。
 * 设计要点：
 *  - **主进程为状态真相源**：pet:get 时按真实流逝时间结算衰减（饥饿/心情），
 *    渲染层只做表现与动画，不做数值写回；
 *  - **轻联动**：使用数据 → 活跃度（0-1）→ 心情衰减变慢 + 成长获取加速；
 *    四项数据全部复用现有仓储/采集器（appUsageStore / habitStats /
 *    knowledgeIndex / agentUsage），零新写采集；
 *  - 成长值满 120 升级成年（proto v10 拍板：无蛋，出生即幼年）。
 */

const MOD = 'modules/pet'
const PET_KEY = 'pet.json'

export type PetSpecies = 'dog' | 'cat'

/** 合法品种集（readRaw 容错 / switch / reset 共用，单一真相源） */
const PET_SPECIES: readonly PetSpecies[] = ['dog', 'cat']

function isPetSpecies(v: unknown): v is PetSpecies {
  return typeof v === 'string' && (PET_SPECIES as readonly string[]).includes(v)
}

export interface PetState {
  version: number
  /** 当前品种的名字（= names[species]，冗余存一份便于渲染层直读；写入路径统一同步） */
  name: string
  /** 每品种各记一个名字（2026-09-28 用户拍板：名字跟着宠物走，狗猫各记各的） */
  names: Record<PetSpecies, string>
  species: PetSpecies
  /** 0=幼年 1=成年 */
  stage: number
  exp: number
  hunger: number
  mood: number
  /** 上次结算时间戳 */
  ts: number
}

export interface PetSnapshot extends PetState {
  /** 活跃度 0-1（轻联动加成系数） */
  activity: number
  /** 今日使用分钟（活跃度输入之一，供控件展示） */
  usageTodayMinutes: number
  streak: number
  notesToday: number
  aiCallsToday: number
  /** 本次操作是否跨过升级阈值（渲染层据此播「我长大啦」动画，仅喂食/摸头返回） */
  stageUp?: boolean
}

const STAGE_UP_NEED = 120
const HUNGER_DECAY_PER_HOUR = 2.8
const MOOD_DECAY_PER_HOUR = 1.5
const MOOD_DECAY_EXTRA_LOW_HUNGER = 1.8
const FEED_REFUSE_THRESHOLD = 92

function defaultNameFor(species: PetSpecies): string {
  return species === 'cat' ? '小猫' : '小狗'
}

/** 名字清洗：非字符串/空白/超 8 字一律处理（旧档或手改容错） */
function sanitizeName(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 8) : fallback
}

function defaults(): PetState {
  return {
    version: 1, name: '小狗', names: { dog: '小狗', cat: '小猫' },
    species: 'dog', stage: 0, exp: 0, hunger: 80, mood: 80, ts: Date.now(),
  }
}

function readRaw(): PetState {
  const s = readJson<PetState>(MOD, PET_KEY, defaults())
  // 容错：字段缺失/类型漂移时兜底（旧文件或手改）
  const species: PetSpecies = isPetSpecies(s.species) ? s.species : 'dog'
  // 名字：优先 names 表；旧档只有单个 name → 归到当前品种，其他品种给默认名（一次性迁移，无需单独脚本）
  const rawNames = (s as Partial<PetState>).names
  const names: Record<PetSpecies, string> = {
    dog: sanitizeName(rawNames?.dog ?? (species === 'dog' ? s.name : undefined), defaultNameFor('dog')),
    cat: sanitizeName(rawNames?.cat ?? (species === 'cat' ? s.name : undefined), defaultNameFor('cat')),
  }
  return {
    version: 1,
    name: names[species],
    names,
    species,
    stage: s.stage === 1 ? 1 : 0,
    exp: typeof s.exp === 'number' && s.exp > 0 ? Math.floor(s.exp) : 0,
    hunger: clamp(typeof s.hunger === 'number' ? s.hunger : 80, 0, 100),
    mood: clamp(typeof s.mood === 'number' ? s.mood : 80, 5, 100),
    ts: typeof s.ts === 'number' && s.ts > 0 ? s.ts : Date.now(),
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function todayKey(): string {
  return dateKeyOf(Date.now())
}

/** 活跃度 0-1（权重：使用时长 50% / 打卡连续 25% / 笔记产出 15% / AI 互动 10%） */
function computeActivity(today: string): { activity: number; usageTodayMinutes: number; streak: number; notesToday: number; aiCallsToday: number } {
  let usageTodayMinutes = 0
  try { usageTodayMinutes = getUsageTodayMinutes() } catch { /* 采集器异常按 0 计 */ }
  let streak = 0
  try { streak = checkinCurrentStreak(vaultRecordsAll(), today) } catch { /* 无打卡数据按 0 计 */ }
  let notesToday = 0
  try {
    notesToday = getKnowledgeIndex().pages.filter(
      (p) => (p.entryKind ?? 'doc') === 'doc' && !!p.updatedAt && p.updatedAt.startsWith(today),
    ).length
  } catch { /* 索引异常按 0 计 */ }
  let aiCallsToday = 0
  try { aiCallsToday = getAiUsageData().days[today]?.calls ?? 0 } catch { /* 无 AI 记录按 0 计 */ }

  const activity = Math.min(1,
    Math.min(1, usageTodayMinutes / 240) * 0.5 +
    Math.min(1, streak / 7) * 0.25 +
    Math.min(1, notesToday / 5) * 0.15 +
    Math.min(1, aiCallsToday / 10) * 0.1)
  return { activity, usageTodayMinutes, streak, notesToday, aiCallsToday }
}

/** 按真实流逝时间结算衰减并写回（pet:get 时调用；上限 72h 防长期未开钟摆） */
function settleDecay(s: PetState): { activity: number; usageTodayMinutes: number; streak: number; notesToday: number; aiCallsToday: number } {
  const now = Date.now()
  const gapH = Math.min(72, Math.max(0, (now - s.ts) / 36e5))
  const today = todayKey()
  const act = computeActivity(today)
  s.hunger = clamp(s.hunger - HUNGER_DECAY_PER_HOUR * gapH, 0, 100)
  const extra = s.hunger < 20 ? MOOD_DECAY_EXTRA_LOW_HUNGER : 0
  // 轻联动：活跃度越高心情衰减越慢（最高 -60%）
  s.mood = clamp(s.mood - (MOOD_DECAY_PER_HOUR + extra) * (1 - 0.6 * act.activity) * gapH, 5, 100)
  // 成长值满自动进化（自愈：旧档可能存在 exp 已满但 stage 未推进的卡死态，下次结算即补）
  if (s.stage === 0 && s.exp >= STAGE_UP_NEED) s.stage = 1
  s.ts = now
  return act
}

/** 成长获取（轻联动加成：最高 +50%） */
function expGain(base: number, activity: number): number {
  return Math.max(1, Math.round(base * (1 + 0.5 * activity)))
}

export function vaultPetGet(): PetSnapshot {
  const s = readRaw()
  const act = settleDecay(s)
  writeJsonOrThrow(MOD, PET_KEY, s)
  return { ...s, ...act }
}

export function vaultPetFeed(): PetSnapshot {
  const s = readRaw()
  settleDecay(s)
  let stageUp = false
  if (s.hunger < FEED_REFUSE_THRESHOLD) {
    const wasBelow = s.exp < STAGE_UP_NEED
    s.hunger = clamp(s.hunger + 30, 0, 100)
    s.mood = clamp(s.mood + 10, 5, 100)
    s.exp += expGain(10, computeActivity(todayKey()).activity)
    // 跨过升级阈值立即推进 stage（否则 stageUp 只播动画、形态永远不换）
    if (s.stage === 0 && s.exp >= STAGE_UP_NEED) s.stage = 1
    stageUp = wasBelow && s.stage === 1
  }
  // 饱食时拒绝：不加分，仅结算时间戳（渲染层按 hunger>=92 表现拒绝）
  s.ts = Date.now()
  writeJsonOrThrow(MOD, PET_KEY, s)
  return { ...s, ...computeActivity(todayKey()), stageUp }
}

export function vaultPetPetTouch(): PetSnapshot {
  const s = readRaw()
  settleDecay(s)
  const wasBelow = s.exp < STAGE_UP_NEED
  s.mood = clamp(s.mood + 8, 5, 100)
  s.exp += expGain(2, computeActivity(todayKey()).activity)
  if (s.stage === 0 && s.exp >= STAGE_UP_NEED) s.stage = 1
  const stageUp = wasBelow && s.stage === 1
  s.ts = Date.now()
  writeJsonOrThrow(MOD, PET_KEY, s)
  return { ...s, ...computeActivity(todayKey()), stageUp }
}

export function vaultPetRename(name: string): PetSnapshot {
  const s = readRaw()
  settleDecay(s)
  const clean = sanitizeName(name, s.names[s.species])
  s.names[s.species] = clean
  s.name = clean
  s.ts = Date.now()
  writeJsonOrThrow(MOD, PET_KEY, s)
  return { ...s, ...computeActivity(todayKey()) }
}

/**
 * 切换品种（狗⇄猫）——**保留进度**：只换 species 与显示名，stage/exp/hunger/mood 一位不动。
 * 名字跟着宠物走：取该品种自己记的名字（names 表），互不覆盖。
 */
export function vaultPetSwitchSpecies(species: PetSpecies): PetSnapshot {
  const s = readRaw()
  settleDecay(s)
  const sp: PetSpecies = isPetSpecies(species) ? species : 'dog'
  s.species = sp
  s.name = s.names[sp]
  s.ts = Date.now()
  writeJsonOrThrow(MOD, PET_KEY, s)
  return { ...s, ...computeActivity(todayKey()) }
}

/** 重新养一只：重置数值与**当前品种**的名字；另一只的名字保留（名字跟着宠物走） */
export function vaultPetReset(species: PetSpecies): PetSnapshot {
  const sp: PetSpecies = isPetSpecies(species) ? species : 'dog'
  const prev = readRaw()
  const s = defaults()
  s.species = sp
  s.names = { ...prev.names, [sp]: defaultNameFor(sp) }
  s.name = s.names[sp]
  s.ts = Date.now()
  writeJsonOrThrow(MOD, PET_KEY, s)
  return { ...s, ...computeActivity(todayKey()) }
}
