/**
 * 平台判据（渲染层）—— 唯一出处，别在组件里直接读 `window.api.platform`。
 *
 * 为什么单独一个模块：
 *   · `window.api.platform` 是 2026-10-19（v3.9.2）才加的字段；老 preload 上它是 undefined，
 *     各组件自己判 `=== 'linux'` 时一处漏掉就是「Linux 上更新入口还在，点了报错」；
 *   · 平台差异**只能有这一处真相源**（AGENTS.md 铁律 9 的取向：平台差异不靠分支承载、靠能力判据）。
 *
 * 目前唯一的消费者是「应用内更新」：Linux 不提供（已拍板决策 #6，主进程侧 update:check/download/install
 * 也直接返回不提供、不发网络请求，见 electron/lib/updateService.ts）。
 */

/** 宿主平台；拿不到（浏览器预览 / 旧 preload）时按空串，判据一律用 isXxx 系列函数 */
export const APP_PLATFORM: string =
  typeof window !== 'undefined' && window.api && typeof window.api.platform === 'string'
    ? window.api.platform
    : ''

export const IS_LINUX = APP_PLATFORM === 'linux'

/**
 * 是否提供**应用内**更新（检查 / 下载 / 运行安装包）。
 * Linux = false：安装包走独立 tag（`v<ver>-linux`），更新交给包管理器 / 发布页手动下载。
 */
export const IN_APP_UPDATE_SUPPORTED = !IS_LINUX

/** 不提供应用内更新时，给用户的替代路径（AboutView 与标题栏共用同一句，避免措辞漂移） */
export const MANUAL_UPDATE_HINT = '请到 Releases 发布页手动下载新版本'
