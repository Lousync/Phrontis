/**
 * 功能总闸。
 *
 * 背单词（v3.17.0）的代码 / IPC / AI 工具 / 静态资源都保留，但本版不开放用户入口；
 * 完成适配后再开启（原计划 v3.18.0 已过期未开放，目标版本待定）。开启时把 VOCAB_ENTRY_ENABLED 置 true，并检查：
 *   - 左栏书签 / 桌面磁贴 / AI 权限行是否恢复；
 *   - builtin.vocab.words 是否恢复注册，`builtin.tool.request` 清单是否补回；
 *   - resources/vocab 是否已 `npm run build:vocab`；
 *   - CHANGELOG 是否补回背单词段并重跑 release-notes 生成器。
 */
export const VOCAB_ENTRY_ENABLED = false
