import type { ElectronAPI, Entry, EntryFilter, CreateEntryDTO, UpdateEntryDTO, Tag, CreateScheduleTodoDTO, UpdateScheduleTodoDTO, CreateKnowledgeCategoryDTO, UpdateKnowledgeCategoryDTO, CreateKnowledgePageDTO, UpdateKnowledgePageDTO, KnowledgeTag, ExportFileResult, UserProfile, UserStats, UserExportData, UserImportData, MomentsPost, CreateMomentsPostDTO, UpdateMomentsPostDTO, MomentsAlbum, AttachmentMeta, CreateHabitDTO, UpdateHabitDTO, SuperviseConfig, AiToolsListResult, AiToolInvokeResult, AiToolUsage, AuditEntryInfo, McpServerInfo, McpServerDraft, McpToolPreview, McpTestResult, SkillInfo, SkillInstallResult, LlmProviderInfo, LlmProviderDraft, LlmProviderType, LlmTestResultInfo, LlmModelTestResultInfo, LlmUsageInfo, LlmUsageBreakdownEntry, AgentChatMessage, AgentChatResult, AgentCompressResult, AgentContextInfo, AgentSessionInfo, AgentSessionSource, AgentSideLaneCreateResult, AgentStoredMessage, AgentTraceStep, AgentStreamEvent, CcSwitchScanResult, CcSwitchImportResult, QuizSnapshotDto, QuizRecordDto, QuizCollectionDto, QuizStatsDto, QuizTagDto, PluginViewContribution, PluginCommandInfo, PluginSettingItem, PluginRendererInfo, QuizDataStats, DictLookupResult, DictStatus, TranslateInvokeRequest, TranslateInvokeResult, PdfOpResult, PdfExportResult, AiTeachSourceInput, CreatePasswordEntryDTO, UpdatePasswordEntryDTO } from '../types'
import type { SettingsKey, SettingsValue, AppSettings } from './settings'
import { SETTINGS_DEFAULTS } from './settings'
const a = () => { if (!window.api) throw new Error('Electron API not available.'); return window.api }

export const getPathForFile = (file: File): string => a().getPathForFile(file)
/** 请主进程对本窗口补发一次真实 paste（文件树右键「粘贴」用；渲染层需先交焦点给文件树） */
export const pasteFromClipboard = (): Promise<{ ok: boolean }> => a().pasteFromClipboard()
export const copyImage = (src: { path?: string; dataUrl?: string }): Promise<boolean> => a().copyImage(src)
export const copyText = (text: string): Promise<boolean> => a().copyText(text)

// ===== Typed settings =====

/** Get a typed setting value, with its default as fallback */
export async function getSetting<K extends SettingsKey>(key: K): Promise<SettingsValue<K>> {
  const raw = await a().getSetting(String(key))
  return (raw ?? SETTINGS_DEFAULTS[key]) as SettingsValue<K>
}

/** Set a typed setting value — key and value type are linked */
export async function setSetting<K extends SettingsKey>(key: K, value: SettingsValue<K>): Promise<void> {
  await a().setSetting(String(key), value)
}

/** Get all settings at once, with defaults filled for any missing keys */
export async function getAllSettings(): Promise<AppSettings> {
  const s = await a().getAllSettings()
  return { ...SETTINGS_DEFAULTS, ...s } as AppSettings
}

// Raw variants for dynamic-key use cases (e.g. sidebar width keys)
export const getSettingRaw = (k: string) => a().getSetting(k)
export const setSettingRaw = (k: string, v: unknown) => a().setSetting(k, v)

// ===== Window control =====
export const minimize = () => a().minimize()
export const maximize = () => a().maximize()
export const close = () => a().close()
export const isMaximized = () => a().isMaximized()
/** 抽屉式日程面板：上报面板期望宽度（0 = 收回），主进程以打开时刻基准宽为锚点调整窗口 */
export const resizeForSidebar = (width: number, animate?: boolean) => a().resizeForSidebar(width, animate)
export const onMaximizeChange = (cb: (v: boolean) => void) => a().onMaximizeChange(cb)
/** UI 优化条目1.7：最大化边缘拖拽恢复（热区 mousedown 启动 / mouseup 收尾） */
export const edgeResizeStart = (edge: string) => a().edgeResizeStart(edge)
export const edgeResizeEnd = () => a().edgeResizeEnd()
export const openDirDialog = () => a().openDirDialog()

// ===== Data =====
export const clearAllData = (): Promise<{ success: boolean; error?: string }> => a().clearAllData()
export const reloadWindow = () => a().reloadWindow()

// ===== Blog =====
export const getEntries = (f: EntryFilter = {}) => a().getEntries(f)
export const getEntryById = (id: string) => a().getEntryById(id)
export const createEntry = (d: CreateEntryDTO) => a().createEntry(d)
export const updateEntry = (id: string, d: UpdateEntryDTO) => a().updateEntry(id, d)
export const deleteEntry = (id: string) => a().deleteEntry(id)
export const toggleEntryStar = (id: string) => a().toggleEntryStar(id)
export const searchEntries = (q: string) => a().searchEntries(q)
export const getTags = () => a().getTags()
export const createTag = (n: string, c?: string) => a().createTag(n, c)
export const deleteTag = (id: string) => a().deleteTag(id)

// schedule
export const getScheduleTodos = (date: string) => a().getScheduleTodos(date)
export const getScheduleDates = (yearMonth: string) => a().getScheduleDates(yearMonth)
export const getScheduleMonthTodos = (yearMonth: string) => a().getScheduleMonthTodos(yearMonth)
export const getScheduleOverdue = (today: string) => a().getScheduleOverdue(today)
export const getScheduleDeadlineCounts = (yearMonth: string) => a().getScheduleDeadlineCounts(yearMonth)
export const getScheduleSubtasks = (parentId: string) => a().getScheduleSubtasks(parentId)
/** 日程表「待安排」栏：全部未排期（无排期时段）的顶层未完成任务，不限月份 */
export const getScheduleUnscheduledTodos = () => a().getScheduleUnscheduledTodos()
/** 日程表：某一周（含首尾）的任务，附带区间之前「已排期未完成」的延后候选 */
export const getScheduleWeekTodos = (weekStart: string, weekEnd: string) => a().getScheduleWeekTodos(weekStart, weekEnd)
export const createScheduleTodo = (d: CreateScheduleTodoDTO) => a().createScheduleTodo(d)
export const updateScheduleTodo = (id: string, d: UpdateScheduleTodoDTO) => a().updateScheduleTodo(id, d)
export const deleteScheduleTodo = (id: string) => a().deleteScheduleTodo(id)
export const getScheduleTags = () => a().getScheduleTags()
export const createScheduleTag = (n: string, c?: string) => a().createScheduleTag(n, c)
export const deleteScheduleTag = (id: string) => a().deleteScheduleTag(id)

// knowledge (Scheme A)
/**
 * 知识库落盘写操作成功 → 广播 vault:tree-refresh：空间/笔记本/页 = 仓库内真实目录与 md 文件，
 * 编辑器文件树的 dirCache 是懒加载缓存（根节点无折叠入口），不重拉会一直看不到新建目录（2026-09-09 修复）。
 */
