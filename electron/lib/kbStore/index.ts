/**
 * kbStore：去库化数据访问引擎（P0 地基）。
 * 三层存储 + 当前仓库上下文：
 * - vaultContext：当前仓库 + .knowbase 定位（启动引导/自动恢复的数据源）
 * - jsonStore：结构化模块 JSON 原子写
 * - mdStore：内容型模块 Markdown + frontmatter
 * - secretStore：敏感数据加密存储（secretBox / Electron safeStorage）
 * - knowledgeIndex：Vault 全量扫描的内存/落盘索引（P0 知识库读源的前置）
 */
export {
  getCurrentVault,
  setCurrentVault,
  getVaultKbRoot,
  ensureKbRoot,
  readCurrentVaultId,
  KB_SCHEMA_VERSION,
  type VaultInfo,
} from './vaultContext'
export {
  kbModulePath,
  readJson,
  writeJson,
  deleteFile,
  listFiles,
  exists,
} from './jsonStore'
export {
  parseMarkdown,
  parseFrontmatter,
  serializeMarkdown,
  readMarkdownFile,
  writeMarkdownFile,
  type MdDoc,
} from './mdStore'
export {
  readSecret,
  writeSecret,
} from './secretStore'
export {
  rebuildKnowledgeIndex,
  getKnowledgeIndex,
  invalidateKnowledgeIndex,
  findKnowledgePage,
  type KnowledgeIndex,
  type KnowledgePageIndexEntry,
  type KnowledgeCategoryIndexEntry,
} from './knowledgeIndex'
