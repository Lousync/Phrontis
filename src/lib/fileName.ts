/**
 * 文件展示名 / 扩展名徽标的统一口径（VaultTree 与总览·零散文件共用）。
 *
 * 口径：行内只显示主名，扩展名收进右侧大写徽标；**所有带扩展名的文件都显示徽标（含 .md）**，
 * 让混合类型列表的右缘形成一条对齐线（无扩展名与点开头文件如 `.ignore` 不显示）。
 */
export function splitName(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.')
  if (i <= 0) return { base: name, ext: '' }
  return { base: name.slice(0, i), ext: name.slice(i + 1) }
}

/** 是否显示右侧扩展名徽标：有扩展名即显示（含 md） */
export function shouldShowExtBadge(ext: string): boolean {
  return !!ext
}
