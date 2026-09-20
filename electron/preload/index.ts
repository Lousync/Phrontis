import { contextBridge, ipcRenderer, webUtils } from 'electron'

const isFillPopup = process.argv.includes('--fill-popup-window')
const fillTheme = isFillPopup
  ? (process.argv.find(a => a.startsWith('--theme=')) || '--theme=dark').split('=')[1]
  : 'dark'

/** 日程与打卡小窗：主进程创建面板窗口时通过 additionalArguments 注入 */
const isDayPanel = process.argv.includes('--day-panel-window')

const api = {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  // 编辑器文件树右键「粘贴」：请主进程对本窗口补发一次真实 paste 命令（渲染层先交焦点给文件树）
  pasteFromClipboard: () => ipcRenderer.invoke('clipboard:paste'),
  copyImage: (src: { path?: string; dataUrl?: string }) => ipcRenderer.invoke('clipboard:copyImage', src),
  clearClipboardIfEqual: (text: string) => ipcRenderer.invoke('clipboard:clearIfEqual', text),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  resizeForSidebar: (width: number, animate?: boolean) => ipcRenderer.invoke('window:resizeForSidebar', width, animate),
  onMaximizeChange: (cb: (v: boolean) => void) => {
    ipcRenderer.on('window:maximizeChange', (_e, v) => cb(v))
  },
  setFullscreen: (flag: boolean) => ipcRenderer.invoke('window:set-fullscreen', flag),
  onFullscreenChange: (cb: (v: boolean) => void) => {
    ipcRenderer.on('window:fullscreenChange', (_e, v) => cb(v))
  },
  setAlwaysOnTop: (onTop: boolean) => ipcRenderer.invoke('window:setAlwaysOnTop', onTop),
  // UI 优化条目1.7：最大化边缘拖拽恢复（渲染层热区 mousedown 启动 / window mouseup 收尾）
  edgeResizeStart: (edge: string) => ipcRenderer.invoke('window:edgeResizeStart', edge),
  edgeResizeEnd: () => ipcRenderer.invoke('window:edgeResizeEnd'),
  isAlwaysOnTop: () => ipcRenderer.invoke('window:isAlwaysOnTop'),
  reloadWindow: () => ipcRenderer.invoke('window:reload'),
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  getAllSettings: () => ipcRenderer.invoke('settings:getAll'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
  openDirDialog: () => ipcRenderer.invoke('dialog:openDir'),
  clearAllData: () => ipcRenderer.invoke('db:clearAllData'),
  getEntries: (filter: unknown) => ipcRenderer.invoke('db:getEntries', filter),
  getEntryById: (id: string) => ipcRenderer.invoke('db:getEntryById', id),
  createEntry: (data: unknown) => ipcRenderer.invoke('db:createEntry', data),
  updateEntry: (id: string, data: unknown) => ipcRenderer.invoke('db:updateEntry', id, data),
  deleteEntry: (id: string) => ipcRenderer.invoke('db:deleteEntry', id),
  toggleEntryStar: (id: string) => ipcRenderer.invoke('db:toggleEntryStar', id),
  searchEntries: (query: string) => ipcRenderer.invoke('db:searchEntries', query),
  getTags: () => ipcRenderer.invoke('db:getTags'),
  createTag: (name: string, color?: string) => ipcRenderer.invoke('db:createTag', name, color),
  deleteTag: (id: string) => ipcRenderer.invoke('db:deleteTag', id),

  // schedule
  getScheduleTodos: (date: string) => ipcRenderer.invoke('schedule:getTodos', date),
  getScheduleDates: (yearMonth: string) => ipcRenderer.invoke('schedule:getDatesWithTodos', yearMonth),
  getScheduleMonthTodos: (yearMonth: string) => ipcRenderer.invoke('schedule:getMonthTodos', yearMonth),
  getScheduleOverdue: (today: string) => ipcRenderer.invoke('schedule:getOverdue', today),
  getScheduleDeadlineCounts: (yearMonth: string) => ipcRenderer.invoke('schedule:getDeadlineCounts', yearMonth),
  getScheduleSubtasks: (parentId: string) => ipcRenderer.invoke('schedule:getSubtasks', parentId),
  getScheduleUnscheduledTodos: () => ipcRenderer.invoke('schedule:getUnscheduledTodos'),
  getScheduleWeekTodos: (weekStart: string, weekEnd: string) => ipcRenderer.invoke('schedule:getWeekTodos', weekStart, weekEnd),
  createScheduleTodo: (data: unknown) => ipcRenderer.invoke('schedule:createTodo', data),
  updateScheduleTodo: (id: string, data: unknown) => ipcRenderer.invoke('schedule:updateTodo', id, data),
  deleteScheduleTodo: (id: string) => ipcRenderer.invoke('schedule:deleteTodo', id),
  getScheduleTags: () => ipcRenderer.invoke('schedule:getTags'),
  createScheduleTag: (name: string, color?: string) => ipcRenderer.invoke('schedule:createTag', name, color),
  deleteScheduleTag: (id: string) => ipcRenderer.invoke('schedule:deleteTag', id),
  /** 日程截止提醒的系统通知被点击 → 主窗口切到日程模块（主进程 scheduleReminder.ts 发出） */
  onScheduleReminderClick: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('schedule:reminderClick', handler)
    return () => { ipcRenderer.removeListener('schedule:reminderClick', handler) }
  },

  // knowledge (Scheme A)
  getKnowledgeCategories: () => ipcRenderer.invoke('knowledge:getCategories'),
  createKnowledgeCategory: (data: unknown) => ipcRenderer.invoke('knowledge:createCategory', data),
  updateKnowledgeCategory: (id: string, data: unknown) => ipcRenderer.invoke('knowledge:updateCategory', id, data),
  deleteKnowledgeCategory: (id: string) => ipcRenderer.invoke('knowledge:deleteCategory', id),
  getKnowledgePages: (categoryId?: string | null) => ipcRenderer.invoke('knowledge:getPages', categoryId),
  // 索引 warnings（.ignore 坏行/规则未命中）：知识库 UI 消费（2026-09-08 §10.1）
  getKnowledgeIndexWarnings: () => ipcRenderer.invoke('knowledge:getIndexWarnings'),
  getKnowledgePageById: (id: string) => ipcRenderer.invoke('knowledge:getPageById', id),
  createKnowledgePage: (data: unknown) => ipcRenderer.invoke('knowledge:createPage', data),
  updateKnowledgePage: (id: string, data: unknown) => ipcRenderer.invoke('knowledge:updatePage', id, data),
  deleteKnowledgePage: (id: string) => ipcRenderer.invoke('knowledge:deletePage', id),
  searchKnowledgePages: (q: string) => ipcRenderer.invoke('knowledge:searchPages', q),
  getKnowledgeBacklinks: (pageId: string) => ipcRenderer.invoke('knowledge:getBacklinks', pageId),
  getKnowledgeBacklinkContext: (pageId: string) => ipcRenderer.invoke('knowledge:getBacklinkContext', pageId),
  getKnowledgeSimilarPages: (pageId: string) => ipcRenderer.invoke('knowledge:similarPages', pageId),
  /** 语义索引状态（B2 感知模式弱提示用：configured=false → 只走关键词路） */
  getSemanticStatus: () => ipcRenderer.invoke('knowledge:semanticStatus'),
  getKnowledgeManualLinks: (pageId: string) => ipcRenderer.invoke('knowledge:getManualLinks', pageId),
  addKnowledgeManualLink: (pageId: string, targetId: string) => ipcRenderer.invoke('knowledge:addManualLink', pageId, targetId),
  removeKnowledgeManualLink: (a: string, b: string) => ipcRenderer.invoke('knowledge:removeManualLink', a, b),
  updateKnowledgeLinks: (pageId: string, linkedTitles: string[]) => ipcRenderer.invoke('knowledge:updateLinks', pageId, linkedTitles),
  getKnowledgeTags: () => ipcRenderer.invoke('knowledge:getTags'),
  getKnowledgeGraph: () => ipcRenderer.invoke('knowledge:getGraph'),
  getGraphViewConfig: () => ipcRenderer.invoke('graphView:getConfig'),
  updateGraphViewConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke('graphView:updateConfig', patch),
  createKnowledgeTag: (n: string, c?: string) => ipcRenderer.invoke('knowledge:createTag', n, c),
  deleteKnowledgeTag: (id: string) => ipcRenderer.invoke('knowledge:deleteTag', id),
  toggleKnowledgeStar: (id: string) => ipcRenderer.invoke('knowledge:toggleStar', id),
  getKnowledgeStarredPages: () => ipcRenderer.invoke('knowledge:getStarredPages'),
  moveKnowledgePage: (id: string, direction: string) => ipcRenderer.invoke('knowledge:movePage', id, direction),
  reorderKnowledgePage: (id: string, targetIndex: number) => ipcRenderer.invoke('knowledge:reorderPage', id, targetIndex),
  moveKnowledgeCategory: (id: string, direction: string) => ipcRenderer.invoke('knowledge:moveCategory', id, direction),
  duplicateKnowledgePage: (data: unknown) => ipcRenderer.invoke('knowledge:duplicatePage', data),
  duplicateKnowledgeCategory: (data: unknown) => ipcRenderer.invoke('knowledge:duplicateCategory', data),

  // import
  showImportOpenDialog: () => ipcRenderer.invoke('import:showOpenDialog'),
  readImportFiles: (paths: string[]) => ipcRenderer.invoke('import:readFiles', paths),
  importPdf: (base64: string, fileName: string) => ipcRenderer.invoke('import:importPdf', base64, fileName),
  importPdfFile: (filePath: string) => ipcRenderer.invoke('import:importPdfFile', filePath),
  importBinary: (base64: string, fileName: string, fileType: string) => ipcRenderer.invoke('import:importBinary', base64, fileName, fileType),
  importBinaryFile: (filePath: string, fileType: string) => ipcRenderer.invoke('import:importBinaryFile', filePath, fileType),
  showFolderDialog: () => ipcRenderer.invoke('import:showFolderDialog'),
  importFolder: (folderPath: string, parentCategoryId: string | null) => ipcRenderer.invoke('import:importFolder', folderPath, parentCategoryId),
  openExternal: (filePath: string) => ipcRenderer.invoke('app:openExternal', filePath),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: (url: string, name: string, size?: number) => ipcRenderer.invoke('update:download', url, name, size),
  installUpdate: (filePath: string) => ipcRenderer.invoke('update:install', filePath),
  updatePauseDownload: () => ipcRenderer.invoke('update:pauseDownload'),
  updateCancelDownload: () => ipcRenderer.invoke('update:cancelDownload'),
  onUpdateDownloadProgress: (cb: (p: { percent: number; receivedBytes: number; totalBytes: number }) => void) => {
    const handler = (_e: unknown, p: { percent: number; receivedBytes: number; totalBytes: number }) => cb(p)
    ipcRenderer.on('update:download-progress', handler)
    return () => { ipcRenderer.removeListener('update:download-progress', handler) }
  },
  onUpdateDownloadStage: (cb: (p: { stage: 'downloading' | 'verifying' | 'switching' }) => void) => {
    const handler = (_e: unknown, p: { stage: 'downloading' | 'verifying' | 'switching' }) => cb(p)
    ipcRenderer.on('update:download-stage', handler)
    return () => { ipcRenderer.removeListener('update:download-stage', handler) }
  },
  // 更新说明（VS Code 式 tab）：清单来自 CHANGELOG，阅读记录落仓库 .knowbase/modules/release-notes/
  getReleaseNotesState: () => ipcRenderer.invoke('releaseNotes:getState'),
  markReleaseNotesShown: (version: string) => ipcRenderer.invoke('releaseNotes:markShown', version),
  getReleaseNote: (version: string) => ipcRenderer.invoke('releaseNotes:get', version),
  listReleaseNotes: () => ipcRenderer.invoke('releaseNotes:list'),
  pluginFetchRegistry: () => ipcRenderer.invoke('plugin:fetchRegistry'),
  pluginInstall: (url: string, grantedCapabilities?: string[]) => ipcRenderer.invoke('plugin:install', url, grantedCapabilities),
  onPluginDownloadProgress: (cb: (p: { key: string; received: number; total: number; percent: number; host?: string }) => void) => {
    const handler = (_e: unknown, p: { key: string; received: number; total: number; percent: number; host?: string }) => cb(p)
    ipcRenderer.on('plugin:download-progress', handler)
    return () => { ipcRenderer.removeListener('plugin:download-progress', handler) }
  },
  /** 插件集合变化（安装/卸载/启停/内置落位）——后台 code 宿主与插件页监听 */
  onPluginInstalledChanged: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('plugin:installed-changed', handler)
    return () => { ipcRenderer.removeListener('plugin:installed-changed', handler) }
  },
  /** AI vault 写工具落盘后的外部变更通知（编辑器正打开该文件时弹三选），payload {relPath, mtimeMs} */
  onWsExternalChange: (cb: (p: { relPath: string; mtimeMs?: number }) => void) => {
    const handler = (_e: unknown, p: { relPath: string; mtimeMs?: number }) => cb(p)
    ipcRenderer.on('ws:external-change', handler)
    return () => { ipcRenderer.removeListener('ws:external-change', handler) }
  },
  /** v3.2.0 条目 ④：仓库目录的文件系统变更（外部改动触发，主进程 fsWatcher 广播）。
   *  relPaths = 本次变更涉及的仓库内 posix 相对路径（拼不出时为空数组 = 「可能有任意变化」）；
   *  watcherError 仅在监听降级（仓库被删 / 网络盘）时出现一次。 */
  onWsFsChanged: (cb: (p: { relPaths: string[]; watcherError?: string }) => void) => {
    const handler = (_e: unknown, p: { relPaths: string[]; watcherError?: string }) => cb(p)
    ipcRenderer.on('ws:fs-changed', handler)
    return () => { ipcRenderer.removeListener('ws:fs-changed', handler) }
  },
  pluginInstallFromFile: (grantedCapabilities?: string[]) => ipcRenderer.invoke('plugin:installFromFile', grantedCapabilities),
  pluginInstallBundledSample: (filename: string, grantedCapabilities?: string[]) => ipcRenderer.invoke('plugin:installBundledSample', filename, grantedCapabilities),
  pluginListInstalled: () => ipcRenderer.invoke('plugin:listInstalled'),
  pluginSetEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('plugin:setEnabled', id, enabled),
  pluginUninstall: (id: string) => ipcRenderer.invoke('plugin:uninstall', id),
  pluginGetContribution: (id: string, key: string) => ipcRenderer.invoke('plugin:getContribution', id, key),
  pluginListViews: (slot: unknown) => ipcRenderer.invoke('plugin:listViews', slot),
  pluginListCommands: () => ipcRenderer.invoke('plugin:listCommands'),
  pluginListRenderers: () => ipcRenderer.invoke('plugin:listRenderers'),
  pluginGetSettingsSchema: (id: string) => ipcRenderer.invoke('plugin:getSettingsSchema', id),
  pluginGetSettingValues: (id: string) => ipcRenderer.invoke('plugin:getSettingValues', id),
  pluginSetSettingValue: (id: string, key: string, value: unknown) => ipcRenderer.invoke('plugin:setSettingValue', id, key, value),
  /** 宿主事件推送（plugin-phase1-design C4）：主进程已按订阅过滤，这里按 pluginId 转发给常驻 Worker */
  onPluginEvent: (cb: (p: { pluginId: string; event: string; payload: unknown; dropped?: number }) => void) => {
    const handler = (_e: unknown, p: { pluginId: string; event: string; payload: unknown; dropped?: number }) => cb(p)
    ipcRenderer.on('plugin:event', handler)
    return () => { ipcRenderer.removeListener('plugin:event', handler) }
  },
  pluginListDeleteFxSkins: () => ipcRenderer.invoke('plugin:listDeleteFxSkins'),
  // C 级模块插件:自有数据表读写(结构化 CRUD,主进程校验 data 能力)
  pluginDataQuery: (pluginId: string, table: string, opts: unknown) => ipcRenderer.invoke('pluginData:query', pluginId, table, opts),
  pluginDataInsert: (pluginId: string, table: string, row: unknown) => ipcRenderer.invoke('pluginData:insert', pluginId, table, row),
  pluginDataUpdate: (pluginId: string, table: string, rowId: string | number, patch: unknown) => ipcRenderer.invoke('pluginData:update', pluginId, table, rowId, patch),
  pluginDataDelete: (pluginId: string, table: string, rowId: string | number) => ipcRenderer.invoke('pluginData:delete', pluginId, table, rowId),
  // v2 协议: Plugin Host Gateway（token 会话 + 主进程单点裁决；PluginFrame 转发）
  hostBridgeOpen: (pluginId: string) => ipcRenderer.invoke('host:bridge-open', pluginId),
  hostBridgeClose: (token: string) => ipcRenderer.invoke('host:bridge-close', token),
  hostRpc: (msg: { token: string; id: string; method: string; params?: unknown }) => ipcRenderer.invoke('host:rpc', msg),
  // AI tools (ToolRegistry)
  aiToolsList: () => ipcRenderer.invoke('aiTools:list'),
  aiToolsInvoke: (name: string, args?: unknown) => ipcRenderer.invoke('aiTools:invoke', name, args),
  aiToolsGetUsage: () => ipcRenderer.invoke('aiTools:getUsage'),
  aiToolsGetRecentAudit: (limit?: number) => ipcRenderer.invoke('aiTools:getRecentAudit', limit),
  // MCP servers
  mcpListServers: () => ipcRenderer.invoke('mcp:listServers'),
  mcpAddServer: (draft: unknown) => ipcRenderer.invoke('mcp:addServer', draft),
  mcpUpdateServer: (id: string, patch: unknown) => ipcRenderer.invoke('mcp:updateServer', id, patch),
  mcpRemoveServer: (id: string) => ipcRenderer.invoke('mcp:removeServer', id),
  mcpToggleServer: (id: string, enabled: boolean) => ipcRenderer.invoke('mcp:toggleServer', id, enabled),
  mcpListTools: (id: string) => ipcRenderer.invoke('mcp:listTools', id),
  mcpRefreshTools: (id: string) => ipcRenderer.invoke('mcp:refreshTools', id),
  mcpTestConnection: (draft: unknown) => ipcRenderer.invoke('mcp:testConnection', draft),
  // Skills
  aiToolsListSkills: () => ipcRenderer.invoke('aiTools:listSkills'),
  aiToolsCopySkillPrompt: (pluginId: string, skillId: string) => ipcRenderer.invoke('aiTools:copySkillPrompt', pluginId, skillId),
  aiToolsInstallSkill: (data: Uint8Array, fileName?: string) => ipcRenderer.invoke('aiTools:installSkill', data, fileName),
  aiToolsInstallSkillFromFile: () => ipcRenderer.invoke('aiTools:installSkillFromFile'),
  aiToolsUninstallSkill: (id: string) => ipcRenderer.invoke('aiTools:uninstallSkill', id),
  aiToolsToggleSkill: (registryName: string, enabled: boolean) => ipcRenderer.invoke('aiTools:toggleSkill', registryName, enabled),
  // Model gateway + agent
  llmListProviders: () => ipcRenderer.invoke('llm:listProviders'),
  llmSaveProvider: (draft: unknown) => ipcRenderer.invoke('llm:saveProvider', draft),
  llmRemoveProvider: (id: string) => ipcRenderer.invoke('llm:removeProvider', id),
  llmToggleProvider: (id: string, enabled: boolean) => ipcRenderer.invoke('llm:toggleProvider', id, enabled),
  llmTestConnection: (draft: unknown) => ipcRenderer.invoke('llm:testConnection', draft),
  llmRefreshModels: (id: string) => ipcRenderer.invoke('llm:refreshModels', id),
  llmAddModel: (id: string, model: string) => ipcRenderer.invoke('llm:addModel', id, model),
  llmSetDefaultModel: (value: string) => ipcRenderer.invoke('llm:setDefaultModel', value),
  llmVisionModels: () => ipcRenderer.invoke('llm:visionModels'),
  llmTestModel: (providerId: string, model: string) => ipcRenderer.invoke('llm:testModel', { providerId, model }),
  llmGetUsage: () => ipcRenderer.invoke('llm:getUsage'),
  llmUsageBreakdown: () => ipcRenderer.invoke('llm:usageBreakdown'),
  llmReasoningCapable: (model: string) => ipcRenderer.invoke('llm:reasoningCapable', model),
  // 划词翻译 / 离线词典
  dictLookup: (word: string) => ipcRenderer.invoke('dict:lookup', word),
  dictStatus: () => ipcRenderer.invoke('dict:status'),
  translateInvoke: (req: unknown) => ipcRenderer.invoke('translate:invoke', req),
  // PDF 工具箱
  pdfMerge: (files: Array<{ name: string; data: Uint8Array }>) => ipcRenderer.invoke('pdf:merge', files),
  pdfOrganize: (payload: { data: Uint8Array; pages: number[]; rotations?: Record<string, number> }) => ipcRenderer.invoke('pdf:organize', payload),
  pdfExport: (payload: { data: Uint8Array; defaultName: string; kind?: 'pdf' | 'txt' }) => ipcRenderer.invoke('pdf:export', payload),
  docsPptxPages: (relPath: string) => ipcRenderer.invoke('docs:pptxPages', relPath),
  agentChat: (req: { sessionId: string; message: string; context?: unknown; chatId?: string; source?: string; modelId?: string; effort?: string; skillName?: string }) => ipcRenderer.invoke('agent:chat', req),
  agentRegenerate: (req: { sessionId: string; context?: unknown; chatId?: string }) => ipcRenderer.invoke('agent:regenerate', req),
  agentStartScene: (req: { sessionId: string; context?: unknown; chatId?: string; source?: string; modelId?: string }) => ipcRenderer.invoke('agent:startScene', req),
  agentEditMessage: (req: { sessionId: string; messageId: string; message: string; context?: unknown; chatId?: string }) => ipcRenderer.invoke('agent:editMessage', req),
  agentDeleteMessage: (sessionId: string, messageId: string) => ipcRenderer.invoke('agent:deleteMessage', { sessionId, messageId }),
  /** 会话压缩（/compress 指令 + 自动预检共用）：折叠检查点后旧轮为纪要并推进检查点 */
  agentCompressSession: (req: { sessionId: string; modelId?: string; providerId?: string; effort?: string }) => ipcRenderer.invoke('agent:compressSession', req),
  agentAbort: (chatId: string) => ipcRenderer.invoke('agent:abort', chatId),
  /** B4 编辑器内联建议：手动触发一次续写建议（独立于对话历史，不进 prompt cache 前缀） */
  aiInlineSuggestRun: (req: { requestId: string; text: string; offset: number; relPath?: string; modelId?: string; providerId?: string; effort?: string }) => ipcRenderer.invoke('ai:inlineSuggest:run', req),
  /** B4 取消在途建议请求（切文档 / 编辑器卸载 / 新请求顶替） */
  aiInlineSuggestCancel: (requestId: string) => ipcRenderer.invoke('ai:inlineSuggest:cancel', requestId),
  /** AgentRunner 实时过程步骤（chatId 过滤后驱动前端活动气泡） */
  onAgentStep: (cb: (p: { chatId: string; step: unknown }) => void) => {
    const handler = (_e: unknown, p: { chatId: string; step: unknown }) => cb(p)
    ipcRenderer.on('agent:step', handler)
    return () => { ipcRenderer.removeListener('agent:step', handler) }
  },
  /** 流式增量（思考链 / 正文 / 工具进行中；主进程已按 40ms·64 字符合批） */
  onAgentStream: (cb: (p: { chatId: string; event: unknown }) => void) => {
    const handler = (_e: unknown, p: { chatId: string; event: unknown }) => cb(p)
    ipcRenderer.on('agent:stream', handler)
    return () => { ipcRenderer.removeListener('agent:stream', handler) }
  },
  agentSessions: () => ipcRenderer.invoke('agent:sessions'),
  agentNewSession: (title?: string, source?: string) => ipcRenderer.invoke('agent:newSession', title, source),
  agentMessages: (sessionId: string) => ipcRenderer.invoke('agent:messages', sessionId),
  // AI 用量 / 会话文件改动（v3.4.0 批次5）：右栏 token 面板只读
  agentUsageGet: () => ipcRenderer.invoke('agent:usage:get'),
  agentSessionChanges: (sessionId?: string) => ipcRenderer.invoke('agent:sessionChanges:get', sessionId),
  agentRenameSession: (id: string, title: string) => ipcRenderer.invoke('agent:renameSession', id, title),
  agentSetSessionInstructions: (id: string, instructions: string) => ipcRenderer.invoke('agent:setSessionInstructions', id, instructions),
  agentDeleteSession: (id: string) => ipcRenderer.invoke('agent:deleteSession', id),
  // v3.1.2 条目11：支线旁问（sidetrack）。createSideLane 只装上下文、不调 LLM
  agentCreateSideLane: (payload: { parentSessionId: string; anchorMessageId: string; contextTurns?: number }) =>
    ipcRenderer.invoke('agent:createSideLane', payload),
  agentListSideLanes: (parentSessionId: string) => ipcRenderer.invoke('agent:listSideLanes', parentSessionId),
  agentPromoteSideLane: (laneSessionId: string) => ipcRenderer.invoke('agent:promoteSideLane', laneSessionId),
  // AI教学 P1：会话 ⇄ 文件夹绑定
  aiTeachEnsureSessionFolder: (id: string) => ipcRenderer.invoke('aiTeach:ensureSessionFolder', id),
  aiTeachSessionFolder: (id: string) => ipcRenderer.invoke('aiTeach:sessionFolder', id),
  aiTeachRenameSessionFolder: (id: string, title: string) => ipcRenderer.invoke('aiTeach:renameSessionFolder', id, title),
  aiTeachDeleteSessionFolder: (id: string) => ipcRenderer.invoke('aiTeach:deleteSessionFolder', id),
  aiTeachReadConstraints: (id: string) => ipcRenderer.invoke('aiTeach:readConstraints', id),
  /** 全局约束文档（AI教学产物根 CONSTRAINTS.md）：ensure 落骨架并返回 relPath 跳编辑区打开 */
  aiTeachGlobalEnsureConstraints: () => ipcRenderer.invoke('aiTeachGlobal:ensureConstraints'),
  /** v3.1.2 条目6：工作区约束文档（{工作区}/CONSTRAINTS.md）：ensure 落骨架并返回 relPath 跳编辑区打开 */
  aiTeachWorkspaceEnsureConstraints: (wsId: string) => ipcRenderer.invoke('aiTeachWorkspace:ensureConstraints', wsId),
  aiTeachWriteConstraints: (id: string, text: string) => ipcRenderer.invoke('aiTeach:writeConstraints', id, text),
  aiTeachOrganizeDoc: (id: string, title: string, content: string, prefix?: string) => ipcRenderer.invoke('aiTeach:organizeDoc', id, title, content, prefix),
  // AI教学 P5：工作区两层（§3.2-6）
  aiTeachListWorkspaces: () => ipcRenderer.invoke('aiTeach:listWorkspaces'),
  aiTeachCreateWorkspace: (name: string) => ipcRenderer.invoke('aiTeach:createWorkspace', name),
  aiTeachRenameWorkspace: (id: string, name: string) => ipcRenderer.invoke('aiTeach:renameWorkspace', id, name),
  aiTeachDeleteWorkspace: (id: string) => ipcRenderer.invoke('aiTeach:deleteWorkspace', id),
  aiTeachAssignSession: (id: string, wsId: string) => ipcRenderer.invoke('aiTeach:assignSession', id, wsId),
  aiTeachUnassignSession: (id: string) => ipcRenderer.invoke('aiTeach:unassignSession', id),
  aiTeachSetLastWorkspace: (wsId: null | string) => ipcRenderer.invoke('aiTeach:setLastWorkspace', wsId),
  aiTeachSrcRead: (id: string) => ipcRenderer.invoke('aiTeachSrc:read', id),
  aiTeachSrcAdd: (id: string, input: unknown) => ipcRenderer.invoke('aiTeachSrc:add', id, input),
  aiTeachSrcRemove: (id: string, no: number) => ipcRenderer.invoke('aiTeachSrc:remove', id, no),
  aiTeachSrcExtract: (id: string, no: number) => ipcRenderer.invoke('aiTeachSrc:extract', id, no),
  aiTeachSrcPick: () => ipcRenderer.invoke('aiTeachSrc:pick'),
  aiTeachSrcPickDir: () => ipcRenderer.invoke('aiTeachSrc:pickDir'),
  aiTeachSrcVisionCheck: () => ipcRenderer.invoke('aiTeachSrc:visionCheck'),
  aiTeachSrcSofficeProbe: (settingPath?: string) => ipcRenderer.invoke('aiTeachSrc:sofficeProbe', settingPath),
  aiTeachSrcPdfBytes: (id: string, no: number) => ipcRenderer.invoke('aiTeachSrc:pdfBytes', id, no),
  aiTeachSrcTranscribe: (id: string, no: number, pages: { n: number; dataUrl: string }[], modelSpec?: string) => ipcRenderer.invoke('aiTeachSrc:transcribe', id, no, pages, modelSpec),
  /** 网页素材：探测目录/单文章/门户候选 → 批量抓取（进度走 onAiTeachWebProgress）→ 取消 */
  aiTeachSrcWebProbe: (id: string, no: number, anchorUrl?: string) => ipcRenderer.invoke('aiTeachSrc:webProbe', id, no, anchorUrl),
  aiTeachSrcWebCrawl: (id: string, no: number, urls: string[]) => ipcRenderer.invoke('aiTeachSrc:webCrawl', id, no, urls),
  aiTeachSrcWebCancel: (id: string) => ipcRenderer.invoke('aiTeachSrc:webCancel', id),
  aiTeachSrcPromote: (id: string) => ipcRenderer.invoke('aiTeachSrc:promote', id),
  aiTeachProfileReadGlobal: () => ipcRenderer.invoke('aiTeachProfile:readGlobal'),
  aiTeachProfileWriteGlobal: (text: string) => ipcRenderer.invoke('aiTeachProfile:writeGlobal', text),
  aiTeachProfileReadSession: (id: string) => ipcRenderer.invoke('aiTeachProfile:readSession', id),
  aiTeachProfileWriteSession: (id: string, text: string) => ipcRenderer.invoke('aiTeachProfile:writeSession', id, text),
  aiTeachProfileReadWorkspace: (id: string) => ipcRenderer.invoke('aiTeachProfile:readWorkspace', id),
  aiTeachProfileWriteWorkspace: (id: string, text: string) => ipcRenderer.invoke('aiTeachProfile:writeWorkspace', id, text),
  aiTeachProfileEnsureGlobal: () => ipcRenderer.invoke('aiTeachProfile:ensureGlobal'),
  aiTeachProfileEnsureSession: (id: string) => ipcRenderer.invoke('aiTeachProfile:ensureSession', id),
  aiTeachProfileEnsureWorkspace: (id: string) => ipcRenderer.invoke('aiTeachProfile:ensureWorkspace', id),
  /** v3.2.0 第 20 项：画像「变化条目」合并写入（上层只接受追加） */
  aiTeachProfileApplyPatch: (layer: string, id: string | null, entries: unknown) => ipcRenderer.invoke('aiTeachProfile:applyPatch', layer, id, entries),
  /** AI教学会话文件夹落盘/改名/删除后的编辑区文件树刷新提示 */
  onAiTeachTreeRefresh: (cb: (p: { dirRel: string }) => void) => {
    const handler = (_e: unknown, p: { dirRel: string }) => cb(p)
    ipcRenderer.on('aiTeach:tree-refresh', handler)
    return () => { ipcRenderer.removeListener('aiTeach:tree-refresh', handler) }
  },
  /** 网页抓取进度（AI教学素材库） */
  onAiTeachWebProgress: (cb: (p: { sessionId: string; no: number; done: number; total: number; current: string }) => void) => {
    const handler = (_e: unknown, p: { sessionId: string; no: number; done: number; total: number; current: string }) => cb(p)
    ipcRenderer.on('aiTeach:web-crawl-progress', handler)
    return () => { ipcRenderer.removeListener('aiTeach:web-crawl-progress', handler) }
  },
  /** AI教学主进程侧不可静默的提示（根目录迁移失败等） */
  onAiTeachNotice: (cb: (msg: string) => void) => {
    const handler = (_e: unknown, msg: string) => cb(msg)
    ipcRenderer.on('aiTeach:notice', handler)
    return () => { ipcRenderer.removeListener('aiTeach:notice', handler) }
  },
  llmCcSwitchList: () => ipcRenderer.invoke('llm:ccswitch:list'),
  llmCcSwitchImport: (ids: string[]) => ipcRenderer.invoke('llm:ccswitch:import', ids),
  // 插件安全分级 + 内容包导入
  pluginSetGranted: (id: string, caps: string[]) => ipcRenderer.invoke('plugin:setGranted', id, caps),
  pluginAuditList: (id?: string) => ipcRenderer.invoke('plugin:auditList', id),
  pluginAuditClear: (id?: string) => ipcRenderer.invoke('plugin:auditClear', id),
  pluginAuditWrite: (id: string, action: string, detail?: unknown) => ipcRenderer.invoke('plugin:auditWrite', id, action, detail),
  pluginGetAllowedLevels: () => ipcRenderer.invoke('plugin:getAllowedLevels'),
  pluginSetAllowedLevels: (levels: unknown) => ipcRenderer.invoke('plugin:setAllowedLevels', levels),
  knowledgePackGetState: (pluginId: string) => ipcRenderer.invoke('knowledgePack:getImportState', pluginId),
  knowledgePackImport: (pluginId: string, overwriteModified: boolean, forceExternalIds?: string[]) => ipcRenderer.invoke('knowledgePack:importPack', pluginId, overwriteModified, forceExternalIds ?? []),
  onKnowledgePackProgress: (cb: (p: { pluginId: string; current: number; total: number; title: string }) => void) => {
    const handler = (_e: unknown, p: { pluginId: string; current: number; total: number; title: string }) => cb(p)
    ipcRenderer.on('knowledgePack:progress', handler)
    return () => { ipcRenderer.removeListener('knowledgePack:progress', handler) }
  },
  showImportDataDialog: () => ipcRenderer.invoke('import:showDataDialog'),
  readImportFile: (filePath: string) => ipcRenderer.invoke('import:readFile', filePath),
  executeImport: (data: unknown) => ipcRenderer.invoke('import:executeImport', data),
  importDb: (srcPath: string) => ipcRenderer.invoke('import:importDb', srcPath),
  previewUserFromDb: (filePath: string) => ipcRenderer.invoke('import:previewUserFromDb', filePath),
  getAttachmentsPath: () => ipcRenderer.invoke('app:getAttachmentsPath'),

  // recycle bin
  getRecycleBinItems: () => ipcRenderer.invoke('recycleBin:getItems'),
  restoreRecycleBinItem: (id: string) => ipcRenderer.invoke('recycleBin:restoreItem', id),
  restoreRecycleBinPartial: (id: string, path: string) => ipcRenderer.invoke('recycleBin:restorePartial', id, path),
  trashRecycleBinItem: (id: string) => ipcRenderer.invoke('recycleBin:trashToOS', id),
  permanentlyDeleteRecycleBinItem: (id: string) => ipcRenderer.invoke('recycleBin:permanentlyDelete', id),
  trashAllRecycleBin: () => ipcRenderer.invoke('recycleBin:trashAllToOS'),
  trashRecycleBinPartial: (id: string, path: string) => ipcRenderer.invoke('recycleBin:trashPartialToOS', id, path),
  emptyRecycleBin: () => ipcRenderer.invoke('recycleBin:emptyAll'),
  purgeExpiredRecycleBinItems: () => ipcRenderer.invoke('recycleBin:purgeExpired'),

  // user
  getUserProfile: () => ipcRenderer.invoke('user:getProfile'),
  setUserUsername: (username: string) => ipcRenderer.invoke('user:setUsername', username),
  setUserPassword: (password: string) => ipcRenderer.invoke('user:setPassword', password),
  verifyUserPassword: (password: string) => ipcRenderer.invoke('user:verifyPassword', password),
  verifyImportPassword: (password: string, storedHash: string) => ipcRenderer.invoke('user:verifyImportPassword', password, storedHash),
  hasUserPassword: () => ipcRenderer.invoke('user:hasPassword'),
  changeUserPassword: (oldPassword: string, newPassword: string) => ipcRenderer.invoke('user:changePassword', oldPassword, newPassword),
  clearUserPassword: (password: string) => ipcRenderer.invoke('user:clearPassword', password),
  pickAvatarFile: () => ipcRenderer.invoke('user:pickAvatar'),
  saveAvatar: (sourcePath: string) => ipcRenderer.invoke('user:saveAvatar', sourcePath),
  getAvatarBase64: () => ipcRenderer.invoke('user:getAvatarBase64'),
  getUserStats: () => ipcRenderer.invoke('user:getStats'),
  getUserExportData: () => ipcRenderer.invoke('user:getExportData'),
  restoreUserFromImport: (data: unknown) => ipcRenderer.invoke('user:restoreFromImport', data),

  // export
  showExportSaveDialog: (opts: unknown) => ipcRenderer.invoke('export:showSaveDialog', opts),
  writeExportTextFile: (filePath: string, content: string, encoding?: string) => ipcRenderer.invoke('export:writeTextFile', filePath, content, encoding),

  // toolbox - scripts CRUD
  getToolboxScripts: () => ipcRenderer.invoke('toolbox:getScripts'),
  getToolboxScriptById: (id: string) => ipcRenderer.invoke('toolbox:getScriptById', id),
  createToolboxScript: (data: unknown) => ipcRenderer.invoke('toolbox:createScript', data),
  updateToolboxScript: (id: string, data: unknown) => ipcRenderer.invoke('toolbox:updateScript', id, data),
  deleteToolboxScript: (id: string) => ipcRenderer.invoke('toolbox:deleteScript', id),
  reorderToolboxScripts: (ids: string[]) => ipcRenderer.invoke('toolbox:reorderScripts', ids),

  // password vault
  getPasswordEntries: () => ipcRenderer.invoke('passwordVault:getAll'),
  getPasswordEntryById: (id: string) => ipcRenderer.invoke('passwordVault:getById', id),
  createPasswordEntry: (data: unknown) => ipcRenderer.invoke('passwordVault:create', data),
  updatePasswordEntry: (id: string, data: unknown) => ipcRenderer.invoke('passwordVault:update', id, data),
  deletePasswordEntry: (id: string) => ipcRenderer.invoke('passwordVault:delete', id),

  // moments
  getMomentsPosts: () => ipcRenderer.invoke('moments:getAll'),
  getMomentsPostById: (id: string) => ipcRenderer.invoke('moments:getById', id),
  createMomentsPost: (data: unknown) => ipcRenderer.invoke('moments:create', data),
  updateMomentsPost: (id: string, data: unknown) => ipcRenderer.invoke('moments:update', id, data),
  deleteMomentsPost: (id: string) => ipcRenderer.invoke('moments:delete', id),
  toggleMomentsPin: (id: string) => ipcRenderer.invoke('moments:togglePin', id),
  getMomentsAlbums: () => ipcRenderer.invoke('moments:getAlbums'),
  createMomentsAlbum: (name: string) => ipcRenderer.invoke('moments:createAlbum', name),
  renameMomentsAlbum: (id: string, name: string) => ipcRenderer.invoke('moments:renameAlbum', id, name),
  deleteMomentsAlbum: (id: string) => ipcRenderer.invoke('moments:deleteAlbum', id),
  setMomentsPostAlbum: (postId: string, albumId: string) => ipcRenderer.invoke('moments:setPostAlbum', postId, albumId),
  setMomentsAlbumCover: (albumId: string, postId: string, index: number) => ipcRenderer.invoke('moments:setAlbumCover', albumId, postId, index),
  // attachments
  uploadAttachments: (data: unknown) => ipcRenderer.invoke('attachment:uploadMany', data),
  uploadAttachmentFromPath: (data: unknown) => ipcRenderer.invoke('attachment:uploadFromPath', data),
  getAttachmentsByOwner: (ownerType: string, ownerId: string) => ipcRenderer.invoke('attachment:getByOwner', ownerType, ownerId),
  deleteAttachment: (id: string) => ipcRenderer.invoke('attachment:delete', id),
  getAttachmentPath: (id: string) => ipcRenderer.invoke('attachment:getPath', id),
  readAttachmentBase64: (id: string) => ipcRenderer.invoke('attachment:readBase64', id),
  readAttachmentBase64ByFileName: (fileName: string) => ipcRenderer.invoke('attachment:readBase64ByFileName', fileName),
  cleanupOrphanAttachments: () => ipcRenderer.invoke('attachment:cleanupOrphans'),
  importBackupPackage: (srcPath: string) => ipcRenderer.invoke('import:importBackupPackage', srcPath),
  vaultBackupExportToZip: (zipPath: string) => ipcRenderer.invoke('vaultBackup:exportToZip', zipPath),
  vaultBackupPickArchive: () => ipcRenderer.invoke('vaultBackup:pickArchive'),
  vaultBackupRestoreArchive: (archivePath: string) => ipcRenderer.invoke('vaultBackup:restoreArchive', archivePath),
  // checkin
  habitGetAll: () => ipcRenderer.invoke('habit:getAll'),
  createHabit: (data: unknown) => ipcRenderer.invoke('habit:create', data),
  updateHabit: (id: string, data: unknown) => ipcRenderer.invoke('habit:update', id, data),
  deleteHabit: (id: string) => ipcRenderer.invoke('habit:delete', id),
  toggleHabitCheck: (habitId: string, date: string) => ipcRenderer.invoke('habit:toggleCheck', habitId, date),
  reorderHabits: (orderedIds: string[]) => ipcRenderer.invoke('habit:reorder', orderedIds),
  // bookmark nav
  bookmarkGetAll: () => ipcRenderer.invoke('bookmark:getAll'),
  createBookmarkCategory: (data: unknown) => ipcRenderer.invoke('bookmark:createCategory', data),
  updateBookmarkCategory: (id: string, data: unknown) => ipcRenderer.invoke('bookmark:updateCategory', id, data),
  deleteBookmarkCategory: (id: string) => ipcRenderer.invoke('bookmark:deleteCategory', id),
  reorderBookmarkCategories: (orderedIds: string[]) => ipcRenderer.invoke('bookmark:reorderCategories', orderedIds),
  createBookmarkItem: (data: unknown) => ipcRenderer.invoke('bookmark:createBookmark', data),
  updateBookmarkItem: (id: string, data: unknown) => ipcRenderer.invoke('bookmark:updateBookmark', id, data),
  deleteBookmarkItem: (id: string) => ipcRenderer.invoke('bookmark:deleteBookmark', id),
  openBookmarkUrl: (url: string) => ipcRenderer.invoke('bookmark:openUrl', url),
  pickBookmarkImportFile: () => ipcRenderer.invoke('bookmark:pickImportFile'),
  // remote supervise
  superviseGetConfig: () => ipcRenderer.invoke('supervise:getConfig'),
  superviseSaveConfig: (partial: unknown) => ipcRenderer.invoke('supervise:saveConfig', partial),
  superviseTest: () => ipcRenderer.invoke('supervise:test'),
  superviseGetHistory: (limit?: number) => ipcRenderer.invoke('supervise:getHistory', limit),
  superviseRetry: (id: number) => ipcRenderer.invoke('supervise:retry', id),
  superviseRetryAllFailed: () => ipcRenderer.invoke('supervise:retryAllFailed'),
  superviseSendDailyNow: () => ipcRenderer.invoke('supervise:sendDailyNow'),
  superviseClearHistory: () => ipcRenderer.invoke('supervise:clearHistory'),
  // period summary (weekly / monthly)
  createPomodoroSession: (minutes: number) => ipcRenderer.invoke('pomodoro:createSession', minutes),
  getBlogPeriodStats: (start: string, end: string) => ipcRenderer.invoke('blog:periodStats', start, end),
  // 层级总结文件（周 / 月 / 年，.knowbase/blog/summaries/）
  listSummaries: () => ipcRenderer.invoke('blog:listSummaries'),
  getSummaryById: (id: string) => ipcRenderer.invoke('blog:getSummaryById', id),
  ensureSummary: (kind: string, start: string, end: string) => ipcRenderer.invoke('blog:ensureSummary', kind, start, end),
  saveSummary: (id: string, contentMd: string) => ipcRenderer.invoke('blog:saveSummary', id, contentMd),
  // blog templates
  listBlogTemplates: () => ipcRenderer.invoke('blogTpl:list'),
  createBlogTemplate: (d: unknown) => ipcRenderer.invoke('blogTpl:create', d),
  updateBlogTemplate: (id: string, d: unknown) => ipcRenderer.invoke('blogTpl:update', id, d),
  deleteBlogTemplate: (id: string) => ipcRenderer.invoke('blogTpl:delete', id),

  // quiz records (收藏 + 错题本，全知识包通用)
  quizRecordGetByPage: (pageId: string) => ipcRenderer.invoke('quizRecord:getByPage', pageId),
  quizRecordReport: (pageId: string, quizNo: number, correct: boolean, meta: unknown) => ipcRenderer.invoke('quizRecord:report', pageId, quizNo, correct, meta),
  quizRecordToggleFavorite: (pageId: string, quizNo: number, meta: unknown) => ipcRenderer.invoke('quizRecord:toggleFavorite', pageId, quizNo, meta),
  quizRecordList: (opts: unknown) => ipcRenderer.invoke('quizRecord:list', opts),
  quizRecordRemove: (pageId: string, quizNo: number) => ipcRenderer.invoke('quizRecord:remove', pageId, quizNo),
  quizRecordSetCollections: (recordId: string, collectionIds: string[]) => ipcRenderer.invoke('quizRecord:setCollections', recordId, collectionIds),
  quizRecordSetNote: (recordId: string, note: string) => ipcRenderer.invoke('quizRecord:setNote', recordId, note),
  quizRecordSetTags: (recordId: string, tagIds: string[]) => ipcRenderer.invoke('quizRecord:setTags', recordId, tagIds),
  quizRecordAddTags: (recordIds: string[], tagIds: string[]) => ipcRenderer.invoke('quizRecord:addTags', recordIds, tagIds),
  quizRecordStats: (opts: unknown) => ipcRenderer.invoke('quizRecord:stats', opts),
  quizTagList: () => ipcRenderer.invoke('quizTag:list'),
  quizTagCreate: (name: string, kind: unknown) => ipcRenderer.invoke('quizTag:create', name, kind),
  quizTagDelete: (tagId: string) => ipcRenderer.invoke('quizTag:delete', tagId),
  quizCollectionList: () => ipcRenderer.invoke('quizCollection:list'),
  quizCollectionCreate: (name: string) => ipcRenderer.invoke('quizCollection:create', name),
  quizCollectionRename: (id: string, name: string) => ipcRenderer.invoke('quizCollection:rename', id, name),
  quizCollectionDelete: (id: string) => ipcRenderer.invoke('quizCollection:delete', id),
  // quiz vault data（「数据」面板：概览统计 / 导出备份 / 清空已掌握 / 清空全部）
  quizDataStats: (opts: unknown) => ipcRenderer.invoke('quizData:stats', opts),
  quizDataExport: (opts: unknown) => ipcRenderer.invoke('quizData:export', opts),
  quizDataClearMastered: (opts: unknown) => ipcRenderer.invoke('quizData:clearMastered', opts),
  quizDataClearAll: (opts: unknown) => ipcRenderer.invoke('quizData:clearAll', opts),
  // fill popup
  isFillPopup,
  isDayPanel,
  // 日程与打卡侧边栏（WeChat 模式：内嵌面板 + 可脱离独立窗口；独立态支持三种桌面互动模式）
  // - 当前状态：脱离态 + 模式(floating/top-dock/desktop-widget) + top-dock 收缩态 + 小组件可交互态
  dayPanelGetState: () => ipcRenderer.invoke('daypanel:get-state') as Promise<{ detached: boolean; mode: string; collapsed: boolean; widgetInteractive: boolean }>,
  // - 内嵌→脱离：创建独立窗口（与主窗口共用 #/day-panel 路由）
  dayPanelPopout: () => ipcRenderer.invoke('daypanel:popout') as Promise<boolean>,
  // - 脱离→内嵌：销毁独立窗口
  dayPanelDockBack: () => ipcRenderer.invoke('daypanel:dock-back') as Promise<boolean>,
  // - 切换（内嵌则隐藏；脱离则吸附回来）
  dayPanelToggle: () => ipcRenderer.invoke('daypanel:toggle') as Promise<boolean>,
  // - 设置独立窗口模式
  dayPanelSetMode: (m: string) => ipcRenderer.invoke('daypanel:mode-set', m) as Promise<string>,
  // - top-dock：展开 / 收回意图（500ms grace）/ 取消收回
  dayPanelTopdockExpand: () => ipcRenderer.invoke('daypanel:topdock-expand'),
  dayPanelTopdockCollapseIntent: () => ipcRenderer.invoke('daypanel:topdock-collapse-intent'),
  dayPanelTopdockCancelCollapse: () => ipcRenderer.invoke('daypanel:topdock-cancel-collapse'),
  // - desktop-widget：可交互态切换（穿透 ⇄ 可点）
  dayPanelWidgetInteractive: (active: boolean) => ipcRenderer.invoke('daypanel:widget-interactive', active) as Promise<boolean>,
  // 渲染层报告 document 所需尺寸（用于独立窗口高度自适应）
  dayPanelReportContentSize: (width: number, height: number) => { ipcRenderer.send('daypanel:content-size', { width, height }) },
  // - 跨窗口 detached/模式状态推送
  onDayPanelStateChanged: (cb: (s: { detached: boolean; mode: string; collapsed: boolean; widgetInteractive: boolean }) => void) => {
    const handler = (_e: unknown, s: { detached: boolean; mode: string; collapsed: boolean; widgetInteractive: boolean }) => cb(s)
    ipcRenderer.on('daypanel:state-changed', handler)
    return () => { ipcRenderer.removeListener('daypanel:state-changed', handler) }
  },
  // - 模式变化推送
  onDayPanelModeChanged: (cb: (s: { mode: string }) => void) => {
    const handler = (_e: unknown, s: { mode: string }) => cb(s)
    ipcRenderer.on('daypanel:mode-changed', handler)
    return () => { ipcRenderer.removeListener('daypanel:mode-changed', handler) }
  },
  // - top-dock 收缩态推送
  onDayPanelCollapsedChanged: (cb: (s: { collapsed: boolean }) => void) => {
    const handler = (_e: unknown, s: { collapsed: boolean }) => cb(s)
    ipcRenderer.on('daypanel:collapsed-changed', handler)
    return () => { ipcRenderer.removeListener('daypanel:collapsed-changed', handler) }
  },
  // - 小组件可交互态推送
  onDayPanelWidgetInteractiveChanged: (cb: (s: { interactive: boolean }) => void) => {
    const handler = (_e: unknown, s: { interactive: boolean }) => cb(s)
    ipcRenderer.on('daypanel:widget-interactive-changed', handler)
    return () => { ipcRenderer.removeListener('daypanel:widget-interactive-changed', handler) }
  },
  // - 快捷键 toggle 通知（让主窗口切内嵌可见性）
  onDayPanelToggleVisibility: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('daypanel:toggle-visibility', handler)
    return () => { ipcRenderer.removeListener('daypanel:toggle-visibility', handler) }
  },
  // - 小窗内唤起主窗口并切 Tab（tool 可选：目标模块内的子工具深链，如 toolbox 的 bookmark-nav）
  dayPanelOpenInMain: (tab: string, tool?: string) => ipcRenderer.send('daypanel:open-in-main', tab, tool),
  // 主窗口接收小窗指令（如切换模块 Tab）
  onMainCommand: (cb: (payload: { type: string; tab?: string; tool?: string }) => void) => {
    const handler = (_e: unknown, p: { type: string; tab?: string; tool?: string }) => cb(p)
    ipcRenderer.on('main:command', handler)
    return () => { ipcRenderer.removeListener('main:command', handler) }
  },
  // 跨窗口数据同步：本窗口数据变更后上报 → 主进程广播给其它窗口（kb:data-changed）
  dataNotify: (payload: { scope: string }) => ipcRenderer.send('data:notify', payload),
  onDataChanged: (cb: (payload: { scope: string }) => void) => {
    const handler = (_e: unknown, p: { scope: string }) => cb(p)
    ipcRenderer.on('kb:data-changed', handler)
    return () => { ipcRenderer.removeListener('kb:data-changed', handler) }
  },
  fillPopupTheme: fillTheme,
  fillPopupGetEntries: () => ipcRenderer.invoke('fillPopup:getEntries'),
  fillPopupCopy: (field: string, value: string) => ipcRenderer.invoke('fillPopup:copy', field, value),
  fillPopupHide: () => ipcRenderer.invoke('fillPopup:hide'),
  fillPopupCreateEntry: (data: { title?: string; url?: string; username?: string; account?: string; password?: string; notes?: string }) =>
    ipcRenderer.invoke('fillPopup:createEntry', data),
  fillPopupSetAlwaysOnTop: (on: boolean) => ipcRenderer.invoke('fillPopup:setAlwaysOnTop', on),
  onFillPopupRefresh: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('fillPopup:refresh', handler)
    return () => ipcRenderer.removeListener('fillPopup:refresh', handler)
  },
  // 番茄钟状态跨窗口同步：主进程维护快照，渲染层上报 + 接收广播
  pomodoroUpdateState: (snapshot: { visible: boolean; display: string; running: boolean; phase: string; done: boolean; expanded: boolean; progress: number }) => {
    ipcRenderer.send('pomodoro:state-update', snapshot)
  },
  pomodoroGetState: () => ipcRenderer.invoke('pomodoro:get-state') as Promise<{ visible: boolean; display: string; running: boolean; phase: string; done: boolean; expanded: boolean; progress: number }>,
  onPomodoroState: (cb: (snapshot: { visible: boolean; display: string; running: boolean; phase: string; done: boolean; expanded: boolean; progress: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, snapshot: { visible: boolean; display: string; running: boolean; phase: string; done: boolean; expanded: boolean; progress: number }) => cb(snapshot)
    ipcRenderer.on('pomodoro:state-broadcast', handler)
    return () => ipcRenderer.removeListener('pomodoro:state-broadcast', handler)
  },
  // 设备传输（工具箱）：局域网短时双向互传
  lanShareStart: (opts?: { port?: number; autoStopMinutes?: number }) => ipcRenderer.invoke('lanShare:start', opts),
  lanShareStop: () => ipcRenderer.invoke('lanShare:stop'),
  lanShareStatus: () => ipcRenderer.invoke('lanShare:status'),
  lanShareLanAddresses: () => ipcRenderer.invoke('lanShare:lanAddresses'),
  lanShareQr: (text: string) => ipcRenderer.invoke('lanShare:qr', text),
  lanShareListInbox: () => ipcRenderer.invoke('lanShare:listInbox'),
  lanShareListOutbox: () => ipcRenderer.invoke('lanShare:listOutbox'),
  lanShareRemoveInbox: (name: string) => ipcRenderer.invoke('lanShare:removeInbox', name),
  lanShareRemoveOutbox: (name: string) => ipcRenderer.invoke('lanShare:removeOutbox', name),
  lanShareAddToOutbox: (data: { path: string }) => ipcRenderer.invoke('lanShare:addToOutbox', data),
  lanShareClearOutbox: () => ipcRenderer.invoke('lanShare:clearOutbox'),
  // 编辑器工作区（Vault 仓库）：文件服务
  workspaceOpenDir: () => ipcRenderer.invoke('ws:openDir'),
  workspaceInitPendingVault: (accept: boolean) => ipcRenderer.invoke('ws:initPendingVault', accept),
  workspaceCreateVault: (name: string, parentPath?: string) => ipcRenderer.invoke('ws:createVault', name, parentPath),
  workspaceListDir: (rootId: string, relPath?: string) => ipcRenderer.invoke('ws:listDir', rootId, relPath ?? ''),
  workspaceReadFile: (rootId: string, relPath: string) => ipcRenderer.invoke('ws:readFile', rootId, relPath),
  workspaceReadImage: (rootId: string, relPath: string) => ipcRenderer.invoke('ws:readImage', rootId, relPath),
  workspacePickImages: (rootId: string) => ipcRenderer.invoke('ws:pickImagesToAttachments', rootId),
  workspaceSaveImage: (rootId: string, payload: { fileName: string; dataBase64: string }) => ipcRenderer.invoke('ws:saveImageToAttachments', rootId, payload),
  workspaceReadRange: (rootId: string, relPath: string, offset: number, length: number) => ipcRenderer.invoke('ws:readRange', rootId, relPath, offset, length),
  // PDF 阅读体验整包（v3.4.0 第 2 项）：进度/书签/封面缓存/导入
  pdfReaderListBooks: () => ipcRenderer.invoke('pdfReader:listBooks'),
  pdfReaderGet: (rootId: string, relPath: string) => ipcRenderer.invoke('pdfReader:get', rootId, relPath),
  pdfReaderPatch: (rootId: string, relPath: string, patch: unknown, expectedUpdatedAt?: string) => ipcRenderer.invoke('pdfReader:patch', rootId, relPath, patch, expectedUpdatedAt),
  pdfReaderCoverList: () => ipcRenderer.invoke('pdfReader:coverList'),
  pdfReaderCoverGet: (rootId: string, relPath: string) => ipcRenderer.invoke('pdfReader:coverGet', rootId, relPath),
  pdfReaderCoverSave: (rootId: string, relPath: string, dataUrl: string, expectedMtimeMs: number) => ipcRenderer.invoke('pdfReader:coverSave', rootId, relPath, dataUrl, expectedMtimeMs),
  workspaceWriteFile: (rootId: string, relPath: string, content: string, expectedMtimeMs?: number) => ipcRenderer.invoke('ws:writeFile', rootId, relPath, content, expectedMtimeMs),
  // 归档三条通道（ws:setMdStatus / ws:setArchiveStatus / ws:getArchiveEntries）已于 2026-09-20 随归档退役删除
  workspaceCreateFile: (rootId: string, relPath: string, content?: string) => ipcRenderer.invoke("ws:createFile", rootId, relPath, content),
  workspaceMkdir: (rootId: string, relPath: string) => ipcRenderer.invoke('ws:mkdir', rootId, relPath),
  // 粘贴系统剪贴板里的外部文件/目录：srcPaths 由渲染层 paste 事件 + webUtils.getPathForFile 取得
  // （主进程 clipboard.readBuffer('FileNameW') 实测只能拿到第一条，多选会丢文件——见 ws:pasteExternal 注释）
  workspacePasteExternal: (rootId: string, relDir: string, srcPaths: string[]) => ipcRenderer.invoke('ws:pasteExternal', rootId, relDir, srcPaths),
  workspaceRename: (rootId: string, oldRel: string, newRel: string) => ipcRenderer.invoke('ws:rename', rootId, oldRel, newRel),
  workspaceTrash: (rootId: string, relPath: string) => ipcRenderer.invoke('ws:trash', rootId, relPath),
  workspaceStat: (rootId: string, relPath: string) => ipcRenderer.invoke('ws:stat', rootId, relPath),
  workspaceGetRecent: () => ipcRenderer.invoke('ws:getRecent'),
  workspaceOpenById: (rootId: string) => ipcRenderer.invoke('ws:openById', rootId),
  workspaceGetCurrent: () => ipcRenderer.invoke('ws:getCurrent'),
  // 在系统文件管理器中打开当前仓库文件夹（标题栏仓库菜单）
  workspaceRevealVault: () => ipcRenderer.invoke('ws:revealVault'),
  // 设置 → 新手引导：把《欢迎》导览页（HTML）导入仓库根并收录进知识库（force=true 覆盖已有同名文件）
  workspaceImportWelcomeDoc: (force?: boolean) => ipcRenderer.invoke('ws:importWelcomeDoc', force === true),
  // P8（D8）：重命名当前仓库（展示名同步 登记表/meta/最近列表，不改文件夹名）
  workspaceRenameVault: (name: string) => ipcRenderer.invoke('ws:renameVault', name),
  workspaceForget: (rootId: string) => ipcRenderer.invoke('ws:forget', rootId),
  // P7（D6）：删除仓库 = 整仓进 OS 回收站（主进程护栏校验；无提醒弹窗）
  workspaceDeleteVault: (rootId: string) => ipcRenderer.invoke('ws:deleteVault', rootId),
  workspaceClearCurrentVault: () => ipcRenderer.invoke('ws:clearCurrentVault'),
  /** v3.2.0 条目 ④ 保底：手动「刷新资源管理器」（口径 b 全量 = 知识索引/图谱失效 + 归档清单 prune；
   *  文件树重扫由渲染层自己做，主进程侧 ws:listDir 无缓存） */
  workspaceRefreshVault: () => ipcRenderer.invoke('ws:refreshVault') as Promise<{ ok: boolean; pruned?: number; error?: string }>,
  // P6：整仓导出 / 导入（冲突逐条决策：覆盖/跳过/重命名）
  vaultArchiveExport: () => ipcRenderer.invoke('va:export'),
  vaultArchiveImportStart: () => ipcRenderer.invoke('va:importStart'),
  vaultArchiveImportDecide: (decisions: Array<{ relPath: string; action: 'overwrite' | 'skip' | 'rename' }>) => ipcRenderer.invoke('va:importDecide', decisions),
  vaultArchiveImportCancel: () => ipcRenderer.invoke('va:importCancel'),
  // Web 剪藏（工具箱入口；服务在主进程，面板只做状态展示与配对管理）
  clipperStatus: () => ipcRenderer.invoke('clipper:status'),
  clipperResetToken: () => ipcRenderer.invoke('clipper:resetToken'),
  clipperOpenFolder: () => ipcRenderer.invoke('clipper:openFolder'),
  clipperSelfPing: () => ipcRenderer.invoke('clipper:selfPing'),
  clipperCheckToken: (candidate: string) => ipcRenderer.invoke('clipper:checkToken', candidate),
}