function notifyKnowledgeTreeChanged(): void {
  window.dispatchEvent(new Event('vault:tree-refresh'))
}
export const getKnowledgeCategories = () => a().getKnowledgeCategories()
export const createKnowledgeCategory = async (d: CreateKnowledgeCategoryDTO) => { const r = await a().createKnowledgeCategory(d); notifyKnowledgeTreeChanged(); return r }
export const updateKnowledgeCategory = async (id: string, d: UpdateKnowledgeCategoryDTO) => { const r = await a().updateKnowledgeCategory(id, d); notifyKnowledgeTreeChanged(); return r }
export const deleteKnowledgeCategory = async (id: string) => { const r = await a().deleteKnowledgeCategory(id); notifyKnowledgeTreeChanged(); return r }
export const getKnowledgePages = (categoryId?: string | null) => a().getKnowledgePages(categoryId)
/** 知识索引 warnings（.ignore 坏行/规则未命中磁盘条目）：知识库模块激活时检查透出 */
export const getKnowledgeIndexWarnings = () => a().getKnowledgeIndexWarnings()
export const getKnowledgePageById = (id: string) => a().getKnowledgePageById(id)
export const createKnowledgePage = async (d: CreateKnowledgePageDTO) => { const r = await a().createKnowledgePage(d); notifyKnowledgeTreeChanged(); return r }
export const updateKnowledgePage = async (id: string, d: UpdateKnowledgePageDTO) => { const r = await a().updateKnowledgePage(id, d); notifyKnowledgeTreeChanged(); return r }
export const deleteKnowledgePage = async (id: string) => { const r = await a().deleteKnowledgePage(id); notifyKnowledgeTreeChanged(); return r }
export const searchKnowledgePages = (q: string) => a().searchKnowledgePages(q)
export const getKnowledgeBacklinks = (pageId: string) => a().getKnowledgeBacklinks(pageId)
export const getKnowledgeBacklinkContext = (pageId: string) => a().getKnowledgeBacklinkContext(pageId)
export const getKnowledgeSimilarPages = (pageId: string) => a().getKnowledgeSimilarPages(pageId)
export const getKnowledgeManualLinks = (pageId: string) => a().getKnowledgeManualLinks(pageId)
export const addKnowledgeManualLink = (pageId: string, targetId: string) => a().addKnowledgeManualLink(pageId, targetId)
export const removeKnowledgeManualLink = (pageIdA: string, pageIdB: string) => a().removeKnowledgeManualLink(pageIdA, pageIdB)
export const updateKnowledgeLinks = (pageId: string, linkedTitles: string[]) => a().updateKnowledgeLinks(pageId, linkedTitles)
export const getKnowledgeTags = () => a().getKnowledgeTags()
export const getKnowledgeGraph = () => a().getKnowledgeGraph()
export const getGraphViewConfig = () => a().getGraphViewConfig()
export const updateGraphViewConfig = (patch: Partial<import('./graphTypes').GraphViewConfig>) => a().updateGraphViewConfig(patch)
export const createKnowledgeTag = (n: string, c?: string) => a().createKnowledgeTag(n, c)
export const deleteKnowledgeTag = (id: string) => a().deleteKnowledgeTag(id)
export const toggleKnowledgeStar = (id: string) => a().toggleKnowledgeStar(id)
export const getKnowledgeStarredPages = () => a().getKnowledgeStarredPages()
export const moveKnowledgePage = (id: string, direction: 'up' | 'down') => a().moveKnowledgePage(id, direction)
export const reorderKnowledgePage = (id: string, targetIndex: number) => a().reorderKnowledgePage(id, targetIndex)
export const moveKnowledgeCategory = (id: string, direction: 'up' | 'down') => a().moveKnowledgeCategory(id, direction)
export const duplicateKnowledgePage = (data: { pageId: string; targetCategoryId?: string | null }) => a().duplicateKnowledgePage(data)
export const duplicateKnowledgeCategory = (data: { categoryId: string; targetParentId?: string | null }) => a().duplicateKnowledgeCategory(data)

// export
export const showExportSaveDialog = (opts: { defaultName: string; filters: { name: string; extensions: string[] }[] }) => a().showExportSaveDialog(opts)
export const writeExportTextFile = (filePath: string, content: string, encoding?: string): Promise<ExportFileResult> => a().writeExportTextFile(filePath, content, encoding)
// 全仓导出/导入（R6 去库化：纯 .knowbase 仓库目录 zip，无 sqlite 快照）
export const vaultBackupExportToZip = (zipPath: string) => a().vaultBackupExportToZip(zipPath)
export const vaultBackupPickArchive = () => a().vaultBackupPickArchive()
export const vaultBackupRestoreArchive = (archivePath: string) => a().vaultBackupRestoreArchive(archivePath)

