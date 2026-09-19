/**
 * B4 · 内联建议的「自动触发闸门」——纯函数区（**零 import**，供契约脚本裸 node import）。
 *
 * 为什么独立成文件：契约脚本要 import 它做用例断言；若与 React 组件同文件，
 * 组件的 `import ... from 'react'` 会让裸 node 解析失败（同 inlineSuggestCore 的口径）。
 *
 * 这一层负责三件事（自动模式的成本闸全在这里）：
 *   ① 触发点判定 —— 只在写作的「自然断点」发请求，词中间绝不打扰；
 *   ② 冷却 —— 连续若干次建议没人采纳，说明这时段不需要它，自动暂停；
 *   ③ 常量 —— debounce 与阈值单点定义（渲染层只消费，不另抄一份字面量）。
 */

// ===== 常量（单点定义，别在组件里再抄一遍） =====

/** 停顿多久算「写完了想下一步」（原型实测 800ms 手感最稳，2026-09-19 定案） */
export const AUTO_DEBOUNCE_MS = 800
/** 连续多少次「发了建议但没被采纳」就暂停自动（避免对着不需要的段落狂发请求） */
export const AUTO_PAUSE_STREAK = 3

// ===== 触发点 =====

/** 句读符：中文写作里「逗号后」才是最需要续写的地方，必须算触发点 */
const CLAUSE_END = /[。！？!?；;：:，,]/
/** 能构成「一个词/一段话」的字符（用于判断空格前是不是完整词） */
const WORDY = /[\u4e00-\u9fa5A-Za-z0-9]/

export interface TriggerVerdict {
  /** 是否值得为这个停顿发一次请求 */
  hit: boolean
  /** 人话解释（界面/探针直接显示，便于一眼看出为什么没触发） */
  why: string
}

/**
 * 判断光标处是否处于「值得续写」的自然断点。
 *
 * 设计取舍（2026-09-19，原型自检逼出来的两条）：
 * - **句读后算触发**：`换元之后，` 后面的续写正是最需要的；最初只认句末标点，
 *   中文写作里会大量漏触发。
 * - **绝不能用「文档末尾就触发」这类兜底**：人几乎总在文末打字，加了它
 *   「词中间不打扰」就形同虚设，成本闸失效（原型自检实测：输入「积分」本该被拦下却命中）。
 */
export function isTriggerPoint(text: string, offset: number): TriggerVerdict {
  const s = String(text ?? '')
  const at = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, s.length))
  const before = s.slice(0, at)
  if (!before.trim()) return { hit: false, why: '文档还是空的，不打扰。' }

  const last = before.slice(-1)
  if (CLAUSE_END.test(last)) return { hit: true, why: `句读后（${last}）—— 中文写作最自然的续写点。` }
  if (last === '\n') return { hit: true, why: '换行后（段首）—— 正要开始写下一句。' }

  if (last === ' ' || last === '\t') {
    const w = before.replace(/[ \t]+$/, '').split(/[\s\n]/).pop() ?? ''
    if (w.length >= 2) return { hit: true, why: `刚写完一个词（${w}）—— 词边界，续写有意义。` }
    return { hit: false, why: '空格后但前面不是完整词，再等等。' }
  }

  // 注意：这里**没有**「文档末尾」兜底 —— 见上方注释，那是成本闸失效的元凶
  return { hit: false, why: '正在一个词/半句话中间 —— 不打扰你（这就是省 token 的地方）。' }
}

// ===== 冷却（连续未采纳 → 暂停自动） =====

export interface AutoState {
  /** 连续「发了但没被采纳」的次数 */
  streak: number
  /** 自动是否已暂停（暂停后只有手动 Alt+A / 胶囊按钮能唤醒） */
  paused: boolean
}

export const INITIAL_AUTO_STATE: AutoState = { streak: 0, paused: false }

/** 该不该在这次停顿后自动发请求（暂停中一律不发，手动入口不看这个） */
export function canAutoRequest(st: AutoState): boolean {
  return !st.paused
}

/** 记账：一次自动请求的结果（adopted=true 表示用户 Tab 采纳了） */
export function afterAutoResult(st: AutoState, adopted: boolean): AutoState {
  if (adopted) return { streak: 0, paused: false }
  const streak = st.streak + 1
  return { streak, paused: streak >= AUTO_PAUSE_STREAK }
}

/** 手动触发 = 显式「我现在要」→ 唤醒自动并重新计数 */
export function reviveByManual(): AutoState {
  return { streak: 0, paused: false }
}