contextBridge.exposeInMainWorld('api', api)

// 开发者工具(仅 DEV):主进程侧对 app.isPackaged 守卫,打包版 handler 不存在,调用必然被拒
const devtoolsApi = {
  helpDocsList: () => ipcRenderer.invoke('devtools:helpDocs:list'),
  helpDocsRead: (fileName: string) => ipcRenderer.invoke('devtools:helpDocs:read', fileName),
  helpDocsWrite: (doc: { fileName: string; title: string; category: string; icon: string; body: string }) =>
    ipcRenderer.invoke('devtools:helpDocs:write', doc),
  helpDocsDelete: (fileName: string) => ipcRenderer.invoke('devtools:helpDocs:delete', fileName),
}
contextBridge.exposeInMainWorld('devtoolsApi', devtoolsApi)
export type DevtoolsElectronAPI = typeof devtoolsApi

// AI 测试桥上报通道(仅 DEV):与 devtoolsApi 同款约定 —— 打包版主进程侧
// 不注册 handler(app.isPackaged 守卫),调用必然被拒,不影响生产行为。
const devbridgeApi = {
  report: (payload: unknown) => ipcRenderer.invoke('devbridge:report', payload),
}
contextBridge.exposeInMainWorld('devbridgeApi', devbridgeApi)
export type DevbridgeElectronAPI = typeof devbridgeApi
