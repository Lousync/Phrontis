import { ipcMain, clipboard, app, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync } from 'fs'
import { randomUUID } from 'crypto'
import { getPluginsRoot, getInstalledIndex, onPluginsChanged } from './pluginRegistry'
import { registerTool, unregisterToolsByPrefix } from './aiTools'
import { unzipBuffer } from './zip'
import { safePathInside } from './pathGuard'
import type { ToolJsonSchema } from './aiTools'

/**
 * Skill 包体系：
 * - 两路来源，统一聚合进 ToolRegistry：
 *   1. 插件贡献（contributes.skills）→ 注册名 skill.<pluginId>.<skillId>
 *   2. 独立安装（userData/skills/<id>/，zip 拖入设置页安装）→ 注册名 skill.standalone.<id>
 * - Skill 是「声明式提示词资产」，不是可执行工具：
 *   调用 = 返回变量替换后的提示词文本；消费端为 AgentRunner
 * - 独立包支持两种格式（zip 根目录或单层顶层目录）：
 *   · SKILL.md：YAML frontmatter（id/name/title/description/variables/tools）+ 正文为提示词模板
 *   · skill.json：{ id, title, description, prompt, variables?, tools? }（与插件 contributes.skills 同构）
 */

interface SkillContribution {
  id: string
  title: string
  description?: string
  prompt: string
  variables?: string[]
  tools?: string[]
}

export interface SkillInfo {
  /** 来源：插件贡献 / 独立安装 */
  source: 'plugin' | 'standalone'
  pluginId: string
  pluginName: string
  /** 注册表内名称 skill.<pluginId>.<skillId> 或 skill.standalone.<id> */
  registryName: string
  id: string
  title: string
  description: string
  prompt: string
  variables: string[]
  /** 声明依赖的工具（展示用途） */
  tools: string[]
  /** 用户是否在设置页停用了该 Skill（停用后不出现在 AI 工具列表，但文件保留） */
  disabled: boolean
}

export interface SkillInstallResult {
  success: boolean
  message?: string
  skill?: SkillInfo
}

/** 独立 skill id 即目录名：小写字母开头，仅 [a-z0-9._-]，最长 64（顺带满足工具注册表命名规则） */
const SKILL_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/
/** 安装包上限 8MB（纯提示词资产，足够宽裕） */
const MAX_SKILL_BYTES = 8 * 1024 * 1024
const MAX_SKILL_FILES = 200

// ===== 独立 skill 存储目录 =====

function getSkillsRoot(): string {
  const root = join(app.getPath('userData'), 'skills')
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}

// ---- 双格式解析 ----

/** 极简 frontmatter：支持标量与 `key: [a, b]` 数组（CRLF 统一为 LF，防 \r 吃掉行尾） */
function parseSkillMarkdown(raw: string): { meta: Record<string, unknown>; body: string } | null {
  const text = raw.replace(/\r\n/g, '\n')
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!m) return null
  const meta: Record<string, unknown> = {}
  for (const line of m[1].split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue
    const arr = trimmed.match(/^([\w-]+)\s*:\s*\[([^\]]*)\]\s*$/)
    if (arr) {
      meta[arr[1].trim()] = arr[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
      continue
    }
    const kv = trimmed.match(/^([\w-]+)\s*:\s*(.+)$/)
    if (kv) meta[kv[1].trim()] = kv[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return { meta, body: m[2] }
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function arrOf(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : []
}

/** 读取一个已落盘的独立 skill（目录名即 id） */
function readStandaloneSkillAt(dir: string, id: string): SkillInfo | null {
  try {
    // 格式一：SKILL.md（frontmatter + 正文提示词）
    const mdPath = join(dir, 'SKILL.md')
    if (existsSync(mdPath)) {
      const parsed = parseSkillMarkdown(readFileSync(mdPath, 'utf-8'))
      if (!parsed) return null
      const meta = parsed.meta
      const body = parsed.body.trim()
      if (!body) return null
      return {
        source: 'standalone',
        pluginId: '',
        pluginName: '独立安装',
        registryName: `skill.standalone.${id}`,
        id,
        title: strOf(meta.title) || strOf(meta.name) || id,
        description: strOf(meta.description),
        prompt: body,
        variables: arrOf(meta.variables),
        tools: arrOf(meta.tools),
        disabled: false,
      }
    }
    // 格式二：skill.json（与插件 contributes.skills 同构）
    const jsonPath = join(dir, 'skill.json')
    if (existsSync(jsonPath)) {
      const obj = JSON.parse(readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>
      const prompt = strOf(obj.prompt).trim()
      if (!prompt) return null
      return {
        source: 'standalone',
        pluginId: '',
        pluginName: '独立安装',
        registryName: `skill.standalone.${id}`,
        id,
        title: strOf(obj.title) || id,
        description: strOf(obj.description),
        prompt,
        variables: arrOf(obj.variables),
        tools: arrOf(obj.tools),
        disabled: false,
      }
    }
  } catch { /* 损坏条目跳过 */ }
  return null
}

function readStandaloneSkills(): SkillInfo[] {
  const root = getSkillsRoot()
  const out: SkillInfo[] = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (!SKILL_ID_RE.test(entry.name)) continue
      const s = readStandaloneSkillAt(join(root, entry.name), entry.name)
      if (s) out.push(s)
    }
  } catch { /* 目录不可读则返回已读部分 */ }
  return out
}

// ---- 读取插件贡献的 skills ----

function readPluginSkills(): SkillInfo[] {
  const out: SkillInfo[] = []
  let index: Record<string, { enabled?: boolean }> = {}
  try { index = getInstalledIndex() as Record<string, { enabled?: boolean }> } catch { return out }

  for (const [pluginId, entry] of Object.entries(index)) {
    if (!entry?.enabled) continue
    const manifestPath = join(getPluginsRoot(), pluginId, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        name?: string
        contributes?: { skills?: SkillContribution[] }
      }
      const skills = manifest.contributes?.skills
      if (!Array.isArray(skills)) continue
      for (const s of skills) {
        if (!s || typeof s.id !== 'string' || typeof s.prompt !== 'string') continue
        out.push({
          source: 'plugin',
          pluginId,
          pluginName: manifest.name || pluginId,
          registryName: `skill.${pluginId}.${s.id}`,
          id: s.id,
          title: s.title || s.id,
          description: s.description || '',
          prompt: s.prompt,
          variables: Array.isArray(s.variables) ? s.variables.map(String) : [],
          tools: Array.isArray(s.tools) ? s.tools.map(String) : [],
          disabled: false,
        })
      }
    } catch { /* 清单损坏的插件跳过 */ }
  }
  return out
}

