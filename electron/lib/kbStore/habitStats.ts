/**
 * 窗口内「每习惯打卡明细」统计 —— **纯函数、零依赖**（v3.2.0 条目 13）。
 *
 * 抽成独立文件的理由：这类「该统计谁、按什么分母算」的判定策略一旦写在 IPC handler 里，
 * 契约脚本就只能照抄一份算法来验，等于自证 —— 判定策略必须与真实实现同源。
 *
 * 口径与渲染层 habit-tracker/dateUtils.ts 对齐（同一 app 里两处数字不该打架）：
 *  - 计划日：daily = 每天；weekdays = ruleDays 含该日；**flexible = 每天**（`isPlannedOn` 原口径）
 *  - 最长连续：窗口内逐日扫，已打卡 +1；**非计划日跳过、既不计也不断**；计划日漏打卡归零
 *  - 完成率：
 *    - daily / weekdays = 已打卡天数 ÷ 窗口内计划日天数
 *    - flexible = 已打卡次数 ÷（每周目标 × 窗口整周数，不足一周按一周算）
 *      —— flexible 没有「计划日」，用计划日当分母会恒等于 100%，故单列一条分母
 *
 * 日期一律本地时区 'YYYY-MM-DD'；内部换算成 **UTC 天序号**做加减，避开夏令时。
 *
 * 零 import（连 `import type` 都不用）：契约脚本用 `node --experimental-strip-types`
 * 直接装载本文件验真实实现，任何跨层引用都可能把装载链路拖垮。
 */

export interface HabitStatSeed {
  id: string
  name: string
  color: string
  /** daily / weekdays / flexible */
  rule_type: string
  /** weekdays 规则的计划日：JSON 字符串（vault 里原样存 "[1,2,3,4,5]"），本函数自行容错解析 */
  rule_days: string
  weekly_target: number
  /** vault 沿用表的 0/1 整数语义 */
  archived: number
}

export interface HabitPeriodStat {
  id: string
  name: string
  color: string
  ruleType: string
  weeklyTarget: number
  /** 窗口内打卡次数 */
  count: number
  /** 窗口内计划日天数（flexible 恒为 0 —— 它不以计划日作分母） */
  planned: number
  /** 完成率百分比；null = 无可用分母（未设计划日 / 空窗口），界面显示占位而非 0% */
  rate: number | null
  /** 窗口内最长连续打卡天数 */
  longest: number
}

/** 'YYYY-MM-DD' → UTC 天序号（纯算术，无时区与夏令时问题）；非法输入返回 NaN */
function dayNo(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return NaN
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000)
}

/** UTC 天序号 → 星期（0=周日），与 JS getDay() 同义 */
function utcDow(no: number): number {
  return new Date(no * 86400000).getUTCDay()
}

/** rule_days 列（JSON 字符串）→ 计划日数组；畸形 / 越界一律丢弃，不抛错 */
export function parseRuleDays(raw: string): number[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6)
  } catch {
    return []
  }
}

/** 该日是否「本该打卡」（flexible 视为每天可打，与 dateUtils.isPlannedOn 同口径） */
function isPlannedOn(ruleType: string, rules: number[], dow: number): boolean {
  if (ruleType === 'weekdays') return rules.includes(dow)
  return true
}

/**
 * 窗口内每习惯明细。
 *
 * **收录范围**：当前未归档的习惯 **+ 已归档但窗口内确实打过卡的**（历史窗口要如实反映，
 * 不能因为后来归档了就把当期的坚持抹掉）；窗口内零记录的归档习惯不出现。
 *
 * 返回顺序 = 传入 habits 的顺序（vault 文件序即 sort_order 序），不在此处重排。
 */
export function habitPeriodStats(
  habits: HabitStatSeed[],
  records: Array<{ habit_id: string; date: string }>,
  start: string,
  end: string,
): HabitPeriodStat[] {
  const startNo = dayNo(start)
  const endNo = dayNo(end)
  if (!Number.isFinite(startNo) || !Number.isFinite(endNo) || endNo < startNo) return []

  // habit_id → 窗口内已打卡天序号集合（记录可能跨窗口，先裁剪再分组）
  const doneByHabit = new Map<string, Set<number>>()
  for (const r of records) {
    if (!r || typeof r.date !== 'string') continue
    const no = dayNo(r.date)
    if (!Number.isFinite(no) || no < startNo || no > endNo) continue
    let set = doneByHabit.get(r.habit_id)
    if (!set) { set = new Set(); doneByHabit.set(r.habit_id, set) }
    set.add(no)
  }

  const days = endNo - startNo + 1
  const out: HabitPeriodStat[] = []

  for (const h of habits) {
    if (!h || !h.id) continue
    const done = doneByHabit.get(h.id) ?? new Set<number>()
    const rules = parseRuleDays(h.rule_days)
    const isFlexible = h.rule_type === 'flexible'

    let count = 0
    let planned = 0
    let longest = 0
    let cur = 0
    for (let no = startNo; no <= endNo; no++) {
      // 计划日有两副用法：完成率分母（flexible 不计）与连续判定（flexible 计，漏了就断）
      const plannedToday = isPlannedOn(h.rule_type, rules, utcDow(no))
      if (plannedToday && !isFlexible) planned++
      if (done.has(no)) {
        count++
        cur++
        if (cur > longest) longest = cur
      } else if (plannedToday) {
        cur = 0
      }
    }

    if (Number(h.archived) === 1 && count === 0) continue

    let rate: number | null = null
    if (isFlexible) {
      // 每周目标 × 窗口整周数（不足一周按一周算，避免窗口只有 3 天时分母缩成 0 次）
      const weeks = Math.max(1, Math.floor(days / 7))
      const target = Math.max(1, Math.round(Number(h.weekly_target) || 0)) * weeks
      rate = Math.round((count / target) * 100)
    } else if (planned > 0) {
      rate = Math.round((count / planned) * 100)
    }

    out.push({
      id: h.id,
      name: h.name,
      color: h.color,
      ruleType: h.rule_type,
      weeklyTarget: Number(h.weekly_target) || 0,
      count,
      planned,
      rate,
      longest,
    })
  }

  return out
}

/**
 * 窗口内打卡**总**次数（沿用 summaryRepo 原口径：窗口内 habit_records 条数）。
 * 单独导出是为了让「总数」与「明细求和」在契约里能互相印证 —— 两数一旦不等，
 * 说明明细的收录范围漏了或多了。
 */
export function checkinTotalInWindow(
  records: Array<{ habit_id: string; date: string }>,
  start: string,
  end: string,
): number {
  const startNo = dayNo(start)
  const endNo = dayNo(end)
  if (!Number.isFinite(startNo) || !Number.isFinite(endNo) || endNo < startNo) return 0
  let n = 0
  for (const r of records) {
    if (!r || typeof r.date !== 'string') continue
    const no = dayNo(r.date)
    if (Number.isFinite(no) && no >= startNo && no <= endNo) n++
  }
  return n
}
