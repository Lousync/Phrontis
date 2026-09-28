/**
 * 应用使用时长 —— **日期分桶的纯函数层**（零依赖）。
 *
 * 抽出来的理由与 `kbStore/habitStats.ts` 同源：「一段时长该记到哪一天、跨零点怎么拆、
 * 多久该丢掉」这类判定一旦写在采集器里，契约脚本就只能照抄一份算法来验，等于自证。
 * 判定策略必须与真实实现同源 —— 所以这里零 import，契约脚本用
 * `node --experimental-strip-types` 直接装载本文件验真实实现。
 *
 * 口径：
 *  - 日期键一律**本地时区** 'YYYY-MM-DD'（用户看到的是自己那天，不是 UTC 那天）
 *  - 数值单位是**秒**（浮点秒会累积误差，整秒足够）；对外展示时再换算成分钟
 *  - 跨零点的一段要拆进两个桶 —— 用本地午夜做切点，`new Date(y, m, d+1)` 天然
 *    避开夏令时（本地午夜不总是 86400s 之后）
 *  - 时钟回拨 / 非法区间一律**丢弃而不是抛错**：这是后台采集，不能因为系统时间
 *    被用户改一下就炸掉主进程
 */

/** 'YYYY-MM-DD' → 当日累计秒 */
export type UsageDays = Record<string, number>

/** 单段最长可入账时长。心跳重开段的间隔远小于它，所以正常路径永远碰不到；
 *  它只兜底「系统休眠却没有 suspend 事件」这类会导致一段横跨数小时的极端情形。 */
export const MAX_SEGMENT_MS = 5 * 60 * 1000

/** 毫秒时间戳 → 本地日键 'YYYY-MM-DD' */
export function dateKeyOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 'YYYY-MM-DD' → UTC 天序号（纯算术，供补零区间用）；非法输入返回 NaN */
export function dayNo(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return NaN
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000)
}

/** UTC 天序号 → 本地日键（补零区间用；偏移按该天中午取，避开夏令时切换当天的歧义） */
function keyOfDayNo(no: number): string {
  return dateKeyOf(no * 86400000 + 12 * 3600 * 1000)
}

/**
 * 把一段实际时长夹到合理上限。
 * 返回 `[start, end]`；区间非法（end <= start）时返回 `[start, start]`（零长）。
 */
export function clampSegment(startMs: number, endMs: number, maxMs = MAX_SEGMENT_MS): [number, number] {
  const s = Math.max(0, Math.floor(startMs))
  const e = Math.floor(endMs)
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return [s, s]
  return [e - s > maxMs ? e - maxMs : s, e]
}

/**
 * 把 `[startMs, endMs)` 按本地日拆进桶里累加。**就地修改并返回同一个对象**。
 *
 * 幂等性说明：这不是幂等函数 —— 同一段调两次会记两遍。幂等由调用方保证
 * （采集器每段只结算一次，结算后立刻重开新段）。这里不做去重是刻意的：
 * 去重需要保存每一段的身份，而「同一秒内多次 focus」本来就是真实用量。
 */
export function mergeSegment(days: UsageDays, startMs: number, endMs: number): UsageDays {
  let s = Math.max(0, Math.floor(startMs))
  const e = Math.floor(endMs)
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return days
  while (s < e) {
    const d = new Date(s)
    // 下一个本地午夜；夏令时切换当天也正确（不是无脑 +86400000）
    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
    const chunkEnd = Math.min(e, nextMidnight)
    if (!(chunkEnd > s)) {
      // 时钟被回拨等病态情形：整段落到当前键上收尾，绝不空转
      const k = dateKeyOf(s)
      days[k] = (days[k] ?? 0) + Math.round((e - s) / 1000)
      break
    }
    const sec = Math.round((chunkEnd - s) / 1000)
    if (sec > 0) {
      const k = dateKeyOf(s)
      days[k] = (days[k] ?? 0) + sec
    }
    s = chunkEnd
  }
  return days
}

/** 丢掉早于「今天往前 keepDays 天」的桶。**就地修改并返回同一对象**。 */
export function pruneDays(days: UsageDays, keepDays: number, nowMs: number): UsageDays {
  const todayNo = dayNo(dateKeyOf(nowMs))
  if (!Number.isFinite(todayNo)) return days
  const minNo = todayNo - (Math.max(1, Math.floor(keepDays)) - 1)
  for (const key of Object.keys(days)) {
    const no = dayNo(key)
    if (!Number.isFinite(no) || no < minNo) delete days[key]
  }
  return days
}

/** 某天的分钟数（四舍五入；缺失键当 0） */
export function minutesOn(days: UsageDays, key: string): number {
  return Math.round((days[key] ?? 0) / 60)
}

/**
 * 取 `[fromKey, toKey]` 闭区间的每天分钟数，**缺失的日期补 0**。
 * 渲染层要画热力图，不能自己拿 `Object.keys` 拼格子 —— 没记录的那天必须也在。
 */
export function rangeMinutes(days: UsageDays, fromKey: string, toKey: string): Record<string, number> {
  const from = dayNo(fromKey)
  const to = dayNo(toKey)
  const out: Record<string, number> = {}
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return out
  for (let no = from; no <= to; no++) {
    const k = keyOfDayNo(no)
    out[k] = minutesOn(days, k)
  }
  return out
}