/** 聚合两路来源（已启用的插件贡献 + 独立安装），并标记用户停用状态 */
function readEnabledSkills(): SkillInfo[] {
  const disabled = readDisabledSkillNames()
  const all = [...readPluginSkills(), ...readStandaloneSkills()]
  for (const s of all) s.disabled = disabled.has(s.registryName)
  return all
}

/**
 * 按注册名取 Skill 提示词（v3.1.1 条目10：/ 弹层显式调用——用户选中后本轮确定性注入，
 * 不再依赖模型「恰好对应」才自主调用 skill 工具）。只认**启用**的 Skill；未找到返回 null。
 */
export function findSkillPrompt(registryName: string): { title: string; prompt: string } | null {
  try {
    const name = String(registryName ?? '').trim()
    if (!name) return null
    const hit = readEnabledSkills().find(s => s.registryName === name && !s.disabled)
    if (!hit) return null
    return { title: hit.title, prompt: hit.prompt }
  } catch {
    return null
  }
}

// ---- 停用状态（设置项 aiSkillDisabled：registryName 数组，JSON 字符串） ----

let skillDeps: SkillDeps | null = null

interface SkillDeps {
  getSettingValue: (key: string) => unknown
  setSettingValue: (key: string, value: unknown) => boolean
}

function readDisabledSkillNames(): Set<string> {
  try {
    const raw = skillDeps?.getSettingValue?.('aiSkillDisabled')
    const arr = typeof raw === 'string' ? JSON.parse(raw || '[]') : []
    return new Set(Array.isArray(arr) ? arr.map(String) : [])
  } catch { return new Set() }
}

function writeDisabledSkillNames(set: Set<string>): boolean {
  if (!skillDeps) return false
  return Boolean(skillDeps.setSettingValue('aiSkillDisabled', JSON.stringify([...set])))
}

// ---- 提示词渲染 ----

function renderPrompt(prompt: string, args: Record<string, unknown>): string {
  return prompt.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (raw, name: string) => {
    const v = args[name]
    return v === undefined || v === null ? raw : String(v)
  })
}

// ---- 注册表同步 ----

/** 全量重建 skill.* 注册项（禁用/卸载插件、安装/卸载独立 skill、停用切换后调用；停用的 skill 不注册） */
export function refreshSkillRegistrations(): void {
  unregisterToolsByPrefix('skill.')
  for (const s of readEnabledSkills()) {
    if (s.disabled) continue
    const properties: ToolJsonSchema['properties'] = {}
    for (const v of s.variables) properties[v] = { type: 'string', description: `提示词变量 {{${v}}}` }
    registerTool({
      name: s.registryName,
      title: s.title,
      description: `[Skill] ${s.description || s.title}（变量: ${s.variables.join(', ') || '无'}）`,
      inputSchema: { type: 'object', properties, required: s.variables },
      source: 'skill',
      enabled: true,
      readOnly: true,
    }, (args) => ({ skillId: s.id, pluginId: s.pluginId, prompt: renderPrompt(s.prompt, args) }))
  }
}

