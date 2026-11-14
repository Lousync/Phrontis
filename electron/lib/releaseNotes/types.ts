/**
 * 更新说明（release notes）的数据契约 —— 主进程侧。
 *
 * 渲染层有一份**镜像声明**在同名结构里（见 src/types/index.ts）：
 * 两个 tsconfig 互不可见（tsconfig.node 不含 src、tsconfig.web 不含 electron），
 * 沿用本仓「跨线类型在各侧各声明一次」的既有做法。
 */

/** 分组类别：只影响渲染时的徽标与配色，不参与数据语义 */
export type ReleaseNoteKind = 'feature' | 'ux' | 'fix' | 'internal' | 'other'

export interface ReleaseNoteItem {
  /** `- **标题**：正文` 里的粗体标题（已去尾冒号）；没有粗体前缀时为空串 */
  readonly lead: string
  /** 条目正文。已剥掉 Markdown 粗体标记，反引号保留给渲染层做行内 code */
  readonly rest: string
  /** 缩进子项（已拍平为纯文本） */
  readonly sub: readonly string[]
}

export interface ReleaseNoteGroup {
  readonly title: string
  readonly kind: ReleaseNoteKind
  readonly items: readonly ReleaseNoteItem[]
}

export interface ReleaseNote {
  /** 不带前导 v，如 `3.0.0` / `1.6.0-programmer.1` */
  readonly version: string
  /** CHANGELOG 原文里的日期，缺省为空串（老版本多数没写日期） */
  readonly date: string
  /** 版本块顶部的引用块摘要（部分版本没有） */
  readonly summary: string
  readonly groups: readonly ReleaseNoteGroup[]
}

/**
 * 手写亮点 = 页面上部那几张精写卡片（与 CHANGELOG 自动生成的清单是两层）。
 * 条目清单保证「不漏」，亮点负责「讲清楚哪几件事值得看」。
 *
 * 2026-09-12 按原型（tmp/release-notes-proto/release-notes.html）扩展为
 * 「分节卡片 + 动效演示区」形态：section 聚类渲染、brief 进顶部摘要行、
 * changes 折叠进卡片、demo 渲染可重播的演示组件。
 */
export interface ReleaseHighlightLink {
  readonly label: string
  /** 外链（文档网等）；无 href 的链接仅作说明文字渲染 */
  readonly href?: string
}

/** 右侧动效演示区（可重播；只动 transform/opacity，跟随减弱动态设置） */
export type ReleaseHighlightDemo =
  | { readonly kind: 'notify'; readonly title: string; readonly message: string; readonly caption?: string }
  | {
      readonly kind: 'compare'
      readonly caption?: string
      readonly rows: readonly { readonly label: string; readonly display: string; readonly width: number; readonly after?: boolean }[]
    }
  | {
      readonly kind: 'dist'
      readonly caption?: string
      readonly rows: readonly { readonly label: string; readonly display: string; readonly width: number }[]
    }
  | {
      readonly kind: 'mini-list'
      readonly caption?: string
      readonly items: readonly { readonly text: string; readonly done?: boolean }[]
    }

export interface ReleaseNoteHighlight {
  /** 所属版本（不带前导 v） */
  readonly version: string
  /** 分节名（日程 / AI 助手 / 错题本 / 界面…）——同节卡片渲染在同一分节头下 */
  readonly section: string
  readonly title: string
  readonly desc: string
  /** 可选的补充一行（放实测数字、边界说明之类） */
  readonly detail?: string
  /** 顶部摘要行（粗体引导词 + 短句）；缺省不进摘要行 */
  readonly briefLead?: string
  readonly briefRest?: string
  /** 标题旁的小标签（如「新增」） */
  readonly tag?: string
  /** 卡片底部链接行 */
  readonly links?: readonly ReleaseHighlightLink[]
  /** 卡片内可折叠的「全部改动（N 条）」 */
  readonly changes?: readonly string[]
  /** 右侧动效演示区 */
  readonly demo?: ReleaseHighlightDemo
}

/** `.knowbase/modules/release-notes/index.json` 的形状 */
export interface ReleaseNotesIndex {
  /** 上次向用户展示过的版本（不带前导 v）；空串 = 从未展示 */
  lastShown: string
  /** 首次见到某版本的记录（用于区分「全新安装」与「升级」） */
  seen: string[]
  updatedAt: string
}

/** 启动时一次性回给渲染层的判定结果 */
export interface ReleaseNotesState {
  /** 当前应用版本（`app.getVersion()`） */
  currentVersion: string
  /** 是否有对应版本的更新说明数据 */
  hasNotes: boolean
  /** 是否有未读的本版说明（= 该在看板出提醒入口）；与「新版本时在看板提醒」开关无关 */
  unread: boolean
}

/** jsonStore 的 module 参数。沿用本仓「模块数据一律在 .knowbase/modules/<模块>/」的口径 */
export const RELEASE_NOTES_MODULE = 'modules/release-notes'
export const RELEASE_NOTES_INDEX_KEY = 'index.json'
