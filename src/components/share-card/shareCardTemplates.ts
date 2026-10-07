import type { ShareCardState, ShareCardStyle, ShareCardTemplate, ShareCardTexts } from '../../types'

/**
 * 分享卡片模板（2026-09-29）—— **零值导入**（只有会被擦除的 `import type`），
 * 契约脚本用 `node --experimental-strip-types` 直接装载本文件验真实实现。
 *
 * 一套模板 = 风格 + 卡片明暗 + 三处文案的整体快照。钝解析哲学同 `workbenchLayout`：
 * 坏 JSON 走默认、类型不对的丢弃、非法值回落 —— 面板状态坏了绝不能炸启动。
 */

/**
 * 风格枚举的**就地副本**。为什么不 import `shareCardStyles.SHARE_CARD_STYLES`：
 * 那个文件是值导出，一旦 import 进来本文件就再也不能被 strip-types 直接装载
 * （Node ESM 不解析无扩展名的相对导入）。两份清单由契约脚本做**一致性断言**，
 * 改一处漏另一处会被拦下。
 */
export const SHARE_CARD_STYLE_IDS = ['peak', 'page', 'heat'] as const

/** 内置示例模板（不可删 / 不可改名） */
export const BUILTIN_TEMPLATES: readonly ShareCardTemplate[] = [
  {
    id: 't-default', name: '默认', style: 'peak', theme: 'light', builtin: true,
    texts: { quote: '把读过的、记下的、做错的，都收进同一个文件夹。', slogan: '本地优先的学习生活操作系统', signature: '' },
  },
  {
    id: 't-read', name: '读书打卡', style: 'page', theme: 'light', builtin: true,
    texts: { quote: '读书是最低成本的旅行。', slogan: '本地优先的学习生活操作系统', signature: '' },
  },
  {
    id: 't-exam', name: '考研倒计时', style: 'heat', theme: 'light', builtin: true,
    texts: { quote: '距离上岸还有 87 天，今天也没有偷懒。', slogan: '每天进步一点点', signature: '@小徐' },
  },
]

/** 出厂文案（「还原默认」的落点；也是缺省模板的文案） */
export const DEFAULT_TEXTS: ShareCardTexts = {
  quote: '把读过的、记下的、做错的，都收进同一个文件夹。',
  slogan: '本地优先的学习生活操作系统',
  signature: '',
}

export const DEFAULT_STATE: ShareCardState = {
  templates: BUILTIN_TEMPLATES.map((t) => ({ ...t, texts: { ...t.texts } })),
  current: { style: 'peak', theme: 'light', texts: { ...DEFAULT_TEXTS }, tplId: 't-default' },
  prompt: '',
}

/** 文案字段的兜底上限（比输入层限长宽松，只为拦住病态膨胀的 settings） */
const TEXT_CAP = 200
/** 题目区上限（与 shareCardRichText.PROMPT_MAX_CHARS 同值；此处就地写死避免值导入） */
const PROMPT_CAP = 400

function isStyle(v: unknown): v is ShareCardStyle {
  return typeof v === 'string' && (SHARE_CARD_STYLE_IDS as readonly string[]).includes(v)
}

function str(v: unknown, cap = TEXT_CAP): string {
  return typeof v === 'string' ? v.slice(0, cap) : ''
}

export function sanitizeTexts(raw: unknown, fb: ShareCardTexts = DEFAULT_TEXTS): ShareCardTexts {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    quote: typeof o.quote === 'string' ? str(o.quote) : fb.quote,
    slogan: typeof o.slogan === 'string' ? str(o.slogan) : fb.slogan,
    signature: typeof o.signature === 'string' ? str(o.signature) : fb.signature,
  }
}

function sanitizeTemplate(raw: unknown): ShareCardTemplate | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 16) : ''
  if (!id || !name) return null
  return {
    id,
    name,
    style: isStyle(o.style) ? o.style : 'peak',
    theme: o.theme === 'dark' ? 'dark' : 'light',
    texts: sanitizeTexts(o.texts),
    builtin: o.builtin === true,
  }
}

/** 内置三套模板的**深拷贝种子**（不能直接吐 DEFAULT_STATE 的引用，调用方会改它） */
function seedTemplates(): ShareCardTemplate[] {
  return DEFAULT_STATE.templates.map((t) => ({ ...t, texts: { ...t.texts } }))
}

/**
 * 设置键 `shareCard` 的钝解析。**关键区分**：
 *
 * - `templates` 字段**不存在**（空串 / `'null'` / 坏 JSON / 老数据）→ 还没存过或存坏了 → 落**内置种子**；
 * - `templates` 是数组（**哪怕是空的**）→ 原样采用 —— 空数组的语义是「用户确实把模板全删光了」，
 *   这里若再回落内置就会变成「删了又自己回来」，那是比空界面更糟的体验。
 *
 * 其余照钝规则：模板项缺 id/name 丢弃、非法风格回落 peak、缺字段补默认。
 */
export function sanitizeShareCardState(raw: unknown): ShareCardState {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch { parsed = null }
  }
  const o = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>

  const parsedList = Array.isArray(o.templates)
    ? o.templates.map(sanitizeTemplate).filter((t): t is ShareCardTemplate => !!t)
    : null
  const templates = parsedList ?? seedTemplates()

  const cRaw = (o.current && typeof o.current === 'object' ? o.current : {}) as Record<string, unknown>
  const tplId = typeof cRaw.tplId === 'string' && templates.some((t) => t.id === cRaw.tplId)
    ? cRaw.tplId
    : (templates[0]?.id ?? null)

  return {
    templates,
    current: {
      style: isStyle(cRaw.style) ? cRaw.style : 'peak',
      theme: cRaw.theme === 'dark' ? 'dark' : 'light',
      texts: sanitizeTexts(cRaw.texts),
      tplId,
    },
    // 题目区**不属于模板**：模板切换不会动它（见 types 的 ShareCardState.prompt）
    prompt: typeof o.prompt === 'string' ? o.prompt.slice(0, PROMPT_CAP) : '',
  }
}

/** 当前卡片配置与该模板是否已不一致（界面上标「已修改」） */
export function isTemplateDirty(state: ShareCardState): boolean {
  const t = state.templates.find((x) => x.id === state.current.tplId)
  if (!t) return true
  if (t.style !== state.current.style || t.theme !== state.current.theme) return true
  const { quote, slogan, signature } = state.current.texts
  return quote !== t.texts.quote || slogan !== t.texts.slogan || signature !== t.texts.signature
}

/** 新模板 id（时间戳 + 随机尾，本机内唯一足够） */
export function newTemplateId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}
