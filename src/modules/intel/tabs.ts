/**
 * 情报文章页签的动态 id（v3.12.0，docs/intel-module-plan.md §6.2）。
 * 页签 id = `intel-a:<itemId>`；先例 = 工具页签（`tool:<toolId>`）——与 TabName 共用
 * openTabs 序列，但不占 TabName 联合类型。
 */
export const INTEL_ARTICLE_PREFIX = 'intel-a:'

export const intelArticleTabId = (itemId: string): string => `${INTEL_ARTICLE_PREFIX}${itemId}`

export const isIntelArticleTab = (tabId: string): boolean => tabId.startsWith(INTEL_ARTICLE_PREFIX)

export const intelArticleIdOf = (tabId: string): string => tabId.slice(INTEL_ARTICLE_PREFIX.length)