// ---- 安装（zip 包，拖拽/文件对话框共用） ----

function installSkillFromBuffer(buf: Buffer): SkillInstallResult {
  if (buf.length === 0 || buf.length > MAX_SKILL_BYTES) {
    return { success: false, message: 'Skill 包为空或超出 8MB 上限' }
  }
  let files: Map<string, Buffer>
  try { files = unzipBuffer(buf) } catch (e: any) {
    return { success: false, message: `Skill 包解压失败: ${e?.message || e}` }
  }

  // 定位入口：根目录或单层顶层目录（兼容系统压缩工具打包）
  let prefix = ''
  let entryPath: string | null = files.has('SKILL.md') ? 'SKILL.md'
    : files.has('skill.json') ? 'skill.json' : null
  if (!entryPath) {
    for (const p of files.keys()) {
      if (/^[^/\\]+[/\\](SKILL\.md|skill\.json)$/.test(p)) { entryPath = p; prefix = p.slice(0, -(p.endsWith('SKILL.md') ? 'SKILL.md' : 'skill.json').length); break }
    }
  }
  if (!entryPath) return { success: false, message: 'Skill 包根目录缺少 SKILL.md 或 skill.json' }
  if (files.size <= 1) return { success: false, message: 'Skill 包内容为空（缺少提示词）' }

  // 解析 manifest（id 从 manifest 取，SKILL.md 用 id/name 字段，skill.json 用 id 字段）
  let rawInfo: { id?: string; title: string; description: string; prompt: string; variables: string[]; tools: string[] }
  try {
    const entryBuf = files.get(entryPath)!
    if (entryPath.endsWith('SKILL.md')) {
      const parsed = parseSkillMarkdown(entryBuf.toString('utf-8'))
      if (!parsed) return { success: false, message: 'SKILL.md 缺少 YAML frontmatter（--- 包裹的元信息）' }
      const prompt = parsed.body.trim()
      if (!prompt) return { success: false, message: 'SKILL.md 正文（提示词）为空' }
      rawInfo = {
        id: strOf(parsed.meta.id) || strOf(parsed.meta.name) || undefined,
        title: strOf(parsed.meta.title) || strOf(parsed.meta.name) || '',
        description: strOf(parsed.meta.description),
        prompt,
        variables: arrOf(parsed.meta.variables),
        tools: arrOf(parsed.meta.tools),
      }
    } else {
      const obj = JSON.parse(entryBuf.toString('utf-8')) as Record<string, unknown>
      const prompt = strOf(obj.prompt).trim()
      if (!prompt) return { success: false, message: 'skill.json 缺少 prompt 字段' }
      rawInfo = {
        id: strOf(obj.id) || undefined,
        title: strOf(obj.title) || '',
        description: strOf(obj.description),
        prompt,
        variables: arrOf(obj.variables),
        tools: arrOf(obj.tools),
      }
    }
  } catch (e: any) {
    return { success: false, message: `Skill 元信息解析失败: ${e?.message || e}` }
  }

  const id = rawInfo.id || (prefix ? prefix.replace(/[\\/]+$/, '') : '')
  if (!id || !SKILL_ID_RE.test(id)) {
    return { success: false, message: 'Skill id 非法（需小写字母开头，仅 a-z 0-9 . _ -，最长 64 字符；可在元信息中声明 id）' }
  }

  // 落盘目标：userData/skills/<id>/，先写临时目录再原子替换，避免半安装状态
  const root = getSkillsRoot()
  const target = safePathInside(root, id)
  if (!target || join(root, id) !== target) return { success: false, message: 'Skill id 非法' }
  const tmp = join(root, `.tmp-${id}-${randomUUID().slice(0, 8)}`)
  let fileCount = 0
  try {
    mkdirSync(tmp, { recursive: true })
    for (const [entryPath2, data] of files) {
      const normalized = entryPath2.replace(/\\/g, '/')
      if (normalized.endsWith('/')) continue
      if (prefix && !normalized.startsWith(prefix)) continue
      const rel = prefix ? normalized.slice(prefix.length) : normalized
      if (!rel || rel.startsWith('.tmp-')) continue
      const dest = safePathInside(tmp, rel)
      if (!dest) return { success: false, message: `Skill 包含非法路径条目: ${rel}` }
      if (data.length > MAX_SKILL_BYTES) return { success: false, message: 'Skill 包含超大文件，已中止安装' }
      fileCount++
      if (fileCount > MAX_SKILL_FILES) return { success: false, message: `Skill 文件数超出限制（最大 ${MAX_SKILL_FILES}）` }
      mkdirSync(join(dest, '..'), { recursive: true })
      writeFileSync(dest, data)
    }
    // 原子替换：删旧 → 改名（同盘 rename 原子）
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    renameSync(tmp, target)
  } catch (e: any) {
    try { if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    return { success: false, message: `Skill 安装失败: ${e?.message || e}` }
  }

  const skill = readStandaloneSkillAt(target, id)
  if (!skill) {
    try { if (existsSync(target)) rmSync(target, { recursive: true, force: true }) } catch { /* ignore */ }
    return { success: false, message: 'Skill 安装后无法读取（元信息缺失或不完整）' }
  }
  refreshSkillRegistrations()
  console.log(`[Skills] Installed standalone skill ${id}`)
  return { success: true, skill }
}

// ---- IPC ----

export function registerSkillHandlers(deps?: { getSettingValue?: (key: string) => unknown; setSettingValue?: (key: string, value: unknown) => boolean }): void {
  if (deps?.getSettingValue || deps?.setSettingValue) {
    skillDeps = {
      getSettingValue: deps.getSettingValue ?? (() => undefined),
      setSettingValue: deps.setSettingValue ?? (() => false),
    }
  }
  // 插件集合变化时同步刷新（内置插件落位、启停、卸载）
  onPluginsChanged(() => refreshSkillRegistrations())
  // 启动时先同步一次
  refreshSkillRegistrations()

  ipcMain.handle('aiTools:listSkills', () => ({
    skills: readEnabledSkills().map(({ prompt: _p, ...rest }) => rest),
  }))

  // 停用/启用单个 Skill（两路来源通用）：更新设置并重建注册表
  ipcMain.handle('aiTools:toggleSkill', (_e, registryName: string, enabled: boolean) => {
    if (typeof registryName !== 'string' || !registryName.startsWith('skill.')) {
      return { success: false, message: '参数非法' }
    }
    const all = readEnabledSkills()
    const target = all.find(s => s.registryName === registryName)
    if (!target) return { success: false, message: 'Skill 不存在或已卸载' }
    const disabled = readDisabledSkillNames()
    if (enabled) disabled.delete(registryName)
    else disabled.add(registryName)
    if (!writeDisabledSkillNames(disabled)) return { success: false, message: '设置写入失败' }
    refreshSkillRegistrations()
    console.log(`[Skills] ${enabled ? 'Enabled' : 'Disabled'} ${registryName}`)
    return { success: true, disabled: !enabled }
  })

  // 复制提示词全文到剪贴板（主进程代理，避免渲染层直连 clipboard 的权限面扩大）
  ipcMain.handle('aiTools:copySkillPrompt', (_e, pluginId: string, skillId: string) => {
    const all = readEnabledSkills()
    const s = (typeof pluginId === 'string' && typeof skillId === 'string')
      ? all.find(x => x.id === skillId && (x.source === 'standalone' ? pluginId === '' : x.pluginId === pluginId))
      : undefined
    if (!s) return false
    clipboard.writeText(s.prompt)
    return true
  })

  // 拖拽安装：渲染层读取 zip 后以字节直传
  ipcMain.handle('aiTools:installSkill', async (_e, data: Uint8Array | ArrayBuffer | null | undefined) => {
    if (!data) return { success: false, message: '未收到文件数据' }
    const buf = Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))
    return installSkillFromBuffer(buf)
  })

  // 文件对话框安装
  ipcMain.handle('aiTools:installSkillFromFile', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '安装 Skill（选择 zip 包）',
      filters: [{ name: 'Skill 包 (ZIP)', extensions: ['zip'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return { success: false, message: '已取消' }
    try {
      return installSkillFromBuffer(readFileSync(result.filePaths[0]))
    } catch (e: any) {
      return { success: false, message: `读取文件失败: ${e?.message || e}` }
    }
  })

  // 卸载独立 skill（插件贡献的 skill 随插件卸载，不在此列）
  ipcMain.handle('aiTools:uninstallSkill', (_e, id: string) => {
    if (typeof id !== 'string' || !SKILL_ID_RE.test(id)) return { success: false, message: 'Skill id 非法' }
    const dir = safePathInside(getSkillsRoot(), id)
    if (!dir || !existsSync(dir)) return { success: false, message: 'Skill 未安装' }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (e: any) {
      return { success: false, message: `删除失败: ${e?.message || e}` }
    }
    refreshSkillRegistrations()
    console.log(`[Skills] Uninstalled standalone skill ${id}`)
    return { success: true }
  })
}