// import
export const showImportOpenDialog = () => a().showImportOpenDialog()
export const readImportFiles = (paths: string[]) => a().readImportFiles(paths)
export const importPdf = (base64: string, fileName: string) => a().importPdf(base64, fileName)
export const importPdfFile = (filePath: string) => a().importPdfFile(filePath)
export const importBinary = (base64: string, fileName: string, fileType: string) => a().importBinary(base64, fileName, fileType)
export const importBinaryFile = (filePath: string, fileType: string) => a().importBinaryFile(filePath, fileType)
export const showFolderDialog = () => a().showFolderDialog()
export const importFolder = (folderPath: string, parentCategoryId: string | null) => a().importFolder(folderPath, parentCategoryId)
export const openExternal = (filePath: string) => a().openExternal(filePath)
export const getAppVersion = () => a().getAppVersion()
export const checkForUpdate = () => a().checkForUpdate()
export const downloadUpdate = (url: string, name: string, size?: number) => a().downloadUpdate(url, name, size)
export const installUpdate = (filePath: string) => a().installUpdate(filePath)
export const updatePauseDownload = () => a().updatePauseDownload()
export const updateCancelDownload = () => a().updateCancelDownload()
export const onUpdateDownloadProgress = (cb: (p: { percent: number; receivedBytes: number; totalBytes: number }) => void) => a().onUpdateDownloadProgress(cb)
export const onUpdateDownloadStage = (cb: (p: { stage: 'downloading' | 'verifying' | 'switching' }) => void) => a().onUpdateDownloadStage(cb)
// 更新说明（VS Code 式 tab）
export const getReleaseNotesState = () => a().getReleaseNotesState()
export const markReleaseNotesShown = (version: string) => a().markReleaseNotesShown(version)
export const getReleaseNote = (version: string) => a().getReleaseNote(version)
export const listReleaseNotes = () => a().listReleaseNotes()
export const pluginFetchRegistry = () => a().pluginFetchRegistry()
export const pluginInstall = (url: string, grantedCapabilities?: string[]) => a().pluginInstall(url, grantedCapabilities)
/** 插件集合变化（安装/卸载/启停/内置落位）——后台 code 宿主与插件页监听 */
export const onPluginInstalledChanged = (cb: () => void) => a().onPluginInstalledChanged(cb)
/** AI vault 写工具落盘后的外部变更通知 */
export const onWsExternalChange = (cb: (p: { relPath: string; mtimeMs?: number }) => void) => a().onWsExternalChange(cb)
/** v3.2.0 条目 ④：仓库目录发生文件系统变更（外部改动 / watcher 降级告知） */
export const onWsFsChanged = (cb: (p: { relPaths: string[]; watcherError?: string }) => void) => a().onWsFsChanged(cb)
export const pluginInstallFromFile = (grantedCapabilities?: string[]) => a().pluginInstallFromFile(grantedCapabilities)
/** 一键安装内置示例插件（开发期从工作区 samples/ 读，prod 后续用 extraResources 预置） */
export const pluginInstallBundledSample = (filename: string, grantedCapabilities?: string[]) => a().pluginInstallBundledSample(filename, grantedCapabilities)
export const pluginListInstalled = () => a().pluginListInstalled()
export const pluginSetEnabled = (id: string, enabled: boolean) => a().pluginSetEnabled(id, enabled)
export const pluginUninstall = (id: string) => a().pluginUninstall(id)
export const pluginGetContribution = (id: string, key: string) => a().pluginGetContribution(id, key)
/** 列出已启用插件声明的视图挂载点（可按 slot 过滤） */
export const pluginListViews = (slot?: string): Promise<PluginViewContribution[]> => a().pluginListViews(slot)
/** 列出已启用插件声明的命令（plugin-phase1-design C3；附首个 view 槽位供导航激活） */
export const pluginListCommands = (): Promise<PluginCommandInfo[]> => a().pluginListCommands()
/** 已启用插件声明的 fenced-code 渲染器（plugin-phase1-design C6） */
export const pluginListRenderers = (): Promise<PluginRendererInfo[]> => a().pluginListRenderers()
/** 声明式设置（plugin-phase1-design C5）：schema / 当前值（默认值合并）/ 写值（落 kb.store settings.*） */
export const pluginGetSettingsSchema = (id: string): Promise<{ schema: PluginSettingItem[] }> => a().pluginGetSettingsSchema(id)
export const pluginGetSettingValues = (id: string): Promise<{ values: Record<string, unknown> }> => a().pluginGetSettingValues(id)
export const pluginSetSettingValue = (id: string, key: string, value: unknown): Promise<{ ok: boolean; error?: string }> => a().pluginSetSettingValue(id, key, value)
/** 宿主事件推送（plugin-phase1-design C4）：主进程已按订阅过滤，按 pluginId 转发常驻 Worker */
export const onPluginEvent = (cb: (p: { pluginId: string; event: string; payload: unknown; dropped?: number }) => void): (() => void) => a().onPluginEvent(cb)
/** C 级模块插件：自有数据表读写（主进程校验 data 能力后执行，禁止任意 SQL） */
export const pluginDataQuery = (pluginId: string, table: string, opts?: { where?: Array<{ column: string; op?: string; value: unknown }>; orderBy?: string; desc?: boolean; limit?: number }): Promise<Record<string, unknown>[]> => a().pluginDataQuery(pluginId, table, opts)
export const pluginDataInsert = (pluginId: string, table: string, row: Record<string, unknown>): Promise<{ ok: boolean; id?: string; error?: string }> => a().pluginDataInsert(pluginId, table, row)
export const pluginDataUpdate = (pluginId: string, table: string, rowId: string | number, patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => a().pluginDataUpdate(pluginId, table, rowId, patch)
export const pluginDataDelete = (pluginId: string, table: string, rowId: string | number): Promise<{ ok: boolean; error?: string }> => a().pluginDataDelete(pluginId, table, rowId)
export const pluginListDeleteFxSkins = () => a().pluginListDeleteFxSkins()
// v2 协议: Plugin Host Gateway（token 会话 + 主进程单点裁决）
export const hostBridgeOpen = (pluginId: string) => a().hostBridgeOpen(pluginId)
export const hostBridgeClose = (token: string) => a().hostBridgeClose(token)
export const hostRpc = (msg: { token: string; id: string; method: string; params?: unknown }) => a().hostRpc(msg)
export const pluginSetGranted = (id: string, caps: string[]) => a().pluginSetGranted(id, caps)
export const pluginAuditList = (id?: string) => a().pluginAuditList(id)
export const pluginAuditClear = (id?: string) => a().pluginAuditClear(id)
export const pluginAuditWrite = (id: string, action: string, detail?: unknown) => a().pluginAuditWrite(id, action, detail)
export const pluginGetAllowedLevels = (): Promise<string[]> => a().pluginGetAllowedLevels()
export const pluginSetAllowedLevels = (levels: string[]): Promise<{ success: boolean; message?: string }> => a().pluginSetAllowedLevels(levels)
export const knowledgePackGetState = (pluginId: string) => a().knowledgePackGetState(pluginId)
export const knowledgePackImport = (pluginId: string, overwriteModified: boolean, forceExternalIds?: string[]) => a().knowledgePackImport(pluginId, overwriteModified, forceExternalIds)
export const onKnowledgePackProgress = (cb: (p: { pluginId: string; current: number; total: number; title: string }) => void) => a().onKnowledgePackProgress(cb)
export const getAttachmentsPath = () => a().getAttachmentsPath()
export const showImportDataDialog = () => a().showImportDataDialog()
export const readImportFile = (filePath: string) => a().readImportFile(filePath)
export const executeImport = (data: object) => a().executeImport(data)
export const importDb = (srcPath: string) => a().importDb(srcPath)
export const previewUserFromDb = (filePath: string) => a().previewUserFromDb(filePath)

// recycle bin
export const getRecycleBinItems = () => a().getRecycleBinItems()
export const restoreRecycleBinItem = (id: string) => a().restoreRecycleBinItem(id)
export const restoreRecycleBinPartial = (id: string, path: string) => a().restoreRecycleBinPartial(id, path)
export const trashRecycleBinItem = (id: string) => a().trashRecycleBinItem(id)
export const permanentlyDeleteRecycleBinItem = (id: string) => a().permanentlyDeleteRecycleBinItem(id)
export const trashAllRecycleBin = () => a().trashAllRecycleBin()
export const trashRecycleBinPartial = (id: string, path: string) => a().trashRecycleBinPartial(id, path)
export const emptyRecycleBin = () => a().emptyRecycleBin()
export const purgeExpiredRecycleBinItems = () => a().purgeExpiredRecycleBinItems()

// ===== User =====
export const getUserProfile = (): Promise<UserProfile | null> => a().getUserProfile()
export const setUserUsername = (username: string) => a().setUserUsername(username)
export const setUserPassword = (password: string) => a().setUserPassword(password)
export const verifyUserPassword = (password: string): Promise<boolean> => a().verifyUserPassword(password)
export const verifyImportPassword = (password: string, storedHash: string): Promise<boolean> => a().verifyImportPassword(password, storedHash)
export const hasUserPassword = (): Promise<boolean> => a().hasUserPassword()
export const changeUserPassword = (oldPassword: string, newPassword: string) => a().changeUserPassword(oldPassword, newPassword)
export const clearUserPassword = (password: string) => a().clearUserPassword(password)
export const pickAvatarFile = (): Promise<string | null> => a().pickAvatarFile()
export const saveAvatar = (sourcePath: string) => a().saveAvatar(sourcePath)
export const getAvatarBase64 = (): Promise<string | null> => a().getAvatarBase64()
export const getUserStats = (): Promise<UserStats> => a().getUserStats()
export const getUserExportData = (): Promise<UserExportData | null> => a().getUserExportData()
export const restoreUserFromImport = (data: UserImportData) => a().restoreUserFromImport(data)

// ===== Toolbox =====
export const getToolboxScripts = () => a().getToolboxScripts()
export const getToolboxScriptById = (id: string) => a().getToolboxScriptById(id)
export const createToolboxScript = (d: { name?: string; description?: string; content?: string; language?: string }) => a().createToolboxScript(d)
export const updateToolboxScript = (id: string, d: { name?: string; description?: string; content?: string; language?: string; sortOrder?: number }) => a().updateToolboxScript(id, d)
export const deleteToolboxScript = (id: string) => a().deleteToolboxScript(id)
export const reorderToolboxScripts = (ids: string[]) => a().reorderToolboxScripts(ids)

// ===== Password Vault =====
export const getPasswordEntries = () => a().getPasswordEntries()
export const getPasswordEntryById = (id: string) => a().getPasswordEntryById(id)
export const createPasswordEntry = (d: CreatePasswordEntryDTO) => a().createPasswordEntry(d)
export const updatePasswordEntry = (id: string, d: UpdatePasswordEntryDTO) => a().updatePasswordEntry(id, d)
export const deletePasswordEntry = (id: string) => a().deletePasswordEntry(id)

// moments
export const getMomentsPosts = () => a().getMomentsPosts()
export const getMomentsPostById = (id: string) => a().getMomentsPostById(id)
export const createMomentsPost = (d: CreateMomentsPostDTO) => a().createMomentsPost(d)
export const updateMomentsPost = (id: string, d: UpdateMomentsPostDTO) => a().updateMomentsPost(id, d)
export const deleteMomentsPost = (id: string) => a().deleteMomentsPost(id)
export const toggleMomentsPin = (id: string) => a().toggleMomentsPin(id)
export const getMomentsAlbums = (): Promise<MomentsAlbum[]> => a().getMomentsAlbums()
export const createMomentsAlbum = (name: string) => a().createMomentsAlbum(name)
export const renameMomentsAlbum = (id: string, name: string) => a().renameMomentsAlbum(id, name)
export const deleteMomentsAlbum = (id: string) => a().deleteMomentsAlbum(id)
export const setMomentsPostAlbum = (postId: string, albumId: string) => a().setMomentsPostAlbum(postId, albumId)
export const setMomentsAlbumCover = (albumId: string, postId: string, index: number) => a().setMomentsAlbumCover(albumId, postId, index)
// attachments
export const uploadAttachments = (data: { ownerType?: string; ownerId?: string; files: { name?: string; mime?: string; dataUrl?: string; base64?: string; thumbDataUrl?: string }[] }) => a().uploadAttachments(data)
export const uploadAttachmentFromPath = (data: { ownerType?: string; ownerId?: string; filePath: string }) => a().uploadAttachmentFromPath(data)

// ===== 设备传输 (lanShare，工具箱) =====
export const lanShareStart = (opts?: { port?: number; autoStopMinutes?: number }) => a().lanShareStart(opts)
export const lanShareStop = () => a().lanShareStop()
export const lanShareStatus = () => a().lanShareStatus()
export const lanShareLanAddresses = () => a().lanShareLanAddresses()
export const lanShareQr = (text: string) => a().lanShareQr(text)
export const lanShareListInbox = () => a().lanShareListInbox()
export const lanShareListOutbox = () => a().lanShareListOutbox()
export const lanShareRemoveInbox = (name: string) => a().lanShareRemoveInbox(name)
export const lanShareRemoveOutbox = (name: string) => a().lanShareRemoveOutbox(name)
export const lanShareAddToOutbox = (data: { path: string }) => a().lanShareAddToOutbox(data)
export const lanShareClearOutbox = () => a().lanShareClearOutbox()

// ===== 编辑器工作区（Vault 仓库）文件服务 =====
export const workspaceOpenDir = () => a().workspaceOpenDir()
export const workspaceInitPendingVault = (accept: boolean) => a().workspaceInitPendingVault(accept)
export const workspaceCreateVault = (name: string, parentPath?: string) => a().workspaceCreateVault(name, parentPath)
export const workspaceListDir = (rootId: string, relPath?: string) => a().workspaceListDir(rootId, relPath)
export const workspaceReadImage = (rootId: string, relPath: string) => a().workspaceReadImage(rootId, relPath)
export const workspacePickImages = (rootId: string) => a().workspacePickImages(rootId)
export const workspaceSaveImage = (rootId: string, payload: { fileName: string; dataBase64: string }) => a().workspaceSaveImage(rootId, payload)
export const workspaceReadFile = (rootId: string, relPath: string) => a().workspaceReadFile(rootId, relPath)
export const workspaceReadRange = (rootId: string, relPath: string, offset: number, length: number) => a().workspaceReadRange(rootId, relPath, offset, length)
export const workspaceSetMdStatus = (rootId: string, relPath: string, draft: boolean) => a().workspaceSetMdStatus(rootId, relPath, draft)
/** 全类型归档（docs/vault-archive-all-files-design.md §4.1）：md 走 frontmatter 双态，非 md/目录走清单 */
export const workspaceSetArchiveStatus = (rootId: string, relPath: string, archive: boolean): Promise<{ ok: boolean; count?: number; error?: string }> =>
  a().workspaceSetArchiveStatus(rootId, relPath, archive)
/** 归档清单条目（渲染层右键菜单态：目录是否已归档） */
export const workspaceGetArchiveEntries = (rootId: string): Promise<{ ok: boolean; entries?: Array<{ id: string; path: string; type: 'file' | 'dir'; archivedAt: string }>; error?: string }> =>
  a().workspaceGetArchiveEntries(rootId)
/** UI 优化条目5.3：应用内文件落盘后广播 `kb:file-saved`，供按需回读的消费方（AI教学右栏素材库 /
 *  会话要求弹层）即时同步。主进程程序写入另发 `aiTeach:tree-refresh`；应用外编辑由消费方在激活/聚焦时回读。 */
export const workspaceWriteFile = (rootId: string, relPath: string, content: string, expectedMtimeMs?: number) =>
  a().workspaceWriteFile(rootId, relPath, content, expectedMtimeMs).then((r) => {
    if (r?.ok) window.dispatchEvent(new CustomEvent('kb:file-saved', { detail: { relPath } }))
    return r
  })
export const workspaceCreateFile = (rootId: string, relPath: string, content?: string) => a().workspaceCreateFile(rootId, relPath, content)
export const workspaceMkdir = (rootId: string, relPath: string) => a().workspaceMkdir(rootId, relPath)
/** 粘贴系统剪贴板里的外部文件/目录到 relDir（srcPaths 由 paste 事件侧取得，见 types） */
export const workspacePasteExternal = (rootId: string, relDir: string, srcPaths: string[]) => a().workspacePasteExternal(rootId, relDir, srcPaths)
export const workspaceRename = (rootId: string, oldRel: string, newRel: string) => a().workspaceRename(rootId, oldRel, newRel)
export const workspaceTrash = (rootId: string, relPath: string) => a().workspaceTrash(rootId, relPath)
export const workspaceStat = (rootId: string, relPath: string) => a().workspaceStat(rootId, relPath)
export const workspaceGetRecent = () => a().workspaceGetRecent()
export const workspaceOpenById = (rootId: string) => a().workspaceOpenById(rootId)
// P8（D8）：重命名当前仓库（只改展示名，不动文件夹名）
export const workspaceRenameVault = (name: string): Promise<{ ok?: boolean; name?: string; error?: string }> => a().workspaceRenameVault(name)
export const workspaceGetCurrent = () => a().workspaceGetCurrent()
// 在系统文件管理器中打开当前仓库文件夹（标题栏仓库菜单）
export const workspaceRevealVault = (): Promise<{ ok: boolean; error?: string }> => a().workspaceRevealVault()
// 设置 → 新手引导：把《欢迎》导览页（HTML）导入仓库根并收录进知识库。
// exists=true 表示已有同名文件未写盘（需用户确认后再以 force=true 调用覆盖）
export const workspaceImportWelcomeDoc = (force?: boolean): Promise<{
  ok: boolean; created?: boolean; exists?: boolean; hasLegacyMd?: boolean; relPath?: string; error?: string
}> => a().workspaceImportWelcomeDoc(force)
export const workspaceForget = (rootId: string) => a().workspaceForget(rootId)
// P7（D6）：删除当前仓库 = 整仓进 OS 回收站（不弹提醒窗，回收站可还原兜底）
export const workspaceDeleteVault = (rootId: string): Promise<{ ok?: boolean; deletedCurrent?: boolean; error?: string }> => a().workspaceDeleteVault(rootId)
export const workspaceClearCurrentVault = () => a().workspaceClearCurrentVault()
/** v3.2.0 条目 ④ 保底：手动刷新（口径 b 全量：知识索引/图谱失效 + 归档清单 prune） */
export const workspaceRefreshVault = () => a().workspaceRefreshVault()
// P6：整仓归档（导出 zip / 导入 + 冲突逐条决策）
export const vaultArchiveExport = () => a().vaultArchiveExport()
export const vaultArchiveImportStart = () => a().vaultArchiveImportStart()
export const vaultArchiveImportDecide = (decisions: Array<{ relPath: string; action: 'overwrite' | 'skip' | 'rename' }>) => a().vaultArchiveImportDecide(decisions)
export const vaultArchiveImportCancel = () => a().vaultArchiveImportCancel()
// Web 剪藏（主进程 127.0.0.1 服务；面板读状态 + token 配对管理）
export const clipperStatus = () => a().clipperStatus()
export const clipperResetToken = () => a().clipperResetToken()
export const clipperOpenFolder = () => a().clipperOpenFolder()
export const clipperSelfPing = () => a().clipperSelfPing()
export const clipperCheckToken = (candidate: string) => a().clipperCheckToken(candidate)
export const getAttachmentsByOwner = (ownerType: string, ownerId: string): Promise<AttachmentMeta[]> => a().getAttachmentsByOwner(ownerType, ownerId)
export const deleteAttachment = (id: string) => a().deleteAttachment(id)
export const getAttachmentPath = (id: string): Promise<string | null> => a().getAttachmentPath(id)
export const readAttachmentBase64 = (id: string): Promise<string | null> => a().readAttachmentBase64(id)
export const readAttachmentBase64ByFileName = (fileName: string): Promise<string | null> => a().readAttachmentBase64ByFileName(fileName)
export const cleanupOrphanAttachments = () => a().cleanupOrphanAttachments()

/** 把应用内的图片 URL（attachment:// 或 data:）复制到系统剪贴板 */
export async function copyImageUrlToClipboard(url: string): Promise<boolean> {
  if (!url) return false
  if (url.startsWith('attachment://')) {
    const m = /attachment:\/\/([^/?#]+)/.exec(url)
    if (!m) return false
    const path = await getAttachmentPath(m[1])
    return path ? copyImage({ path }) : false
  }
  if (url.startsWith('data:')) return copyImage({ dataUrl: url })
  return false
}
export const importBackupPackage = (srcPath: string) => a().importBackupPackage(srcPath)

// ===== Checkin =====
export const habitGetAll = () => a().habitGetAll()
export const createHabit = (d: CreateHabitDTO) => a().createHabit(d)
export const updateHabit = (id: string, d: UpdateHabitDTO) => a().updateHabit(id, d)
export const deleteHabit = (id: string) => a().deleteHabit(id)
export const toggleHabitCheck = (habitId: string, date: string) => a().toggleHabitCheck(habitId, date)
export const reorderHabits = (orderedIds: string[]) => a().reorderHabits(orderedIds)

// ===== Bookmark Nav =====
export const bookmarkGetAll = () => a().bookmarkGetAll()
export const createBookmarkCategory = (d: { name: string; color?: string }) => a().createBookmarkCategory(d)
export const updateBookmarkCategory = (id: string, d: { name?: string; color?: string }) => a().updateBookmarkCategory(id, d)
export const deleteBookmarkCategory = (id: string) => a().deleteBookmarkCategory(id)
export const reorderBookmarkCategories = (orderedIds: string[]) => a().reorderBookmarkCategories(orderedIds)
export const createBookmarkItem = (d: { title: string; url: string; description?: string; categoryId?: string }) => a().createBookmarkItem(d)
export const updateBookmarkItem = (id: string, d: { title?: string; url?: string; description?: string; categoryId?: string | null }) => a().updateBookmarkItem(id, d)
export const deleteBookmarkItem = (id: string) => a().deleteBookmarkItem(id)
export const openBookmarkUrl = (url: string) => a().openBookmarkUrl(url)
export const pickBookmarkImportFile = () => a().pickBookmarkImportFile()

// ===== Remote Supervise =====
export const superviseGetConfig = (): Promise<SuperviseConfig> => a().superviseGetConfig()
export const superviseSaveConfig = (partial: Partial<SuperviseConfig>): Promise<SuperviseConfig> => a().superviseSaveConfig(partial)
export const superviseTest = (): Promise<{ ok: boolean; error?: string }> => a().superviseTest()
export const superviseGetHistory = (limit?: number) => a().superviseGetHistory(limit)
export const superviseRetry = (id: number) => a().superviseRetry(id)
export const superviseRetryAllFailed = (): Promise<{ total: number; ok: number }> => a().superviseRetryAllFailed()
export const superviseSendDailyNow = (): Promise<{ ok: boolean; skipped?: string; error?: string }> => a().superviseSendDailyNow()
export const superviseClearHistory = (): Promise<void> => a().superviseClearHistory()

// ===== Period Summary (weekly / monthly) =====
export const createPomodoroSession = (minutes: number): Promise<boolean> => a().createPomodoroSession(minutes)
export interface PeriodStats {
  checkins: number
  blogEntries: number
  knowledgePages: number
  pomodoroMinutes: number
  scheduleDone: number
}
export const getBlogPeriodStats = (start: string, end: string): Promise<PeriodStats> => a().getBlogPeriodStats(start, end)

// ===== 层级总结文件（周 / 月 / 年）—— 窗口口径见 lib/summary.ts =====
export const listSummaries = () => a().listSummaries()
export const getSummaryById = (id: string) => a().getSummaryById(id)
export const ensureSummary = (kind: 'week' | 'month' | 'year', start: string, end: string) => a().ensureSummary(kind, start, end)
export const saveSummary = (id: string, contentMd: string) => a().saveSummary(id, contentMd)

// ===== Blog Templates =====
export const listBlogTemplates = () => a().listBlogTemplates()
export const createBlogTemplate = (d: { name: string; contentMd?: string }) => a().createBlogTemplate(d)
export const updateBlogTemplate = (id: string, d: { name?: string; contentMd?: string }) => a().updateBlogTemplate(id, d)
export const deleteBlogTemplate = (id: string) => a().deleteBlogTemplate(id)

// ===== Quiz records (收藏 + 错题本) =====
export const quizRecordGetByPage = (pageId: string): Promise<QuizRecordDto[]> => a().quizRecordGetByPage(pageId)
export const quizRecordReport = (pageId: string, quizNo: number, correct: boolean, meta: { pageTitle?: string; snapshot?: QuizSnapshotDto }): Promise<QuizRecordDto | null> => a().quizRecordReport(pageId, quizNo, correct, meta)
export const quizRecordToggleFavorite = (pageId: string, quizNo: number, meta: { pageTitle?: string; snapshot?: QuizSnapshotDto }): Promise<QuizRecordDto> => a().quizRecordToggleFavorite(pageId, quizNo, meta)
export const quizRecordList = (opts?: { kind?: 'favorite' | 'wrong' | 'all'; sourceSpace?: string; collectionId?: string }): Promise<QuizRecordDto[]> => a().quizRecordList(opts)
export const quizRecordRemove = (pageId: string, quizNo: number): Promise<void> => a().quizRecordRemove(pageId, quizNo)
export const quizRecordSetCollections = (recordId: string, collectionIds: string[]): Promise<void> => a().quizRecordSetCollections(recordId, collectionIds)
export const quizRecordSetNote = (recordId: string, note: string): Promise<void> => a().quizRecordSetNote(recordId, note)
export const quizRecordSetTags = (recordId: string, tagIds: string[]): Promise<void> => a().quizRecordSetTags(recordId, tagIds)
export const quizRecordAddTags = (recordIds: string[], tagIds: string[]): Promise<void> => a().quizRecordAddTags(recordIds, tagIds)
export const quizRecordStats = (opts?: { sourceSpace?: string }): Promise<QuizStatsDto> => a().quizRecordStats(opts)
export const quizTagList = (): Promise<QuizTagDto[]> => a().quizTagList()
export const quizTagCreate = (name: string, kind?: string): Promise<QuizTagDto> => a().quizTagCreate(name, kind)
export const quizTagDelete = (tagId: string): Promise<void> => a().quizTagDelete(tagId)
export const quizCollectionList = (): Promise<QuizCollectionDto[]> => a().quizCollectionList()
export const quizCollectionCreate = (name: string): Promise<QuizCollectionDto> => a().quizCollectionCreate(name)
export const quizCollectionRename = (id: string, name: string): Promise<QuizCollectionDto> => a().quizCollectionRename(id, name)
export const quizCollectionDelete = (id: string): Promise<void> => a().quizCollectionDelete(id)
// ===== 错题本插件数据通道（JSON 版） =====
export const quizDataStats = (opts?: { sourceSpace?: string }): Promise<QuizDataStats> => a().quizDataStats(opts)
export const quizDataExport = (opts?: { sourceSpace?: string }): Promise<{ ok: boolean; path?: string; count?: number; error?: string }> => a().quizDataExport(opts)
export const quizDataClearMastered = (opts?: { sourceSpace?: string }): Promise<{ ok: boolean; removed: number; error?: string }> => a().quizDataClearMastered(opts)
export const quizDataClearAll = (opts?: { sourceSpace?: string }): Promise<{ ok: boolean; removed: number; error?: string }> => a().quizDataClearAll(opts)

// ===== AI Tools (ToolRegistry) =====
export const aiToolsList = (): Promise<AiToolsListResult> => a().aiToolsList()
export const aiToolsInvoke = (name: string, args?: unknown): Promise<AiToolInvokeResult> => a().aiToolsInvoke(name, args)
export const aiToolsGetUsage = (): Promise<AiToolUsage> => a().aiToolsGetUsage()
export const aiToolsGetRecentAudit = (limit?: number): Promise<AuditEntryInfo[]> => a().aiToolsGetRecentAudit(limit)

// ===== MCP Servers =====
export const mcpListServers = (): Promise<McpServerInfo[]> => a().mcpListServers()
export const mcpAddServer = (draft: McpServerDraft): Promise<McpServerInfo> => a().mcpAddServer(draft)
export const mcpUpdateServer = (id: string, patch: Partial<McpServerDraft>): Promise<McpServerInfo | null> => a().mcpUpdateServer(id, patch)
export const mcpRemoveServer = (id: string): Promise<boolean> => a().mcpRemoveServer(id)
export const mcpToggleServer = (id: string, enabled: boolean): Promise<{ ok: boolean; error?: string } & Partial<McpServerInfo>> => a().mcpToggleServer(id, enabled)
export const mcpListTools = (id: string): Promise<{ tools: McpToolPreview[] }> => a().mcpListTools(id)
export const mcpRefreshTools = (id: string): Promise<{ ok: boolean; error?: string; tools: McpToolPreview[] }> => a().mcpRefreshTools(id)
export const mcpTestConnection = (draft: McpServerDraft): Promise<McpTestResult> => a().mcpTestConnection(draft)

// ===== Skills =====
export const aiToolsListSkills = (): Promise<{ skills: SkillInfo[] }> => a().aiToolsListSkills()
export const aiToolsCopySkillPrompt = (pluginId: string, skillId: string): Promise<boolean> => a().aiToolsCopySkillPrompt(pluginId, skillId)
export const aiToolsInstallSkill = (data: Uint8Array, fileName?: string): Promise<SkillInstallResult> => a().aiToolsInstallSkill(data, fileName)
export const aiToolsInstallSkillFromFile = (): Promise<SkillInstallResult> => a().aiToolsInstallSkillFromFile()
export const aiToolsUninstallSkill = (id: string): Promise<SkillInstallResult> => a().aiToolsUninstallSkill(id)
export const aiToolsToggleSkill = (registryName: string, enabled: boolean): Promise<SkillInstallResult & { disabled?: boolean }> => a().aiToolsToggleSkill(registryName, enabled)

// ===== Model Gateway + AI 对话 =====
export const llmListProviders = (): Promise<{ providers: LlmProviderInfo[]; defaultChatModel: string }> => a().llmListProviders()
export const llmSaveProvider = (d: LlmProviderDraft): Promise<{ ok: boolean; id?: string; error?: string }> => a().llmSaveProvider(d)
export const llmRemoveProvider = (id: string): Promise<{ ok: boolean }> => a().llmRemoveProvider(id)
export const llmToggleProvider = (id: string, enabled: boolean): Promise<{ ok: boolean }> => a().llmToggleProvider(id, enabled)
export const llmTestConnection = (d: { type: LlmProviderType; baseUrl: string; apiKey?: string; id?: string; headers?: Record<string, string> }): Promise<LlmTestResultInfo> => a().llmTestConnection(d)
export const llmVisionModels = () => a().llmVisionModels()
export const llmRefreshModels = (id: string): Promise<{ ok: boolean; models: string[]; error?: string }> => a().llmRefreshModels(id)
export const llmAddModel = (id: string, model: string): Promise<{ ok: boolean; models: string[]; error?: string }> => a().llmAddModel(id, model)
export const llmSetDefaultModel = (value: string): Promise<{ ok: boolean }> => a().llmSetDefaultModel(value)
export const llmTestModel = (providerId: string, model: string): Promise<LlmModelTestResultInfo> => a().llmTestModel(providerId, model)
export const llmGetUsage = (): Promise<LlmUsageInfo> => a().llmGetUsage()
export const llmUsageBreakdown = (): Promise<{ month: string; entries: LlmUsageBreakdownEntry[] }> => a().llmUsageBreakdown()

// ===== 划词翻译 / 离线词典 =====
export const dictLookup = (word: string): Promise<DictLookupResult> => a().dictLookup(word)
export const dictStatus = (): Promise<DictStatus> => a().dictStatus()
export const translateInvoke = (req: TranslateInvokeRequest): Promise<TranslateInvokeResult> => a().translateInvoke(req)

// ===== PDF 工具箱 =====
export const pdfMerge = (files: Array<{ name: string; data: Uint8Array }>): Promise<PdfOpResult> => a().pdfMerge(files)
export const pdfOrganize = (payload: { data: Uint8Array; pages: number[]; rotations?: Record<string, number> }): Promise<PdfOpResult> => a().pdfOrganize(payload)
export const pdfExport = (payload: { data: Uint8Array; defaultName: string; kind?: 'pdf' | 'txt' }): Promise<PdfExportResult> => a().pdfExport(payload)
/** 界面逐页阅读：当前仓库内 .pptx → [{n,text}] */
export const docsPptxPages = (relPath: string): Promise<{ ok: boolean; pages?: Array<{ n: number; text: string }>; total?: number; error?: string }> => a().docsPptxPages(relPath)

export const agentChat = (sessionId: string, message: string, context?: AgentContextInfo, chatId?: string, source?: string, modelId?: string, effort?: 'off' | 'low' | 'medium' | 'high', skillName?: string): Promise<AgentChatResult> => a().agentChat({ sessionId, message, context, chatId, source, modelId, effort, skillName })
export const agentRegenerate = (sessionId: string, context?: AgentContextInfo, chatId?: string): Promise<AgentChatResult> => a().agentRegenerate({ sessionId, context, chatId })
/** 场景/模板启动：不落任何用户消息，用虚拟首轮触发（聊天区第一条即 AI 回复） */
export const agentStartScene = (sessionId: string, chatId?: string, source?: string, modelId?: string): Promise<AgentChatResult> => a().agentStartScene({ sessionId, chatId, source, modelId })
export const agentEditMessage = (sessionId: string, messageId: string, message: string, context?: AgentContextInfo, chatId?: string): Promise<AgentChatResult> => a().agentEditMessage({ sessionId, messageId, message, context, chatId })
export const agentDeleteMessage = (sessionId: string, messageId: string): Promise<boolean> => a().agentDeleteMessage(sessionId, messageId)
/** 会话压缩（conversation-compaction-design）：/compress 指令触发；自动预检在主进程内不走此通道 */
export const agentCompressSession = (req: { sessionId: string; modelId?: string; providerId?: string; effort?: 'off' | 'low' | 'medium' | 'high' }): Promise<AgentCompressResult> => a().agentCompressSession(req)
export const agentAbort = (chatId: string): Promise<boolean> => a().agentAbort(chatId)
/** 保存/清除会话级全局要求（仅该会话后续轮次生效，空串=清除） */
export const agentSetSessionInstructions = (id: string, instructions: string): Promise<{ ok: boolean; error?: string }> => a().agentSetSessionInstructions(id, instructions)
/** AgentRunner 实时过程步骤（chatId 过滤用；渲染层据此驱动活动气泡） */
export const onAgentStep = (cb: (p: { chatId: string; step: AgentTraceStep }) => void) => a().onAgentStep(cb)
/** 流式增量（思考链 / 正文 / 工具进行中）：与 onAgentStep 合起来才是完整过程时间线 */
export const onAgentStream = (cb: (p: { chatId: string; event: AgentStreamEvent }) => void) => a().onAgentStream(cb)
export const agentSessions = (): Promise<AgentSessionInfo[]> => a().agentSessions()
export const agentNewSession = (title?: string, source?: AgentSessionSource): Promise<AgentSessionInfo> => a().agentNewSession(title, source)
export const agentMessages = (sessionId: string): Promise<AgentStoredMessage[]> => a().agentMessages(sessionId)
export const agentRenameSession = (id: string, title: string): Promise<boolean> => a().agentRenameSession(id, title)
export const agentDeleteSession = (id: string): Promise<boolean> => a().agentDeleteSession(id)
// ===== v3.1.2 条目11：支线旁问（sidetrack）=====
/** 建支线：只装上下文快照、不调 LLM（点按钮/装载阶段零请求） */
export const agentCreateSideLane = (payload: { parentSessionId: string; anchorMessageId: string; contextTurns?: number }): Promise<AgentSideLaneCreateResult> => a().agentCreateSideLane(payload)
/** 列某主线下的支线（含已升格）；删除主线前的支线计数亦用它 */
export const agentListSideLanes = (parentSessionId: string): Promise<AgentSessionInfo[]> => a().agentListSideLanes(parentSessionId)
/** 升格支线为正式会话（单向，不可降级） */
export const agentPromoteSideLane = (laneSessionId: string): Promise<boolean> => a().agentPromoteSideLane(laneSessionId)
// ===== AI教学 P1：会话 ⇄ 文件夹绑定 =====
export interface AiTeachFolderResult { ok: boolean; relPath?: string | null; error?: string }
/** 幂等确保会话文件夹存在（新建对话确认 / P3 产物落盘懒创建共用） */
export const aiTeachEnsureSessionFolder = (id: string): Promise<AiTeachFolderResult> => a().aiTeachEnsureSessionFolder(id)
/** 查询会话文件夹相对路径（无则 relPath=null；删除确认前探测用） */
export const aiTeachSessionFolder = (id: string): Promise<AiTeachFolderResult> => a().aiTeachSessionFolder(id)
/** 会话重命名 → 文件夹同步重命名（无文件夹则不动，懒创建时生效） */
export const aiTeachRenameSessionFolder = (id: string, title: string): Promise<AiTeachFolderResult> => a().aiTeachRenameSessionFolder(id, title)
/** 会话文件夹移入系统回收站 */
export const aiTeachDeleteSessionFolder = (id: string): Promise<AiTeachFolderResult> => a().aiTeachDeleteSessionFolder(id)
// ===== AI教学 P2：会话约束文件 CONSTRAINTS.md =====
export interface AiTeachConstraintsResult { ok: boolean; text?: string; relPath?: string | null; error?: string }
/** 读会话 CONSTRAINTS.md（无文件夹/无文件 → text 空串） */
export const aiTeachReadConstraints = (id: string): Promise<AiTeachConstraintsResult> => a().aiTeachReadConstraints(id)
/** 写会话 CONSTRAINTS.md（懒建文件夹；不再写 DB sessionInstructions） */
export const aiTeachWriteConstraints = (id: string, text: string): Promise<AiTeachConstraintsResult> => a().aiTeachWriteConstraints(id, text)
/** 全局约束文档（AI教学产物根 CONSTRAINTS.md）：ensure 落骨架并返回 relPath 跳编辑区；跨会话每轮注入 */
export const aiTeachGlobalEnsureConstraints = (): Promise<AiTeachConstraintsResult & { created?: boolean }> => a().aiTeachGlobalEnsureConstraints()
/** v3.1.2 条目6：工作区约束文档（{工作区}/CONSTRAINTS.md）：ensure 落骨架并返回 relPath 跳编辑区；本工作区会话每轮注入 */
export const aiTeachWorkspaceEnsureConstraints = (wsId: string): Promise<AiTeachConstraintsResult & { created?: boolean }> => a().aiTeachWorkspaceEnsureConstraints(wsId)
/** P3b：整理成文档——回答 md 落盘会话文件夹（懒建夹 + 幂等），返回产物相对路径 */
export const aiTeachOrganizeDoc = (id: string, title: string, content: string, prefix?: string): Promise<AiTeachFolderResult> => a().aiTeachOrganizeDoc(id, title, content, prefix)
// P5 工作区两层（§3.2-6）
export const aiTeachListWorkspaces = () => a().aiTeachListWorkspaces()
export const aiTeachCreateWorkspace = (name: string) => a().aiTeachCreateWorkspace(name)
export const aiTeachRenameWorkspace = (id: string, name: string) => a().aiTeachRenameWorkspace(id, name)
export const aiTeachDeleteWorkspace = (id: string) => a().aiTeachDeleteWorkspace(id)
export const aiTeachAssignSession = (id: string, wsId: string) => a().aiTeachAssignSession(id, wsId)
export const aiTeachUnassignSession = (id: string) => a().aiTeachUnassignSession(id)
export const aiTeachSetLastWorkspace = (wsId: string | null) => a().aiTeachSetLastWorkspace(wsId)
// P6 素材库（§3.13 结构 v3）
export const aiTeachSrcRead = (id: string) => a().aiTeachSrcRead(id)
export const aiTeachSrcAdd = (id: string, input: AiTeachSourceInput) => a().aiTeachSrcAdd(id, input)
export const aiTeachSrcRemove = (id: string, no: number) => a().aiTeachSrcRemove(id, no)
export const aiTeachSrcExtract = (id: string, no: number) => a().aiTeachSrcExtract(id, no)
export const aiTeachSrcPick = () => a().aiTeachSrcPick()
export const aiTeachSrcPickDir = () => a().aiTeachSrcPickDir()
export const aiTeachSrcVisionCheck = () => a().aiTeachSrcVisionCheck()
export const aiTeachSrcSofficeProbe = (settingPath?: string) => a().aiTeachSrcSofficeProbe(settingPath)
// 3-21 视觉转写（手动档）
export const aiTeachSrcPdfBytes = (id: string, no: number) => a().aiTeachSrcPdfBytes(id, no)
export const aiTeachSrcTranscribe = (id: string, no: number, pages: { n: number; dataUrl: string }[], modelSpec?: string) => a().aiTeachSrcTranscribe(id, no, pages, modelSpec)
// 网页素材目录展开与批量抓取（web-crawl P2）
export const aiTeachSrcWebProbe = (id: string, no: number, anchorUrl?: string) => a().aiTeachSrcWebProbe(id, no, anchorUrl)
export const aiTeachSrcWebCrawl = (id: string, no: number, urls: string[]) => a().aiTeachSrcWebCrawl(id, no, urls)
export const aiTeachSrcWebCancel = (id: string) => a().aiTeachSrcWebCancel(id)
/** v3.1.1：对话级登记上收到工作区主库（原件/提取稿一并复制，对话夹保留） */
export const aiTeachSrcPromote = (id: string) => a().aiTeachSrcPromote(id)
export const onAiTeachWebProgress = (cb: (p: { sessionId: string; no: number; done: number; total: number; current: string }) => void) => window.api.onAiTeachWebProgress(cb)
// P8 用户画像（§3.14 两层 PROFILE.md）；UI 优化条目8.2.2 加工作区第三层（全局/工作区/会话）
export const aiTeachProfileReadGlobal = () => a().aiTeachProfileReadGlobal()
export const aiTeachProfileWriteGlobal = (text: string) => a().aiTeachProfileWriteGlobal(text)
export const aiTeachProfileReadSession = (id: string) => a().aiTeachProfileReadSession(id)
export const aiTeachProfileWriteSession = (id: string, text: string) => a().aiTeachProfileWriteSession(id, text)
export const aiTeachProfileReadWorkspace = (id: string) => a().aiTeachProfileReadWorkspace(id)
export const aiTeachProfileWriteWorkspace = (id: string, text: string) => a().aiTeachProfileWriteWorkspace(id, text)
export const aiTeachProfileEnsureGlobal = () => a().aiTeachProfileEnsureGlobal()
export const aiTeachProfileEnsureSession = (id: string) => a().aiTeachProfileEnsureSession(id)
export const aiTeachProfileEnsureWorkspace = (id: string) => a().aiTeachProfileEnsureWorkspace(id)
/** P3b：模型是否支持思考强度（主进程单一真相源正则） */
export const llmReasoningCapable = (model: string): Promise<boolean> => a().llmReasoningCapable(model)
export const onAiTeachTreeRefresh = (cb: (p: { dirRel: string }) => void) => a().onAiTeachTreeRefresh(cb)
export const onAiTeachNotice = (cb: (msg: string) => void) => a().onAiTeachNotice(cb)
export const llmCcSwitchList = (): Promise<CcSwitchScanResult> => a().llmCcSwitchList()
export const llmCcSwitchImport = (ids: string[]): Promise<CcSwitchImportResult> => a().llmCcSwitchImport(ids)
