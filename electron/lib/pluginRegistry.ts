// R6 去库化（D9）：全局数据 = userData/data/*.json（sql.js 已移除）
import { app, ipcMain, net, dialog, BrowserWindow } from 'electron'
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync, statSync, lstatSync } from 'fs'
import { join, resolve, sep, extname, basename, dirname } from 'path'
import { unzipBuffer } from './zip'
import { safePathInside } from './pathGuard'
import { isNewerVersion } from './updateService'
import { createGateway } from './pluginHostGateway'
import { pluginStoreGet, pluginStoreSet, pluginStoreDelete, pluginStoreHas, pluginStoreUsage } from './kbStore/pluginStore'
import { subscribePluginEvents, unsubscribePluginEvents, unsubscribeAllPluginEvents } from './pluginEvents'
import { searchKnowledge } from './knowledgeSearch'
import { getKnowledgeIndex } from './kbStore/knowledgeIndex'
import { vaultGetBacklinks } from './kbStore/knowledgeVaultRepo'
import { evaluateFrontmatterQuery } from './kbStore/frontmatterQuery'
import { enforceVaultScope } from './kbStore/vaultScope'
import { resolveSafe, writeWorkspaceFile, trashWorkspacePath, invalidateIndexIfCurrentVault } from './workspaceManager'
import { getCurrentVault } from './kbStore/vaultContext'
// kb.vault.* 复用 builtin.vault.* 同一套经审计的安全 helper（不另写规则，防两套规则漂移）
import { vaultRootPath, childAiAllowed, isAiReadableFile, isAiWritableFile, assertAiWritable, MAX_VAULT_FILE, MAX_VAULT_LIST_ENTRIES } from './builtinTools'
import { verifyPluginSignature, buildKeyring } from './pluginSigning'
import { getPackState, importPack } from './knowledgePackImporter'
import { appendAudit, readAuditRaw, clearAudit } from './pluginAudit'
import {
  validateTableDef, ensurePluginTables, dropPluginTables,
  pluginQuery, pluginInsert, pluginUpdate, pluginDelete, pluginDumpTable,
} from './pluginDataStore'
import type { PluginTableDef, WhereCond } from './pluginDataStore'

/**
 * 插件注册表与安装管理。
 * 安全分级:S(内容级,纯静态) / A(数据级,经主进程枚举动作写库) / B(能力级,UI 沙箱 + 桥)。
 * 判级由主进程强算(防骗标);code 类型在清单校验阶段拒收。
 */

/** 插件下载/registry 镜像默认值 — 与 src/lib/settings.ts updateMirror 及 updateService 保持一致 */
const DEFAULT_PLUGIN_MIRROR = 'https://gh-proxy.com'
let pluginSettingReader: (key: string) => unknown = () => undefined

/** 用户配置的 ghproxy 前缀镜像(gh.dpik.top 等);未配置过用默认,显式空串=不用 */
function userGhMirror(): string | null {
  const raw = pluginSettingReader('updateMirror')
  let s: string
  if (raw === undefined || raw === null) s = DEFAULT_PLUGIN_MIRROR
  else { s = String(raw).trim().replace(/\/+$/, ''); if (!s) return null }
  return /^https:\/\/[\w.-]+(:\d+)?$/.test(s) ? s : null
}

// registry 拉取顺序:ghproxy 节点(实时性好,jsDelivr CDN 缓存可达 24h 会给陈旧列表) → raw → jsDelivr
const REGISTRY_MIRRORS = [
  `${DEFAULT_PLUGIN_MIRROR}/https://raw.githubusercontent.com/Lousync/Phrontis-plugins/main/registry.json`,
  'https://raw.githubusercontent.com/Lousync/Phrontis-plugins/main/registry.json',
  'https://cdn.jsdelivr.net/gh/Lousync/Phrontis-plugins@main/registry.json',
  'https://fastly.jsdelivr.net/gh/Lousync/Phrontis-plugins@main/registry.json',
]
// 下载镜像:raw 失败时自动改走 jsDelivr 的 GitHub 镜像(国内可达性好)
const TRUSTED_HOSTS = new Set([
  'github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com', 'codeload.github.com',
  'cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'gcore.jsdelivr.net',
])
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024   // 单个插件包上限
const MAX_FILE_COUNT = 500                    // 单插件文件数上限
const MAX_MANIFEST_BYTES = 256 * 1024         // manifest 上限
const FILE_PICK_MAX_BYTES = 30 * 1024 * 1024  // kb.files.pick 单文件上限（IPC base64 传输防内存打爆）
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/
const VER_RE = /^\d+\.\d+\.\d+/
const ENTRY_RE = /^[\w][\w.-]{0,64}\.html$/
/** code 插件入口：单文件 .js/.mjs（Worker 加载）；拒绝目录/嵌套，防路径穿越 */
const CODE_ENTRY_RE = /^[\w][\w.-]{0,64}\.(js|mjs)$/
const ICON_RE = /^[\w][\w.-]{0,64}\.(svg|png|jpg|jpeg|webp|gif)$/i
const KNOWN_CONTRIBUTIONS = ['blogTemplates', 'theme', 'habitPresets', 'bookmarkPresets', 'pomodoroPresets', 'helpDocs', 'tools', 'skills', 'automationRule', 'knowledgePages', 'sidebarIcons', 'deleteFx', 'tables', 'views', 'commands', 'settings', 'renderers']
/** Skill 变量名规则（提示词 {{var}} 占位符） */
const SKILL_VAR_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/
/** Skill 声明依赖的工具名（命名空间规则与 ToolRegistry 一致，一期仅展示不校验执行权） */
const SKILL_TOOL_REF_RE = /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9._-]*)*$/
// 安全分级:S=内容级(纯静态) / A=数据级(写库) / B=能力级(UI 沙箱+桥) / C=模块级(插件自有表+宿主 API+视图挂载)
export type RiskLevel = 'S' | 'A' | 'B' | 'C'
const LEVEL_RANK: Record<RiskLevel, number> = { S: 0, A: 1, B: 2, C: 3 }
// 数据级贡献键(命中即为 A 级)
const DATA_LEVEL_KEYS = ['habitPresets', 'bookmarkPresets', 'automationRule', 'knowledgePages']
// 内容级贡献键(仅含这些为 S 级)
const CONTENT_LEVEL_KEYS = ['theme', 'blogTemplates', 'helpDocs', 'pomodoroPresets', 'skills', 'sidebarIcons', 'deleteFx']
// UI 插件能力白名单:theme/clipboard 为一期放行;data/knowledge/navigation 为 C 级模块插件(需显式授权)
const KNOWN_CAPABILITIES = ['theme', 'clipboard', 'data', 'knowledge', 'navigation', 'files', 'vault:read', 'vault:write']

export interface PluginManifest {
  id: string
  name: string
  version: string
  engineVersion?: string
  author?: string
  description?: string
  type: 'declarative' | 'ui' | 'code'
  entry?: string
  icon?: string
  category?: string
  riskLevel?: RiskLevel
  capabilities?: string[]
  activation?: string[]
  contributes?: Record<string, unknown>
  /** v3（R7）契约字段：API 版本（1=旧行为 / 2=token 会话 + 新命名空间）；缺省 1 */
  apiVersion?: number
  /** v3（R7）契约字段：供应链签名（市场包必填；algo 目前仅 ed25519） */
  signing?: { algo: string; keyId: string; sig: string }
  /** v3（R7）契约字段：写操作收敛前缀（如 ["pages/"]）；缺省 = 全库（只读无此限制） */
  vaultScope?: string[]
}

/** v3 包签名结构校验（V3-1 仅元数据门禁；密钥验证在 V3-4 与 keyring 落地） */
export function validateSigningField(s: unknown): string | null {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'signing 必须是对象'
  const o = s as Record<string, unknown>
  if (o.algo !== 'ed25519') return 'signing.algo 目前仅支持 ed25519'
  if (typeof o.keyId !== 'string' || !o.keyId.trim() || o.keyId.length > 64) return 'signing.keyId 缺失或过长(≤64)'
  if (typeof o.sig !== 'string' || o.sig.length === 0 || o.sig.length > 8192) return 'signing.sig 缺失或过长'
  if (!/^[A-Za-z0-9+/=]+$/.test(o.sig)) return 'signing.sig 需为 base64'
  return null
}

/** 删除动画皮肤（插件 contributes.deleteFx，纯数据 S 级） */
export interface DeleteFxSkin {
  pluginId?: string
  id?: string
  name?: string
  /** SVG 片段（注入 <svg> 内，禁脚本/事件） */
  dragonSvg?: string
  /** 粒子颜色（#RRGGBB 等） */
  particleColors?: string[]
  /** 吞噬遮罩颜色 */
  wipeColor?: string
  /** 动画时长 ms（300-2000） */
  durationMs?: number
}

interface InstalledEntry { id: string; version: string; enabled: boolean; installedAt: string; builtin?: boolean; userRemoved?: boolean; riskLevel?: RiskLevel; grantedCapabilities?: string[]; grantedAt?: string }
type InstalledIndex = Record<string, InstalledEntry>

export interface PluginSummary {
  id: string
  name: string
  version: string
  engineVersion?: string
  author?: string
  description?: string
  type: string
  entry?: string
  icon?: string
  category?: string
  riskLevel: RiskLevel
  capabilities: string[]
  grantedCapabilities: string[]
  legacyGrant?: boolean
  enabled: boolean
  installedAt: string
  builtin?: boolean
  contributions: string[]
  broken?: boolean
}

/** 插件根目录(userData/plugins) */
export function getPluginsRoot(): string {
  const dir = join(app.getPath('userData'), 'plugins')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 插件图标访问地址(经 plugin:// 协议;无图标返回 null) */
export function pluginIconUrl(id: string, icon?: string): string | null {
  if (!icon || !ICON_RE.test(icon)) return null
  return `plugin://${id}/${icon}`
}

function indexPath(): string {
  return join(getPluginsRoot(), 'installed.json')
}

function readIndex(): InstalledIndex {
  try {
    if (!existsSync(indexPath())) return {}
    return JSON.parse(readFileSync(indexPath(), 'utf-8')) as InstalledIndex
  } catch { return {} }
}

function writeIndex(idx: InstalledIndex): void {
  try {
    writeFileSync(indexPath(), JSON.stringify(idx, null, 2), 'utf-8')
  } catch (err) {
    console.error('[Plugins] Failed to write installed.json:', err)
  }
}

/** 已安装索引只读快照（供 Skill 等派生消费方遍历启用状态） */
export function getInstalledIndex(): InstalledIndex {
  return readIndex()
}

// ---------- manifest 校验 ----------

function validateManifest(m: unknown, opts?: { legacy?: boolean }): { manifest: PluginManifest } | { error: string } {
  if (!m || typeof m !== 'object') return { error: 'plugin.json 不是有效的 JSON 对象' }
  const raw = m as Record<string, unknown>
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return { error: '插件 id 缺失或格式非法(仅允许小写字母/数字/. _ -)' }
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 50) return { error: '插件 name 缺失或过长' }
  if (typeof raw.version !== 'string' || !VER_RE.test(raw.version)) return { error: '插件 version 缺失或格式非法(需 x.y.z)' }
  if (raw.type === 'code') {
    // v3 契约放行（V3-2b）：entry 须为单 .js/.mjs（Worker 加载），capabilities 可声明；
    // 运行时 = 宿主创建 Worker + 同一 kb-plugin v2 协议（PluginFrame code 分支）。
    if (typeof raw.entry !== 'string' || !CODE_ENTRY_RE.test(raw.entry)) {
      return { error: 'code 插件必须提供 entry(单 JS 文件,如 main.js)' }
    }
  } else if (raw.type !== 'ui' && raw.type !== 'declarative') {
    return { error: `未知的插件类型: ${String(raw.type)}` }
  }
  // v3 元数据字段（V3-1：仅门禁校验；消费在后续阶段）
  if (raw.apiVersion !== undefined) {
    if (raw.apiVersion !== 1 && raw.apiVersion !== 2) return { error: 'apiVersion 仅支持 1 / 2（缺省 1）' }
  }
  if (raw.signing !== undefined) {
    const sigErr = validateSigningField(raw.signing)
    if (sigErr) return { error: `signing 字段非法: ${sigErr}` }
  }
  if (raw.vaultScope !== undefined) {
    const scopesRaw = raw.vaultScope
    if (!Array.isArray(scopesRaw) || scopesRaw.length === 0 || scopesRaw.length > 20) return { error: 'vaultScope 需为 1-20 个路径前缀的数组' }
    for (const p of scopesRaw) {
      if (typeof p !== 'string' || !/^[\w][\w\-. /]{0,200}$/.test(p) || p.includes('..')) return { error: `vaultScope 前缀非法: ${String(p)}（相对路径、不含 ..）` }
      if (p === '.' || p === '/') return { error: 'vaultScope 不能声明根目录（全库写需不声明该字段）' }
    }
  }
  if (raw.type === 'ui') {
    if (typeof raw.entry !== 'string' || !ENTRY_RE.test(raw.entry)) {
      return { error: 'UI 插件必须提供 entry(入口 HTML 文件名,如 index.html)' }
    }
  }
  if (raw.icon !== undefined) {
    if (typeof raw.icon !== 'string' || !ICON_RE.test(raw.icon)) return { error: 'icon 必须是包内图片文件名(svg/png/jpg/webp/gif)' }
  }
  if (raw.category !== undefined) {
    if (typeof raw.category !== 'string' || !raw.category.trim() || raw.category.length > 20) return { error: 'category 需为 1-20 字符的分类名' }
  }
  if (raw.riskLevel !== undefined) {
    if (typeof raw.riskLevel !== 'string' || !['S', 'A', 'B', 'C'].includes(raw.riskLevel)) return { error: 'riskLevel 仅允许 S / A / B / C' }
  }
  if (raw.capabilities !== undefined) {
    // code 与 ui 同属可执行插件，均可声明 capabilities（declarative 纯声明式不可）
    if (raw.type !== 'ui' && raw.type !== 'code') return { error: 'capabilities 仅可执行插件(type: ui / code)可声明' }
    if (!Array.isArray(raw.capabilities) || raw.capabilities.length > 10) return { error: 'capabilities 必须是数组(最多 10 项)' }
    for (const c of raw.capabilities) {
      if (typeof c !== 'string' || !KNOWN_CAPABILITIES.includes(c)) {
        return { error: `未声明的能力: ${String(c)}(当前支持: ${KNOWN_CAPABILITIES.join(' / ')})` }
      }
    }
  } else if (raw.type === 'ui') {
    // 旧版容忍模式(仅用于读取已安装的存量插件):按等价现状补默认授权
    if (!opts?.legacy) return { error: 'UI 插件必须声明 capabilities(可为空数组 = 零能力)' }
    raw.capabilities = ['theme', 'clipboard']
  }
  if (raw.vaultScope !== undefined) {
    // P2 kb.vault.*：写路径收敛前缀（plugin-api-v2-design §5.2 ADR-7）
    if (raw.type !== 'ui' && raw.type !== 'code') return { error: 'vaultScope 仅可执行插件(type: ui / code)可声明' }
    if (!Array.isArray(raw.vaultScope) || raw.vaultScope.length > 8) return { error: 'vaultScope 必须是数组(最多 8 项)' }
    for (const s of raw.vaultScope) {
      if (typeof s !== 'string' || !s.trim()) return { error: 'vaultScope 项需为非空字符串' }
      const norm = s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      if (!norm || norm.split('/').includes('..') || !/^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .\-/]*$/.test(norm)) {
        return { error: `vaultScope 项非法（需为仓库内相对目录前缀，禁止越界）: ${s}` }
      }
    }
  }
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 300)) return { error: 'description 过长' }
  if (raw.author !== undefined && (typeof raw.author !== 'string' || raw.author.length > 50)) return { error: 'author 过长' }
  if (raw.contributes !== undefined) {
    if (typeof raw.contributes !== 'object' || raw.contributes === null || Array.isArray(raw.contributes)) return { error: 'contributes 必须是对象' }
    for (const key of Object.keys(raw.contributes)) {
      if (!KNOWN_CONTRIBUTIONS.includes(key)) return { error: `不支持的贡献类型: ${key}` }
      if (key === 'tables') {
        if (raw.type !== 'ui') return { error: 'tables 贡献仅 UI 插件(type: ui)可声明' }
        const arr = (raw.contributes as Record<string, unknown>).tables
        if (!Array.isArray(arr) || arr.length === 0 || arr.length > 20) return { error: 'tables 需为 1-20 张表的数组' }
        const names = new Set<string>()
        for (const t of arr) {
          const v = validateTableDef(t)
          if (!v.ok) return { error: `tables: ${v.error}` }
          if (names.has(v.table.name)) return { error: `tables: 重复的表名 ${v.table.name}` }
          names.add(v.table.name)
        }
        if (!(Array.isArray(raw.capabilities) && raw.capabilities.includes('data'))) {
          return { error: '声明 tables 必须同时申请 data 能力' }
        }
      }
      if (key === 'views') {
        if (raw.type !== 'ui') return { error: 'views 贡献仅 UI 插件(type: ui)可声明' }
        const arr = (raw.contributes as Record<string, unknown>).views
        if (!Array.isArray(arr) || arr.length === 0 || arr.length > 10) return { error: 'views 需为 1-10 个视图的数组' }
        for (const v of arr as Record<string, unknown>[]) {
          if (!v || typeof v !== 'object') return { error: 'views: 视图条目非法' }
          if (typeof v.slot !== 'string' || !/^[a-z][a-z0-9.]{0,40}$/.test(v.slot)) return { error: 'views: slot 非法(如 knowledge.sidebar)' }
          if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 20) return { error: 'views: title 缺失或过长(≤20)' }
          if (v.mode !== undefined && !['fullscreen', 'panel'].includes(v.mode as string)) return { error: 'views: mode 仅支持 fullscreen / panel' }
        }
      }
      if (key === 'commands') {
        // plugin-phase1-design C3：三类插件均可声明；全局名 = <pluginId>.<id>，执行只触发已授权能力
        const arr = (raw.contributes as Record<string, unknown>).commands
        if (!Array.isArray(arr) || arr.length === 0 || arr.length > 32) return { error: 'commands 需为 1-32 个命令的数组' }
        const cids = new Set<string>()
        for (const c of arr as Record<string, unknown>[]) {
          if (!c || typeof c !== 'object') return { error: 'commands: 命令条目非法' }
          if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(c.id)) return { error: 'commands: id 非法（小写字母/数字/连字符开头，≤40）' }
          if (cids.has(c.id)) return { error: `commands: 重复的命令 id ${c.id}` }
          cids.add(c.id)
          if (typeof c.title !== 'string' || !c.title.trim() || c.title.length > 30) return { error: 'commands: title 缺失或过长(≤30)' }
          if (c.desc !== undefined && (typeof c.desc !== 'string' || c.desc.length > 80)) return { error: 'commands: desc 需为 ≤80 字符的字符串' }
        }
      }
      if (key === 'settings') {
        // plugin-phase1-design C5：声明式设置 schema（宿主自动渲染表单，值落 kb.store settings.*）
        const arr = (raw.contributes as Record<string, unknown>).settings
        if (!Array.isArray(arr) || arr.length === 0 || arr.length > 16) return { error: 'settings 需为 1-16 个设置项的数组' }
        const skeys = new Set<string>()
        for (const it of arr as Record<string, unknown>[]) {
          if (!it || typeof it !== 'object') return { error: 'settings: 设置条目非法' }
          if (typeof it.key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(it.key)) return { error: 'settings: key 非法（小写字母/数字/连字符，≤40）' }
          if (skeys.has(it.key)) return { error: `settings: 重复的 key ${it.key}` }
          skeys.add(it.key)
          if (typeof it.label !== 'string' || !it.label.trim() || it.label.length > 30) return { error: 'settings: label 缺失或过长(≤30)' }
          if (!['boolean', 'number', 'string', 'select'].includes(it.type as string)) return { error: 'settings: type 仅支持 boolean / number / string / select' }
          if (it.type === 'select' && (!Array.isArray(it.options) || it.options.length === 0 || it.options.length > 12)) return { error: 'settings: select 需为 1-12 个 options' }
          if (it.desc !== undefined && (typeof it.desc !== 'string' || it.desc.length > 80)) return { error: 'settings: desc 需为 ≤80 字符的字符串' }
        }
      }
      if (key === 'renderers') {
        // plugin-phase1-design C6：自定义 fenced-code 渲染器（type:ui 专属；内容只读沙箱，无 RPC 桥）
        if (raw.type !== 'ui') return { error: 'renderers 贡献仅 UI 插件(type: ui)可声明' }
        const arr = (raw.contributes as Record<string, unknown>).renderers
        if (!Array.isArray(arr) || arr.length === 0 || arr.length > 8) return { error: 'renderers 需为 1-8 个渲染器的数组' }
        const langs = new Set<string>()
        for (const r of arr as Record<string, unknown>[]) {
          if (!r || typeof r !== 'object') return { error: 'renderers: 渲染器条目非法' }
          if (typeof r.lang !== 'string' || !/^[a-z0-9-]{1,20}$/.test(r.lang)) return { error: 'renderers: lang 非法（小写字母/数字/连字符，≤20）' }
          if (r.lang === 'quiz' || r.lang === 'json' || r.lang === 'plan' || r.lang === 'ask') return { error: `renderers: lang ${r.lang} 为宿主保留围栏` }
          if (langs.has(r.lang)) return { error: `renderers: 重复的 lang ${r.lang}` }
          langs.add(r.lang)
          if (typeof r.entry !== 'string' || !r.entry.trim() || !/^(?!\/)[\w][\w./-]{0,80}\.html?$/i.test(r.entry)) return { error: 'renderers: entry 需为插件内 .html 相对路径' }
          if (r.height !== undefined && (typeof r.height !== 'number' || r.height < 40 || r.height > 2000)) return { error: 'renderers: height 需为 40-2000 的数值' }
          if (r.title !== undefined && (typeof r.title !== 'string' || !r.title.trim() || r.title.length > 20)) return { error: 'renderers: title 需为 ≤20 字符的字符串' }
        }
      }
      if (key === 'tools' && raw.type !== 'ui') return { error: 'tools 贡献仅 UI 插件(type: ui)可声明' }
      if (key === 'knowledgePages') {
        const kp = (raw.contributes as Record<string, unknown>).knowledgePages
        if (!kp || typeof kp !== 'object' || Array.isArray(kp)) return { error: 'knowledgePages 必须是对象' }
        const k = kp as Record<string, unknown>
        // v2(空间优先多笔记本):{ space, notebooks:[{ name, coverColor?, chapters[] }] }
        // v1(单笔记本):{ notebook, coverColor?, chapters[] }
        let chapterLists: unknown[][] = []
        if (Array.isArray(k.notebooks)) {
          if (k.notebooks.length === 0 || k.notebooks.length > 20) return { error: 'notebooks 需为 1-20 个笔记本' }
          for (const nb of k.notebooks) {
            if (!nb || typeof nb !== 'object') return { error: '笔记本条目非法' }
            const nbObj = nb as Record<string, unknown>
            if (typeof nbObj.name !== 'string' || !nbObj.name.trim() || nbObj.name.length > 50) return { error: '笔记本 name 缺失或过长' }
            if (nbObj.coverColor !== undefined && (typeof nbObj.coverColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(nbObj.coverColor))) return { error: 'coverColor 需为 #RRGGBB' }
            if (Array.isArray(nbObj.chapters)) chapterLists.push(nbObj.chapters)
          }
          if (k.space !== undefined && (typeof k.space !== 'string' || !k.space.trim() || k.space.length > 60)) return { error: 'space 缺失或过长(≤60 字符)' }
        } else {
          if (typeof k.notebook !== 'string' || !k.notebook.trim() || k.notebook.length > 50) return { error: 'knowledgePages.notebook 缺失或过长' }
          if (k.coverColor !== undefined && (typeof k.coverColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(k.coverColor))) return { error: 'coverColor 需为 #RRGGBB' }
          chapterLists = [k.chapters] as unknown[][]
        }
        let pageTotal = 0
        for (const chapters of chapterLists) {
          if (!Array.isArray(chapters) || chapters.length === 0 || chapters.length > 50) return { error: 'chapters 需为 1-50 个章节' }
          for (const ch of chapters as Record<string, unknown>[]) {
            if (!ch || typeof ch !== 'object') return { error: '章节条目非法' }
            if (typeof ch.name !== 'string' || !ch.name.trim() || ch.name.length > 50) return { error: '章节 name 缺失或过长' }
            if (!Array.isArray(ch.pages) || ch.pages.length === 0 || ch.pages.length > 500) return { error: `章节「${ch.name}」页面数需为 1-500` }
            for (const pg of ch.pages as Record<string, unknown>[]) {
              pageTotal++
              if (pageTotal > 1500) return { error: '页面总数超出限制(最大 1500),请拆包' }
              if (!pg || typeof pg !== 'object') return { error: '页面条目非法' }
              if (typeof pg.file !== 'string' || !/^[\w][\w\-./ ]{0,150}\.md$/i.test(pg.file) || String(pg.file).includes('..')) return { error: `页面 file 路径非法: ${String(pg.file)}` }
              if (typeof pg.title !== 'string' || !pg.title.trim() || pg.title.length > 100) return { error: '页面 title 缺失或过长' }
              if (typeof pg.externalId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(pg.externalId)) return { error: '页面 externalId 缺失或非法' }
              if (pg.tags !== undefined && (!Array.isArray(pg.tags) || pg.tags.length > 10 || pg.tags.some((t: unknown) => typeof t !== 'string' || String(t).length > 20))) return { error: '页面 tags 非法(最多 10 个、每个 20 字符)' }
            }
          }
        }
      }
      if (key === 'deleteFx') {
        // 删除动画皮肤：纯数据（SVG 龙头 + 颜色 + 时长），S 级内容贡献
        const fx = (raw.contributes as Record<string, unknown>).deleteFx
        if (!fx || typeof fx !== 'object' || Array.isArray(fx)) return { error: 'deleteFx 必须是对象' }
        const f = fx as Record<string, unknown>
        if (f.name !== undefined && (typeof f.name !== 'string' || !f.name.trim() || f.name.length > 40)) return { error: 'deleteFx.name 缺失或过长' }
        if (f.dragonSvg !== undefined) {
          if (typeof f.dragonSvg !== 'string' || f.dragonSvg.length > 16 * 1024) return { error: 'deleteFx.dragonSvg 需为 ≤16KB 的 SVG 片段' }
          if (/<script|<\/script|on\w+\s*=|javascript:/i.test(f.dragonSvg)) return { error: 'deleteFx.dragonSvg 含危险内容' }
        }
        if (f.particleColors !== undefined) {
          if (!Array.isArray(f.particleColors) || f.particleColors.length === 0 || f.particleColors.length > 12) return { error: 'deleteFx.particleColors 需为 1-12 个颜色' }
          if (f.particleColors.some((c: unknown) => typeof c !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(c))) return { error: 'deleteFx.particleColors 颜色格式非法' }
        }
        if (f.wipeColor !== undefined && (typeof f.wipeColor !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(f.wipeColor))) return { error: 'deleteFx.wipeColor 需为颜色值' }
        if (f.durationMs !== undefined && (typeof f.durationMs !== 'number' || f.durationMs < 300 || f.durationMs > 2000)) return { error: 'deleteFx.durationMs 需在 300-2000 之间' }
      }
      if (key === 'tools') {
        const tools = (raw.contributes as Record<string, unknown>).tools
        if (!Array.isArray(tools) || tools.length === 0 || tools.length > 10) return { error: 'tools 必须是非空数组(最多 10 个)' }
        for (const t of tools) {
          const tt = t as Record<string, unknown>
          if (!tt || typeof tt !== 'object') return { error: 'tools 条目非法' }
          if (typeof tt.id !== 'string' || !ID_RE.test(tt.id)) return { error: 'tools 条目 id 非法' }
          if (typeof tt.name !== 'string' || !tt.name.trim() || tt.name.length > 30) return { error: 'tools 条目 name 缺失或过长' }
        }
      }
      if (key === 'skills') {
        // AI 技能包：纯声明式提示词资产（分级上属 A 级数据贡献族，见 tiers 文档）
        const skills = (raw.contributes as Record<string, unknown>).skills
        if (!Array.isArray(skills) || skills.length === 0 || skills.length > 20) return { error: 'skills 必须是非空数组(最多 20 个)' }
        for (const s of skills) {
          const sk = s as Record<string, unknown>
          if (!sk || typeof sk !== 'object') return { error: 'skills 条目非法' }
          if (typeof sk.id !== 'string' || !ID_RE.test(sk.id)) return { error: 'skills 条目 id 非法' }
          if (typeof sk.title !== 'string' || !sk.title.trim() || sk.title.length > 60) return { error: 'skills 条目 title 缺失或过长' }
          if (typeof sk.prompt !== 'string' || !sk.prompt.trim()) return { error: 'skills 条目 prompt 缺失' }
          if (sk.prompt.length > 8000) return { error: 'skills 条目 prompt 过长(最大 8000 字符)' }
          if (sk.description !== undefined && (typeof sk.description !== 'string' || sk.description.length > 300)) return { error: 'skills 条目 description 过长' }
          if (sk.variables !== undefined) {
            if (!Array.isArray(sk.variables) || sk.variables.length > 10) return { error: 'skills variables 必须是数组(最多 10 个)' }
            for (const v of sk.variables) {
              if (typeof v !== 'string' || !SKILL_VAR_RE.test(v)) return { error: `skills 变量名非法: ${String(v)}` }
            }
          }
          if (sk.tools !== undefined) {
            if (!Array.isArray(sk.tools) || sk.tools.length > 10) return { error: 'skills tools 必须是数组(最多 10 个)' }
            for (const t of sk.tools) {
              if (typeof t !== 'string' || !SKILL_TOOL_REF_RE.test(t)) return { error: `skills 声明的工具名非法: ${String(t)}` }
            }
          }
        }
      }
    }
  } else if (raw.type === 'declarative') {
    return { error: '插件缺少 contributes(没有任何可提供的内容)' }
  }
  // 可执行插件（ui/code）可不带 contributes——能力经 entry 运行时执行，无需声明式贡献
  // 兼容性检查:engineVersion 形如 ">=2.7.0"
  if (raw.engineVersion !== undefined) {
    const match = /^>=(\d+\.\d+\.\d+)$/.exec(String(raw.engineVersion))
    if (!match) return { error: 'engineVersion 格式非法(需 ">=x.y.z")' }
    if (isNewerVersion(match[1], app.getVersion())) {
      return { error: `该插件需要应用版本 >= ${match[1]},请先更新应用` }
    }
  }
  return { manifest: raw as unknown as PluginManifest }
}

// ---------- 安全分级 ----------

/** 主进程强算等级(防骗标):ui+数据表/宿主API 能力→C;ui→B;code 可执行→B(能力强→C);含数据级贡献→A;仅内容级贡献→S */
function computeRiskLevel(m: PluginManifest): RiskLevel {
  if (m.type === 'ui' || m.type === 'code') {
    const caps = Array.isArray(m.capabilities) ? m.capabilities : []
    const keys = Object.keys(m.contributes || {})
    // 声明自有数据表并申请 data / knowledge / navigation 能力 = 模块级插件
    // vault:read = 读知识库元数据/检索（kb.metadata.*），只读但暴露全部笔记内容面 → 同 C 级
    // vault:write = 写仓库文件（kb.vault.*，可改用户笔记）→ C 级
    if (keys.includes('tables') || caps.includes('data') || caps.includes('knowledge') || caps.includes('navigation') || caps.includes('files') || caps.includes('vault:read') || caps.includes('vault:write')) return 'C'
    return 'B'
  }
  const keys = Object.keys(m.contributes || {})
  if (keys.some(k => DATA_LEVEL_KEYS.includes(k))) return 'A'
  return 'S'
}

const RANK = (l: RiskLevel) => LEVEL_RANK[l]

/** 最终等级 = max(自报值, 计算值),序 S < A < B */
export function effectiveRiskLevel(m: PluginManifest): RiskLevel {
  const computed = computeRiskLevel(m)
  if (m.riskLevel && LEVEL_RANK[m.riskLevel] > LEVEL_RANK[computed]) return m.riskLevel
  return computed
}

/** 策略开关:允许安装/启用的等级集合(settings.json → pluginAllowedLevels)
 *  C 级(模块插件:自有数据表 + 宿主 API + 视图挂载)默认不开放,需用户显式加入白名单 */
function getAllowedLevels(): Set<string> {
  try {
    const sp = join(app.getPath('userData'), 'settings.json')
    if (existsSync(sp)) {
      const s = JSON.parse(readFileSync(sp, 'utf-8'))
      const raw: string = typeof s.pluginAllowedLevels === 'string' ? s.pluginAllowedLevels : 'S,A,B,C'
      const allowed: string[] = ['S', 'A', 'B', 'C']
      const set = new Set(raw.split(',').map((x: string) => x.trim().toUpperCase()).filter((x: string) => allowed.includes(x)))
      if (set.size > 0) return set
    }
  } catch { /* ignore */ }
  // 默认白名单含 C：错题本彻底插件化（默认 plugin 模式）需要 C 级模块插件
  return new Set(['S', 'A', 'B', 'C'])
}

/** 行为审计（委托 pluginAudit 的 JSON 审计存储 userData/data/plugin-audit.json） */
export function auditWrite(pluginId: string, action: string, detail: unknown): void {
  appendAudit(pluginId, action, (detail ?? {}) as Record<string, unknown>)
}

function readManifestAt(pluginDir: string, legacy = false): { manifest: PluginManifest } | { error: string } {
  const manifestPath = join(pluginDir, 'plugin.json')
  if (!existsSync(manifestPath)) return { error: '插件目录缺少 plugin.json' }
  const buf = readFileSync(manifestPath)
  if (buf.length > MAX_MANIFEST_BYTES) return { error: 'plugin.json 过大' }
  let parsed: unknown
  try { parsed = JSON.parse(buf.toString('utf-8')) } catch { return { error: 'plugin.json 不是有效的 JSON' } }
  return validateManifest(parsed, { legacy })
}

// ---------- 注册表 ----------

let registryCache: { data: any; fetchedAt: number } | null = null
const REGISTRY_TTL = 10 * 60 * 1000

function isTrustedUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && TRUSTED_HOSTS.has(u.hostname)
  } catch { return false }
}

/** 带超时的 fetch(15 秒,防单点挂起拖垮整个回退链) */
async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  return net.fetch(url, { headers, signal: AbortSignal.timeout(15000) })
}

/** raw.githubusercontent URL → jsDelivr 镜像候选列表 */
function mirrorCandidates(url: string): string[] {
  const list: string[] = []
  const m = userGhMirror()
  if (m) list.push(`${m}/${url}`) // ghproxy 前缀协议,raw 与 release 资产均适用
  list.push(url)
  const r = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url)
  if (r) {
    const [, owner, repo, branch, path] = r
    list.push(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`)
    list.push(`https://fastly.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`)
  }
  return list
}

/**
 * 流式下载插件包:连接超时 20 秒、正文不限总时长(60 秒无数据看门狗防死挂),
 * 下载进度经 onChunk 上报 —— 大内容包不再被"整请求 15 秒超时"误杀。
 */
async function downloadZipStreaming(
  url: string,
  headers: Record<string, string>,
  onProgress: (received: number, total: number) => void
): Promise<Buffer> {
  const ctrl = new AbortController()
  // 连接阶段超时:响应头到达即解除(正文交给空闲看门狗);30s 宽容慢节点
  let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => ctrl.abort(), 30000)
  const res = await net.fetch(url, { headers, signal: ctrl.signal })
  try { if (connectTimer) { clearTimeout(connectTimer); connectTimer = null } } catch { /* ignore */ }
  if (!res.ok || !res.body) throw new Error(`${new URL(url).hostname} 返回 ${res.status}`)
  if (/text\/html/i.test(String(res.headers.get('content-type') || ''))) throw new Error(`${new URL(url).hostname} 返回网页而非文件`)

  const total = Number(res.headers.get('content-length') || 0)
  const chunks: Buffer[] = []
  let received = 0
  let lastEmit = Date.now()
  // 正文空闲看门狗:每次收到数据重置;60 秒无数据判定为死链
  let idleTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => ctrl.abort(), 60000)
  const touchIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    idleTimer = setTimeout(() => ctrl.abort(), 60000)
  }
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk)
      chunks.push(buf)
      received += buf.length
      touchIdle()
      // 进度节流:≥1% 或 ≥300ms 推一次;结束必推
      const now = Date.now()
      const pct = total > 0 ? (received / total) * 100 : -1
      if (now - lastEmit >= 300 || pct >= 100) {
        lastEmit = now
        onProgress(received, total)
      }
    }
  } finally {
    if (connectTimer) clearTimeout(connectTimer)
    if (idleTimer) clearTimeout(idleTimer)
  }
  onProgress(received, total)
  return Buffer.concat(chunks)
}

async function fetchRegistryRaw(): Promise<any> {
  let lastErr: unknown = null
  for (const url of REGISTRY_MIRRORS) {
    try {
      const res = await fetchWithTimeout(url, { Accept: 'application/vnd.github+json', 'User-Agent': 'Phrontis-App' })
      if (!res.ok) { lastErr = new Error(`${new URL(url).hostname} 返回 ${res.status}`); continue }
      const data = await res.json()
      if (!data || !Array.isArray(data.plugins)) throw new Error('registry.json 格式非法')
      return data
    } catch (e) { lastErr = e }
  }
  throw lastErr ?? new Error('所有插件仓库镜像均不可达,请检查网络后重试')
}

// ---------- 安装 ----------

function installFromBuffer(buf: Buffer, grantedCapabilities?: string[], opts?: { bypassLevelCheck?: boolean; marketSource?: boolean }): { success: true; manifest: PluginManifest; riskLevel: RiskLevel; isUpdate: boolean } | { success: false; message: string } {
  // 绝对上限(内容型插件放宽到 60MB,精确限额在 manifest 解析后判定)
  if (buf.length === 0 || buf.length > 60 * 1024 * 1024) {
    return { success: false, message: '插件包为空或超出 60MB 上限' }
  }
  let files: Map<string, Buffer>
  try { files = unzipBuffer(buf) } catch (e: any) { return { success: false, message: `插件包解压失败: ${e?.message || e}` } }

  // 定位 manifest:根目录或单层顶层目录(兼容系统压缩工具打包)
  let prefix = ''
  let manifestEntry: string | null = files.has('plugin.json') ? 'plugin.json' : null
  if (!manifestEntry) {
    for (const p of files.keys()) {
      if (/^[^/\\]+[/\\]plugin\.json$/.test(p)) { manifestEntry = p; prefix = p.slice(0, -'plugin.json'.length); break }
    }
  }
  if (!manifestEntry) return { success: false, message: '插件包根目录缺少 plugin.json' }

  const parsed = readManifestFromBuffer(files.get(manifestEntry)!)
  if ('error' in parsed) return { success: false, message: parsed.error }
  const manifest = parsed.manifest

  // V3-4 签名校验（ADR-9）：canonical = 剔除 signing 的稳定序列化 manifest + entry bytes；
  // 市场来源 + pluginRequireSignature 开启 → 无有效签名拒装；
  // 本地/内置示例不强制，但带 signing 时仍验证（防错配）。
  const entryBytes = manifest.entry ? (files.get(prefix + manifest.entry) ?? null) : null
  if (manifest.signing || (opts?.marketSource && pluginSettingReader('pluginRequireSignature') === true)) {
    const keyring = buildKeyring(pluginSettingReader('pluginTrustedKeys'))
    const sigErr = verifyPluginSignature(files.get(manifestEntry)!, entryBytes, manifest.signing, keyring)
    if (sigErr) {
      if (manifest.signing) return { success: false, message: `签名校验失败: ${sigErr}` }
      // 市场包未签名且开关开启
      return { success: false, message: `市场插件需要有效签名: ${sigErr}` }
    }
  }

  // 限额:内容型插件(knowledgePages)单独放宽(60MB / 1500 文件),其余沿用通用值
  const isKnowledgePack = Boolean(manifest.contributes?.knowledgePages)
  const maxBytes = isKnowledgePack ? 60 * 1024 * 1024 : MAX_PACKAGE_BYTES
  const maxFiles = isKnowledgePack ? 1500 : MAX_FILE_COUNT
  if (buf.length > maxBytes) {
    return { success: false, message: `插件包大小超出限制(最大 ${Math.round(maxBytes / 1048576)}MB)` }
  }

  // 安全分级:主进程强算 + 自报取高(防骗标)
  const riskLevel = effectiveRiskLevel(manifest)

  // 策略开关:不允许的等级直接拦截（内置官方示例(installBundledSample)可绕过——源可信）
  const allowed = getAllowedLevels()
  if (!opts?.bypassLevelCheck && !allowed.has(riskLevel)) {
    return { success: false, message: `策略限制:当前仅允许安装 ${[...allowed].sort().join(' / ')} 级插件,该插件为 ${riskLevel} 级` }
  }

  // UI 插件:入口 HTML 必须存在于包内;图标文件同理
  if (manifest.type === 'ui') {
    const entryKey = prefix + manifest.entry!
    if (!files.has(entryKey)) return { success: false, message: `UI 插件入口文件缺失: ${manifest.entry}` }
  }
  if (manifest.icon && !files.has(prefix + manifest.icon)) {
    return { success: false, message: `图标文件缺失: ${manifest.icon}` }
  }

  // id 即目录名(已通过正则校验,无路径成分)
  const pluginDir = join(getPluginsRoot(), manifest.id)
  const inside = safePathInside(getPluginsRoot(), manifest.id)
  if (!inside || resolve(inside) !== resolve(pluginDir)) return { success: false, message: '插件 id 非法' }

  const isUpdate = Boolean(readIndex()[manifest.id])

  // 逐条目落盘(防 Zip Slip + 数量/体积限制)
  let fileCount = 0
  for (const [entryPath, data] of files) {
    const normalized = entryPath.replace(/\\/g, '/')
    if (normalized.endsWith('/')) continue                       // 目录条目
    if (prefix && !normalized.startsWith(prefix)) continue        // 只取插件目录内的内容
    const rel = prefix ? normalized.slice(prefix.length) : normalized
    if (!rel) continue
    const dest = safePathInside(pluginDir, rel)
    if (!dest) return { success: false, message: `插件包含非法路径条目: ${rel}(已中止安装)` }
    if (data.length > maxBytes) return { success: false, message: '插件包含超大文件,已中止安装' }
    fileCount++
    if (fileCount > maxFiles) return { success: false, message: `插件文件数超出限制(最大 ${maxFiles})` }
    mkdirSync(resolve(dest, '..'), { recursive: true })
    writeFileSync(dest, data)
  }

  // 登记(保留原安装时间;UI 插件持久化用户授权的能力)
  const idx = readIndex()
  const granted = manifest.type === 'ui'
    ? (grantedCapabilities ?? []).filter(c => (manifest.capabilities || []).includes(c))
    : undefined
  idx[manifest.id] = {
    id: manifest.id,
    version: manifest.version,
    enabled: true,
    installedAt: idx[manifest.id]?.installedAt || new Date().toISOString(),
    riskLevel,
    ...(manifest.type === 'ui' ? { grantedCapabilities: granted, grantedAt: new Date().toISOString() } : {}),
  }
  writeIndex(idx)
  // C 级模块插件:建插件自有数据表(幂等,失败不阻断安装)
  const declaredTables = (manifest.contributes?.tables ?? []) as PluginTableDef[]
  if (declaredTables.length > 0) {
    try { ensurePluginTables(manifest.id, declaredTables) } catch { /* ignore */ }
  }
  auditWrite(manifest.id, isUpdate ? 'update' : 'install', { version: manifest.version, riskLevel, granted: granted ?? null })
  console.log(`[Plugins] Installed plugin ${manifest.id}@${manifest.version} (risk ${riskLevel})`)
  notifyPluginsChanged()
  return { success: true, manifest, riskLevel, isUpdate }
}

function readManifestFromBuffer(buf: Buffer): { manifest: PluginManifest } | { error: string } {
  if (buf.length > MAX_MANIFEST_BYTES) return { error: 'plugin.json 过大' }
  try {
    return validateManifest(JSON.parse(buf.toString('utf-8')))
  } catch { return { error: 'plugin.json 不是有效的 JSON' } }
}

// ---------- 变更通知（供 Skill 等消费方同步派生状态） ----------

const changeSubscribers: Array<() => void> = []

/** 订阅插件集合/启用状态变化（安装、卸载、启停、内置落位后触发） */
export function onPluginsChanged(cb: () => void): void {
  changeSubscribers.push(cb)
}

function notifyPluginsChanged(): void {
  for (const cb of changeSubscribers) {
    try { cb() } catch (err) { console.error('[Plugins] Change subscriber callback failed:', err) }
  }
  // V3-2d：通知所有渲染窗口（插件页/后台 code 宿主容器刷新）
  try {
    broadcast(BROADCAST_CHANNEL.pluginInstalledChanged)
  } catch { /* 窗口已销毁等忽略 */ }
}

// ---------- IPC ----------

/**
 * 已退役的插件 id —— 曾以 C 级模块插件形态存在，后改为内置模块（宿主接管其数据域）。
 *
 * 为什么需要「摘牌」这一步：旧版本升级上来的用户 `installed.json` 里仍留着这些注册项，
 * 而插件的 `contributes.views`（如 `knowledge.sidebar`）在卸载前始终生效 → 知识库侧栏
 * 会多出一个点开即坏的死入口（如「错题本(插件版)」），与内置的同名入口重复。
 *
 * 处置口径（2026-09-12）：**只摘掉注册项，不动磁盘目录、不删数据桶**。
 * - 目录留着可追溯、可手动再装（不触发沙箱 safe-delete 拦截）
 * - 数据桶（plugin_knowbase_quizbook_*）已确认在各 profile 下均为空文件不存在，
 *   且「数据」面板已改接 vault 真实错题数据（quizDataAdmin.ts），桶不再有出口，
 *   保留仅为可追溯；需要清理时走插件卸载流程（plugin:uninstall，含导出备份）
 */
export const RETIRED_PLUGIN_IDS: readonly string[] = ['knowbase.quizbook']

/** 启动时摘除退役插件的注册项（幂等；无命中则不写盘） */
function retirePlugins(): void {
  const idx = readIndex()
  let changed = false
  for (const id of RETIRED_PLUGIN_IDS) {
    const entry = idx[id]
    if (!entry) continue
    auditWrite(id, 'retire', {
      version: entry.version,
      reason: '插件形态已退役，改为内置模块（知识库侧栏入口与数据均由宿主接管）',
    })
    delete idx[id]
    changed = true
    console.log(`[Plugins] 已摘除退役插件的注册项: ${id}（插件目录与数据桶保留，未删除）`)
  }
  if (changed) {
    writeIndex(idx)
    notifyPluginsChanged()
  }
}

export function registerPluginHandlers(deps?: { getSettingValue?: (key: string) => unknown }): void {
  if (deps?.getSettingValue) pluginSettingReader = deps.getSettingValue
  // 退役插件清理：必须在注册 IPC 之前跑，避免插件页/知识库侧栏先拿到旧快照
  retirePlugins()
  ipcMain.handle('plugin:fetchRegistry', async () => {
    try {
      const now = Date.now()
      if (registryCache && now - registryCache.fetchedAt < REGISTRY_TTL) {
        return { ok: true, plugins: registryCache.data.plugins, updatedAt: registryCache.data.updatedAt ?? '' }
      }
      const data = await fetchRegistryRaw()
      // 策略开关:过滤掉不允许的等级(条目未标 riskLevel 视为 S)
      const allowed = getAllowedLevels()
      const plugins = (data.plugins as any[]).filter(p => !p.riskLevel || allowed.has(String(p.riskLevel).toUpperCase()))
      registryCache = { data: { ...data, plugins }, fetchedAt: now }
      return { ok: true, plugins, updatedAt: data.updatedAt ?? '' }
    } catch (e: any) {
      return { ok: false, plugins: [], message: e?.message || String(e) }
    }
  })

  ipcMain.handle('plugin:install', async (_e, url: string, grantedCapabilities?: unknown) => {
    try {
      if (typeof url !== 'string' || !isTrustedUrl(url)) return { success: false, message: '下载地址不受信任(仅允许 GitHub)' }
      const push = (received: number, total: number, host = '') => {
        const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : -1
        broadcast(BROADCAST_CHANNEL.pluginDownloadProgress, { key: url, received, total, percent: pct, host })
      }
      push(0, 0)
      // 大包友好:流式下载(连接 30s/空闲 60s 看门狗),镜像候选含 ghproxy 前缀节点;
      // 区域性瞬时拦截常表现为全候选连续 404/RESET → 整轮退避重试(间隔 2s/6s)
      let buf: Buffer | null = null
      const diag: string[] = []
      let usedHost = ''
      outer:
      for (let round = 0; round < 3 && !buf; round++) {
        if (round > 0) await new Promise(r => setTimeout(r, round === 1 ? 2000 : 6000))
        for (const u of mirrorCandidates(url)) {
          try {
            buf = await downloadZipStreaming(u, { 'User-Agent': 'Phrontis-App' }, (r, t) => {
              try { push(r, t, new URL(u).hostname) } catch { /* ignore */ }
            })
            usedHost = new URL(u).hostname
            break outer
          } catch (e) {
            const msg = `${new URL(u).hostname}: ${String((e as { message?: string } | null)?.message || e).slice(0, 60)}`
            if (!diag.includes(msg)) diag.push(msg)
            push(0, 0, usedHost) /* 切换下一候选,进度归零 */
          }
        }
      }
      if (!buf) throw new Error(`所有下载源均失败(已重试 3 轮) —— ${diag.join('; ')}`)
      push(buf.length, buf.length, usedHost)
      const grants = Array.isArray(grantedCapabilities) ? grantedCapabilities.filter((c): c is string => typeof c === 'string') : undefined
      return installFromBuffer(buf, grants, { marketSource: true })
    } catch (e: any) {
      return { success: false, message: `安装失败: ${e?.message || e}` }
    }
  })

  ipcMain.handle('plugin:installFromFile', async (_e, grantedCapabilities?: unknown) => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!win) return { success: false, message: '无可用的应用窗口' }
      const result = await dialog.showOpenDialog(win, {
        title: '安装插件(选择插件 zip 包)',
        filters: [{ name: '插件包 (ZIP)', extensions: ['zip'] }],
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return { success: false, message: '已取消' }
      const grants = Array.isArray(grantedCapabilities) ? grantedCapabilities.filter((c): c is string => typeof c === 'string') : undefined
      return installFromBuffer(readFileSync(result.filePaths[0]), grants)
    } catch (e: any) {
      return { success: false, message: `安装失败: ${e?.message || e}` }
    }
  })

  /**
   * 一键安装内置示例插件（开发期从工作区 samples/ 读，prod 后续用 extraResources 预置）。
   * 引导卡直接调它——避免用户去磁盘找 zip。
   * 安全：filename 严格校验（只允许 [a-z0-9._-] + .zip），限定在 samples 目录内。
   */
  ipcMain.handle('plugin:installBundledSample', (_e, filename: string, grantedCapabilities?: unknown) => {
    try {
      if (typeof filename !== 'string' || !/^[\w][\w.-]{0,80}\.zip$/i.test(filename) || filename.includes('..')) {
        return { success: false, message: '文件名非法' }
      }
      const samplePath = join(app.getAppPath(), 'samples', filename)
      if (!existsSync(samplePath)) return { success: false, message: `内置示例不存在: ${filename}(开发版从工作区 samples 读取)` }
      const grants = Array.isArray(grantedCapabilities) ? grantedCapabilities.filter((c): c is string => typeof c === 'string') : undefined
      return installFromBuffer(readFileSync(samplePath), grants, { bypassLevelCheck: true })
    } catch (e: any) {
      return { success: false, message: `安装失败: ${e?.message || e}` }
    }
  })

  ipcMain.handle('plugin:listDeleteFxSkins', (): DeleteFxSkin[] => {
    // 删除动画皮肤聚合：所有已启用且声明 deleteFx 的插件
    const idx = readIndex()
    const out: DeleteFxSkin[] = []
    for (const [id, entry] of Object.entries(idx)) {
      if (!entry.enabled) continue
      const dir = safePathInside(getPluginsRoot(), id)
      if (!dir || !existsSync(dir)) continue
      const parsed = readManifestAt(dir)
      if ('error' in parsed) continue
      const fx = (parsed.manifest.contributes as Record<string, unknown> | undefined)?.deleteFx as Record<string, unknown> | undefined
      if (!fx || typeof fx !== 'object') continue
      out.push({
        pluginId: id,
        id: typeof fx.id === 'string' && fx.id.trim() ? fx.id : id,
        name: typeof fx.name === 'string' && fx.name.trim() ? fx.name : parsed.manifest.name,
        dragonSvg: typeof fx.dragonSvg === 'string' ? fx.dragonSvg : undefined,
        particleColors: Array.isArray(fx.particleColors) ? fx.particleColors.filter((c: unknown): c is string => typeof c === 'string') : undefined,
        wipeColor: typeof fx.wipeColor === 'string' ? fx.wipeColor : undefined,
        durationMs: typeof fx.durationMs === 'number' ? fx.durationMs : undefined,
      })
    }
    return out
  })

  ipcMain.handle('plugin:getContribution', (_e, id: string, key: string) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, message: '插件 id 非法' }
    if (typeof key !== 'string' || !KNOWN_CONTRIBUTIONS.includes(key)) return { ok: false, message: '贡献类型非法' }
    const dir = safePathInside(getPluginsRoot(), id)
    if (!dir || !existsSync(dir)) return { ok: false, message: '插件未安装' }
    const idx = readIndex()
    if (!idx[id]?.enabled) return { ok: false, message: '插件已禁用,请先启用' }
    const parsed = readManifestAt(dir)
    if ('error' in parsed) return { ok: false, message: parsed.error }
    const data = (parsed.manifest.contributes as Record<string, unknown> | undefined)?.[key]
    if (data === undefined) return { ok: false, message: '该插件未包含此内容' }
    if (JSON.stringify(data).length > 1024 * 1024) return { ok: false, message: '贡献内容过大' }
    return { ok: true, data }
  })

  /** 列出所有已启用插件声明的视图挂载点(可按 slot 过滤,如 knowledge.sidebar) */
  ipcMain.handle('plugin:listViews', (_e, slot?: string) => {
    const idx = readIndex()
    const views: Array<{ pluginId: string; name: string; entry: string; slot: string; title: string; mode: string; icon?: string; granted: string[] }> = []
    for (const [id, entry] of Object.entries(idx)) {
      if (!entry.enabled) continue
      const dir = safePathInside(getPluginsRoot(), id)
      if (!dir || !existsSync(dir)) continue
      try {
        const parsed = readManifestAt(dir)
        if ('error' in parsed) continue
        const m = parsed.manifest
        if (m.type !== 'ui' || !m.entry) continue
        const vs = (m.contributes?.views ?? []) as Array<Record<string, unknown>>
        for (const v of vs) {
          if (typeof v?.slot !== 'string') continue
          if (slot && v.slot !== slot) continue
          views.push({
            pluginId: id,
            name: m.name,
            entry: m.entry,
            slot: String(v.slot),
            title: String(v.title || m.name),
            mode: (v.mode as string) || 'fullscreen',
            ...(m.icon ? { icon: `plugin://${id}/${m.icon}` } : {}),
            granted: entry.grantedCapabilities || [],
          })
        }
      } catch { /* 单个插件读取失败不影响其他插件 */ }
    }
    return views
  })

  /** 列出所有已启用插件声明的命令（plugin-phase1-design C3）：附首个 view 槽位供宿主导航激活 */
  ipcMain.handle('plugin:listCommands', () => {
    const idx = readIndex()
    const out: Array<{ pluginId: string; name: string; id: string; title: string; desc?: string; viewSlot?: string; type: string }> = []
    for (const [id, entry] of Object.entries(idx)) {
      if (!entry.enabled) continue
      const dir = safePathInside(getPluginsRoot(), id)
      if (!dir || !existsSync(dir)) continue
      try {
        const parsed = readManifestAt(dir)
        if ('error' in parsed) continue
        const m = parsed.manifest
        const cs = (m.contributes?.commands ?? []) as Array<Record<string, unknown>>
        const firstView = ((m.contributes?.views ?? []) as Array<Record<string, unknown>>)[0]
        for (const c of cs) {
          if (typeof c?.id !== 'string') continue
          out.push({
            pluginId: id,
            name: m.name,
            id: c.id,
            title: String(c.title || c.id),
            ...(typeof c.desc === 'string' && c.desc ? { desc: c.desc.slice(0, 80) } : {}),
            ...(m.type === 'ui' && typeof firstView?.slot === 'string' ? { viewSlot: firstView.slot } : {}),
            type: m.type,
          })
        }
      } catch { /* 单个插件读取失败不影响其他插件 */ }
    }
    return out
  })

  /** 声明式设置（plugin-phase1-design C5）：schema / 当前值 / 写值（值落 kb.store settings.*） */
  ipcMain.handle('plugin:getSettingsSchema', (_e, id: string) => {
    const dir = safePathInside(getPluginsRoot(), String(id ?? ''))
    if (!dir || !existsSync(dir)) return { schema: [] }
    try {
      const parsed = readManifestAt(dir)
      if ('error' in parsed) return { schema: [] }
      return { schema: (parsed.manifest.contributes?.settings ?? []) as unknown[] }
    } catch { return { schema: [] } }
  })

  ipcMain.handle('plugin:getSettingValues', (_e, id: string) => {
    const dir = safePathInside(getPluginsRoot(), String(id ?? ''))
    const values: Record<string, unknown> = {}
    if (!dir || !existsSync(dir)) return { values }
    try {
      const parsed = readManifestAt(dir)
      if ('error' in parsed) return { values }
      const schema = (parsed.manifest.contributes?.settings ?? []) as Array<Record<string, unknown>>
      for (const it of schema) {
        if (typeof it.key !== 'string') continue
        const r = pluginStoreGet(String(id), `settings.${it.key}`)
        values[it.key] = r.ok && r.value !== undefined ? r.value : it.default
      }
      return { values }
    } catch { return { values } }
  })

  ipcMain.handle('plugin:setSettingValue', (_e, id: string, key: string, value: unknown) => {
    const dir = safePathInside(getPluginsRoot(), String(id ?? ''))
    if (!dir || !existsSync(dir)) return { ok: false, error: '插件不存在' }
    try {
      const parsed = readManifestAt(dir)
      if ('error' in parsed) return { ok: false, error: '清单读取失败' }
      const schema = (parsed.manifest.contributes?.settings ?? []) as Array<Record<string, unknown>>
      const it = schema.find(s => s.key === String(key ?? ''))
      if (!it) return { ok: false, error: '未知设置项' }
      // 类型白名单校验（select 额外校验取值在 options 内）
      const type = it.type as string
      const valid = type === 'boolean' ? typeof value === 'boolean'
        : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : type === 'string' ? typeof value === 'string' && value.length <= 200
        : Array.isArray(it.options) && (it.options as unknown[]).some(o => String((o as Record<string, unknown>)?.value ?? o) === String(value))
      if (!valid) return { ok: false, error: '取值类型不符合 schema' }
      const r = pluginStoreSet(String(id), `settings.${String(key)}`, value)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) }
    }
  })

  /** 列出已启用 ui 插件声明的 fenced-code 渲染器（plugin-phase1-design C6） */
  ipcMain.handle('plugin:listRenderers', () => {
    const idx = readIndex()
    const out: Array<{ pluginId: string; name: string; lang: string; entry: string; height?: number; title?: string }> = []
    for (const [id, entry] of Object.entries(idx)) {
      if (!entry.enabled) continue
      const dir = safePathInside(getPluginsRoot(), id)
      if (!dir || !existsSync(dir)) continue
      try {
        const parsed = readManifestAt(dir)
        if ('error' in parsed) continue
        const m = parsed.manifest
        if (m.type !== 'ui') continue
        const rs = (m.contributes?.renderers ?? []) as Array<Record<string, unknown>>
        for (const r of rs) {
          if (typeof r?.lang !== 'string' || typeof r?.entry !== 'string') continue
          out.push({
            pluginId: id,
            name: m.name,
            lang: r.lang,
            entry: r.entry,
            ...(typeof r.height === 'number' ? { height: r.height } : {}),
            ...(typeof r.title === 'string' && r.title ? { title: r.title } : {}),
          })
        }
      } catch { /* 单个插件读取失败不影响其他插件 */ }
    }
    return out
  })

  ipcMain.handle('plugin:listInstalled', (): PluginSummary[] => {
    const idx = readIndex()
    const out: PluginSummary[] = []
    for (const [id, entry] of Object.entries(idx)) {
      const pluginDir = join(getPluginsRoot(), id)
      // 存量已装插件走 legacy 容忍(旧清单无 capabilities 等新字段)
      const parsed = existsSync(pluginDir) ? readManifestAt(pluginDir, true) : { error: '插件目录不存在' }
      if ('error' in parsed) {
        out.push({ id, name: id, version: entry.version, type: 'declarative', enabled: false, installedAt: entry.installedAt, riskLevel: entry.riskLevel || 'S', capabilities: [], grantedCapabilities: [], contributions: [], broken: true, builtin: entry.builtin })
        continue
      }
      const m = parsed.manifest
      const level = entry.riskLevel && LEVEL_RANK[entry.riskLevel] >= LEVEL_RANK[effectiveRiskLevel(m)] ? entry.riskLevel : effectiveRiskLevel(m)
      const legacyGrant = m.type === 'ui' && !entry.grantedCapabilities
      out.push({
        id: m.id, name: m.name, version: m.version, engineVersion: m.engineVersion,
        author: m.author, description: m.description, type: m.type, entry: m.entry,
        icon: pluginIconUrl(m.id, m.icon) || undefined,
        category: m.category,
        riskLevel: level,
        capabilities: m.capabilities || [],
        grantedCapabilities: m.type === 'ui' ? (entry.grantedCapabilities || m.capabilities || []) : [],
        legacyGrant: legacyGrant || undefined,
        enabled: entry.enabled, installedAt: entry.installedAt, builtin: entry.builtin,
        contributions: m.contributes ? Object.keys(m.contributes) : [],
      })
    }
    return out
  })

  // 授权变更(B 级能力勾选/撤销)
  ipcMain.handle('plugin:setGranted', (_e, id: string, caps: unknown) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { success: false, message: '插件 id 非法' }
    if (!Array.isArray(caps)) return { success: false, message: '参数非法' }
    const idx = readIndex()
    if (!idx[id]) return { success: false, message: '插件未安装' }
    const pluginDir = join(getPluginsRoot(), id)
    const parsed = existsSync(pluginDir) ? readManifestAt(pluginDir, true) : { error: 'x' as const }
    if ('error' in parsed) return { success: false, message: '插件数据损坏' }
    const declared = parsed.manifest.capabilities || []
    const granted = caps.filter((c): c is string => typeof c === 'string' && declared.includes(c))
    idx[id].grantedCapabilities = granted
    idx[id].grantedAt = new Date().toISOString()
    writeIndex(idx)
    auditWrite(id, 'grant', { granted })
    return { success: true }
  })

  // 行为审计:列表 / 清空 / 渲染层写入(A 级导入、B 级拒绝等)
  ipcMain.handle('plugin:auditList', (_e, id: string | undefined) => {
    return readAuditRaw(id, 20).map(r => ({ id: r.id, pluginId: r.plugin_id, action: r.action, detail: r.detail, createdAt: r.created_at }))
  })

  ipcMain.handle('plugin:auditClear', (_e, id: string | undefined) => {
    clearAudit(id)
    return { success: true }
  })

  /** C 级白名单：读取/写入 pluginAllowedLevels（settings.json），UI 里可勾选 C 级 */
  ipcMain.handle('plugin:getAllowedLevels', () => Array.from(getAllowedLevels()).sort())
  ipcMain.handle('plugin:setAllowedLevels', (_e, levels: unknown) => {
    const arr = Array.isArray(levels)
      ? levels.map(x => String(x).trim().toUpperCase()).filter((x): x is string => ['S', 'A', 'B', 'C'].includes(x))
      : []
    const sp = join(app.getPath('userData'), 'settings.json')
    try {
      const cur = existsSync(sp) ? JSON.parse(readFileSync(sp, 'utf-8')) : {}
      cur.pluginAllowedLevels = arr.join(',')
      writeFileSync(sp, JSON.stringify(cur, null, 2), 'utf-8')
      return { success: true }
    } catch (e: unknown) {
      return { success: false, message: String((e as Error)?.message || e) }
    }
  })

  ipcMain.handle('plugin:auditWrite', (_e, id: string, action: string, detail: unknown) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { success: false }
    if (typeof action !== 'string' || !['import', 'deny', 'run', 'grant'].includes(action)) return { success: false }
    auditWrite(id, action, detail)
    return { success: true }
  })

  ipcMain.handle('plugin:setEnabled', (_e, id: string, enabled: boolean) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { success: false, message: '插件 id 非法' }
    const idx = readIndex()
    if (!idx[id]) return { success: false, message: '插件未安装' }
    idx[id].enabled = Boolean(enabled)
    writeIndex(idx)
    // 启用时补齐插件自有数据表(C 级 data 能力),避免禁用期表被清后无法恢复
    if (enabled) {
      try {
        const dir = safePathInside(getPluginsRoot(), id)
        if (dir) {
          const m = readManifestAt(dir)
          if (m && 'manifest' in m) {
            const tables = (m.manifest.contributes?.tables ?? []) as PluginTableDef[]
            if (tables.length > 0) ensurePluginTables(id, tables)
          }
        }
      } catch { /* ignore */ }
    }
    notifyPluginsChanged()
    return { success: true }
  })

  ipcMain.handle('plugin:uninstall', (_e, id: string, dropData?: boolean) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { success: false, message: '插件 id 非法' }
    const idx = readIndex()
    if (!idx[id]) return { success: false, message: '插件未安装' }
    if (idx[id].builtin) return { success: false, message: '内置插件不可卸载,可改为禁用' }
    const dir = safePathInside(getPluginsRoot(), id)
    if (!dir) return { success: false, message: '插件 id 非法' }
    // C 级插件:卸载前导出自有表数据(供渲染层提示用户保存),再按需删表
    let dump: Array<{ table: string; rows: unknown[] }> | undefined
    try {
      const m = readManifestAt(dir)
      if (m && 'manifest' in m) {
        const tables = (m.manifest.contributes?.tables ?? []) as PluginTableDef[]
        if (tables.length > 0) {
          dump = tables.map(t => ({ table: t.name, rows: pluginDumpTable(id, tables, t.name) }))
          if (dropData !== false) dropPluginTables(id, tables)
        }
      }
    } catch { /* ignore */ }
    try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }) } catch (e: any) {
      return { success: false, message: `删除插件目录失败: ${e?.message || e}` }
    }
    auditWrite(id, 'uninstall', { version: idx[id].version, droppedTables: dropData !== false })
    delete idx[id]
    writeIndex(idx)
    notifyPluginsChanged()
    return { success: true, dump }
  })

  // ---------- C 级模块插件:自有数据表读写(结构化 CRUD,禁止任意 SQL) ----------

  /** 校验插件已安装启用且已授权 data 能力,返回其声明的表定义 */
  function assertDataAccess(pluginId: string): { ok: true; tables: PluginTableDef[] } | { ok: false; error: string } {
    if (typeof pluginId !== 'string' || !ID_RE.test(pluginId)) return { ok: false, error: '插件 id 非法' }
    const idx = readIndex()
    const entry = idx[pluginId]
    if (!entry) return { ok: false, error: '插件未安装' }
    if (!entry.enabled) return { ok: false, error: '插件已禁用' }
    const dir = safePathInside(getPluginsRoot(), pluginId)
    if (!dir) return { ok: false, error: '插件 id 非法' }
    let m: { manifest: PluginManifest } | { error: string }
    try { m = readManifestAt(dir) } catch { return { ok: false, error: '读取插件清单失败' } }
    if (!m || 'error' in m) return { ok: false, error: '读取插件清单失败' }
    if (!(m.manifest.capabilities || []).includes('data')) return { ok: false, error: '插件未声明 data 能力' }
    if (!(entry.grantedCapabilities || []).includes('data')) return { ok: false, error: 'data 能力未授权' }
    const tables = (m.manifest.contributes?.tables ?? []) as PluginTableDef[]
    if (tables.length === 0) return { ok: false, error: '插件未声明数据表' }
    return { ok: true, tables }
  }

  ipcMain.handle('pluginData:query', (_e, pluginId: string, table: string, opts?: { where?: WhereCond[]; orderBy?: string; desc?: boolean; limit?: number }) => {
    const acc = assertDataAccess(pluginId)
    if (!acc.ok) return []
    return pluginQuery(pluginId, acc.tables, table, opts)
  })

  ipcMain.handle('pluginData:insert', (_e, pluginId: string, table: string, row: Record<string, unknown>) => {
    const acc = assertDataAccess(pluginId)
    if (!acc.ok) return { ok: false, error: acc.error }
    return pluginInsert(pluginId, acc.tables, table, row)
  })

  ipcMain.handle('pluginData:update', (_e, pluginId: string, table: string, rowId: string | number, patch: Record<string, unknown>) => {
    const acc = assertDataAccess(pluginId)
    if (!acc.ok) return { ok: false, error: acc.error }
    return pluginUpdate(pluginId, acc.tables, table, rowId, patch)
  })

  ipcMain.handle('pluginData:delete', (_e, pluginId: string, table: string, rowId: string | number) => {
    const acc = assertDataAccess(pluginId)
    if (!acc.ok) return { ok: false, error: acc.error }
    return pluginDelete(pluginId, acc.tables, table, rowId)
  })

  // 内容型插件(knowledgePages):导入状态与执行
  ipcMain.handle('knowledgePack:getImportState', (_e, pluginId: string) => {
    // 禁用即停:禁用态下导入状态锁定为 disabled,更新通道一并关闭
    const idx = readIndex()
    if (idx[pluginId] && !idx[pluginId].enabled) {
      return { ok: true, state: 'disabled', message: '插件已禁用,请先在插件页启用' }
    }
    // 知识库恒 vault（R6 D9 后 sqlite 读源已退役）
    return getPackState(pluginId, true)
  })
  ipcMain.handle('knowledgePack:importPack', (_e, pluginId: string, overwriteModified: boolean, forceExternalIds?: unknown) => {
    const idx = readIndex()
    if (idx[pluginId] && !idx[pluginId].enabled) {
      return { ok: false, message: '插件已禁用,请先启用后再导入' }
    }
    return importPack(pluginId, Boolean(overwriteModified), Array.isArray(forceExternalIds) ? forceExternalIds.map(String) : undefined, true)
  })

  // 内置插件落位:随应用分发的官方插件,首次运行(或目录缺失)时复制到插件目录
  try {
    // 打包版在 resources 下;开发版从应用路径探测——直接以 js 文件启动时 getAppPath() 可能指向
    // out/main,需向工程根回溯,否则内置插件永远找不到(存量缺陷)
    const builtinCandidates = app.isPackaged
      ? [join(process.resourcesPath, 'builtin-plugins')]
      : [
          join(app.getAppPath(), 'resources', 'builtin-plugins'),
          resolve(app.getAppPath(), '../..', 'resources', 'builtin-plugins'),
          join(process.cwd(), 'resources', 'builtin-plugins'),
        ]
    const builtinDir = builtinCandidates.find(p => existsSync(p))
    if (builtinDir) {
      const idx = readIndex()
      const builtinIds = new Set<string>()
      let changed = false
      for (const ent of readdirSync(builtinDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue
        const mfPath = join(builtinDir, ent.name, 'plugin.json')
        if (!existsSync(mfPath)) continue
        const parsed = readManifestFromBuffer(readFileSync(mfPath))
        if ('error' in parsed) { console.warn(`[Plugins] Invalid builtin plugin manifest (${ent.name}):`, parsed.error); continue }
        const id = parsed.manifest.id
        builtinIds.add(id)
        if (idx[id]?.userRemoved) continue          // 用户明确卸载过,不再自动恢复
        const dest = join(getPluginsRoot(), id)
        // 未安装 → 复制;已安装但内置版本更新 → 覆盖升级(内置插件随应用发版更新)
        const needInstall = !existsSync(dest) || (idx[id] && isNewerVersion(parsed.manifest.version, idx[id].version))
        if (!needInstall) continue
        cpSync(join(builtinDir, ent.name), dest, { recursive: true, force: true })
        const level = effectiveRiskLevel(parsed.manifest)
        idx[id] = {
          id, version: parsed.manifest.version,
          enabled: idx[id]?.enabled ?? true,
          installedAt: idx[id]?.installedAt || new Date().toISOString(),
          builtin: true, riskLevel: level,
          // 内置 UI 插件:官方出品,按清单全量预授权
          ...(parsed.manifest.type === 'ui' ? { grantedCapabilities: parsed.manifest.capabilities || [], grantedAt: new Date().toISOString() } : {}),
        }
        changed = true
        console.log(`[Plugins] Builtin plugin in place: ${id}@${parsed.manifest.version}${existsSync(dest) ? ' (upgraded)' : ''}`)
      }
      // 存量清理:已不再随应用分发的内置插件,降级为普通插件(解锁卸载,如强密码生成器转市场)
      for (const [id, entry] of Object.entries(idx)) {
        if (entry.builtin && !builtinIds.has(id)) {
          idx[id] = { ...entry, builtin: false }
          changed = true
          console.log(`[Plugins] Builtin plugin converted to normal (uninstallable): ${id}`)
        }
      }
      if (changed) writeIndex(idx)
      if (changed) notifyPluginsChanged()
    }
  } catch (err) {
    console.error('[Plugins] Failed to place builtin plugin:', err)
  }

  // ========== v2 协议：Plugin Host Gateway（V3-2，裁决点单一化到主进程）==========
  // 渲染层 PluginFrame 不再做 grantedRef.includes 判断；一切 v2 请求经 host:rpc 在此裁决。
  // 复用函数内已定义的 assertDataAccess / readIndex / readManifestAt（同一作用域）。
  const gateway = createGateway({
    sessionState(pluginId: string): { enabled: boolean; capabilities: string[]; vaultScope?: string[] } | null {
      if (typeof pluginId !== 'string' || !ID_RE.test(pluginId)) return null
      const idx = readIndex()
      const entry = idx[pluginId]
      if (!entry) return null
      // vaultScope 存 manifest（写路径收敛前缀）；读取失败按「未声明=全库可写」回退
      let vaultScope: string[] | undefined
      try {
        const m = readManifestAt(join(getPluginsRoot(), pluginId))
        if (!('error' in m) && Array.isArray(m.manifest.vaultScope)) vaultScope = m.manifest.vaultScope
      } catch { /* 未声明 */ }
      return { enabled: entry.enabled, capabilities: entry.grantedCapabilities ?? [], vaultScope }
    },
    audit: (pluginId, action, detail) => auditWrite(pluginId, action, detail),
    onSessionClosed: (pluginId) => unsubscribeAllPluginEvents(pluginId),
    methods: {
      // data 表 CRUD（v2 通道；执行复用 v1 逻辑但 pluginId 取自 token 会话，不信任调用方）
      'kb.data.query': {
        capability: 'data',
        run: (_ctx, params) => {
          const acc = assertDataAccess(_ctx.pluginId)
          if (!acc.ok) throw Object.assign(new Error(acc.error), { code: 'ECAPABILITY' })
          const p = (params ?? {}) as { table?: string; where?: unknown; orderBy?: string; desc?: boolean; limit?: number }
          if (typeof p.table !== 'string' || !p.table) throw Object.assign(new Error('table 缺失'), { code: 'EPARAM' })
          return pluginQuery(_ctx.pluginId, acc.tables, p.table, {
            where: p.where as WhereCond[], orderBy: p.orderBy, desc: p.desc, limit: p.limit,
          })
        },
      },
      'kb.data.insert': {
        capability: 'data',
        run: (_ctx, params) => {
          const acc = assertDataAccess(_ctx.pluginId)
          if (!acc.ok) throw Object.assign(new Error(acc.error), { code: 'ECAPABILITY' })
          const p = (params ?? {}) as { table?: string; row?: Record<string, unknown> }
          if (typeof p.table !== 'string' || !p.row) throw Object.assign(new Error('table/row 缺失'), { code: 'EPARAM' })
          return pluginInsert(_ctx.pluginId, acc.tables, p.table, p.row)
        },
      },
      'kb.data.update': {
        capability: 'data',
        run: (_ctx, params) => {
          const acc = assertDataAccess(_ctx.pluginId)
          if (!acc.ok) throw Object.assign(new Error(acc.error), { code: 'ECAPABILITY' })
          const p = (params ?? {}) as { table?: string; rowId?: string | number; patch?: Record<string, unknown> }
          if (typeof p.table !== 'string' || p.rowId === undefined || !p.patch) throw Object.assign(new Error('参数缺失'), { code: 'EPARAM' })
          return pluginUpdate(_ctx.pluginId, acc.tables, p.table, p.rowId, p.patch)
        },
      },
      'kb.data.delete': {
        capability: 'data',
        run: (_ctx, params) => {
          const acc = assertDataAccess(_ctx.pluginId)
          if (!acc.ok) throw Object.assign(new Error(acc.error), { code: 'ECAPABILITY' })
          const p = (params ?? {}) as { table?: string; rowId?: string | number }
          if (typeof p.table !== 'string' || p.rowId === undefined) throw Object.assign(new Error('参数缺失'), { code: 'EPARAM' })
          return pluginDelete(_ctx.pluginId, acc.tables, p.table, p.rowId)
        },
      },

      // ---- 渲染层本地能力（v2 语义）：主进程只做能力裁决，回 { local } 标记，
      // PluginFrame 收到后执行真正的渲染层动作（toast/clipboard/theme 只能渲染层做）。
      // toast 免授权（对齐 v1：capability 空串）；clipboard/theme/hostReview 按 v1 同能力名裁决。
      'kb.ui.toast': { capability: '', run: () => ({ local: 'toast' }) },
      'kb.ui.clipboard.write': { capability: 'clipboard', run: () => ({ local: 'clipboard' }) },
      'kb.ui.theme.apply': { capability: 'theme', run: () => ({ local: 'theme' }) },
      'kb.ui.hostReview': { capability: 'knowledge', run: () => ({ local: 'host.review' }) },

      // ---- 文件读取（files 能力）----
      // 语义：插件无法直接触达磁盘，只能「弹系统对话框由用户显式挑文件」，
      // 主进程读盘后把内容以 base64 回传（v1 简单可靠，避免给插件任何路径能力）。
      // 安全约束：①仅对话框授权路径 ②扩展名白名单 ③体积上限（防 IPC 打爆内存）
      'kb.files.pick': {
        capability: 'files',
        run: async (ctx, params) => {
          const p = (params ?? {}) as { accept?: string; maxBytes?: number }
          const accept = (p.accept ?? 'pdf').toLowerCase()
          const maxBytes = Math.min(Math.max(Number(p.maxBytes) || FILE_PICK_MAX_BYTES, 1), FILE_PICK_MAX_BYTES)
          const extList = accept.split(',').map((s) => s.trim().replace(/^\./, '')).filter(Boolean)
          if (extList.length === 0 || extList.some((e) => !/^[a-z0-9]{1,8}$/.test(e))) {
            throw Object.assign(new Error('accept 需为逗号分隔的扩展名(不含点)'), { code: 'EPARAM' })
          }
          const win = BrowserWindow.getFocusedWindow()
          const opts: Electron.OpenDialogOptions = {
            title: '选择文件',
            properties: ['openFile'],
            filters: [{ name: '允许的文件', extensions: extList }],
          }
          const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
          if (res.canceled || res.filePaths.length === 0) return { canceled: true }
          const filePath = res.filePaths[0]
          // 二次校验：对话框 filters 可被绕过（用户手输路径），落盘前再判一次扩展名与体积
          const ext = extname(filePath).slice(1).toLowerCase()
          if (!extList.includes(ext)) {
            throw Object.assign(new Error(`文件类型不允许: .${ext}`), { code: 'EPARAM' })
          }
          const stat = statSync(filePath)
          if (stat.size > maxBytes) {
            throw Object.assign(
              new Error(`文件过大: ${(stat.size / 1024 / 1024).toFixed(1)}MB（上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB）`),
              { code: 'EPARAM' },
            )
          }
          const buf = readFileSync(filePath)
          auditWrite(ctx.pluginId, 'files.pick', { size: stat.size, ext, name: basename(filePath) })
          return {
            canceled: false,
            name: basename(filePath),
            size: stat.size,
            ext,
            data: buf.toString('base64'),
          }
        },
      },

      // ---- kb.store.* 插件私有存储（plugin-api-v2-design §5.1）----
      // 免授权（capability 空串）：私有目录（.knowbase/plugins/<id>/）+ key 穿越校验 + 单文件
      // 10MB 配额 = 天然安全边界，无需额外授权（对齐 toast 语义）。pluginId 取 token 会话。
      'kb.store.get': {
        capability: '',
        run: (ctx, params) => {
          const p = (params ?? {}) as { key?: string }
          if (typeof p.key !== 'string') throw Object.assign(new Error('key 缺失'), { code: 'EPARAM' })
          const r = pluginStoreGet(ctx.pluginId, p.key)
          if (!r.ok) throw Object.assign(new Error(r.error), { code: 'EPARAM' })
          return { value: r.value }
        },
      },
      'kb.store.set': {
        capability: '',
        run: (ctx, params) => {
          const p = (params ?? {}) as { key?: string; value?: unknown }
          if (typeof p.key !== 'string') throw Object.assign(new Error('key 缺失'), { code: 'EPARAM' })
          const r = pluginStoreSet(ctx.pluginId, p.key, p.value)
          if (!r.ok) throw Object.assign(new Error(r.error), { code: 'EPARAM' })
          return { ok: true }
        },
      },
      'kb.store.delete': {
        capability: '',
        run: (ctx, params) => {
          const p = (params ?? {}) as { key?: string }
          if (typeof p.key !== 'string') throw Object.assign(new Error('key 缺失'), { code: 'EPARAM' })
          const r = pluginStoreDelete(ctx.pluginId, p.key)
          if (!r.ok) throw Object.assign(new Error(r.error), { code: 'EPARAM' })
          return { ok: true }
        },
      },
      'kb.store.has': {
        capability: '',
        run: (ctx, params) => {
          const p = (params ?? {}) as { key?: string }
          if (typeof p.key !== 'string') throw Object.assign(new Error('key 缺失'), { code: 'EPARAM' })
          return { exists: pluginStoreHas(ctx.pluginId, p.key) }
        },
      },
      'kb.store.usage': {
        capability: '',
        run: (ctx) => pluginStoreUsage(ctx.pluginId),
      },

      // ---- kb.events.* 事件订阅（plugin-phase1-design C4）----
      // capability '' + run 内逐事件校验（ADR-2：映射现有模块 capability，不新增 events:* 权限面）；
      // 仅 code 插件可订阅（ADR-3，查清单类型——ui 无后台生命、declarative 无逻辑）。
      'kb.events.subscribe': {
        capability: '',
        run: (ctx, params) => {
          const p = (params ?? {}) as { events?: unknown }
          const list = Array.isArray(p.events) ? p.events.filter((e): e is string => typeof e === 'string') : []
          if (list.length === 0) throw Object.assign(new Error('events 缺失'), { code: 'EPARAM' })
          const dir = safePathInside(getPluginsRoot(), ctx.pluginId)
          let pluginType = 'declarative'
          if (dir && existsSync(dir)) {
            try {
              const m = readManifestAt(dir)
              if (!('error' in m)) pluginType = m.manifest.type
            } catch { /* 清单异常按 declarative 拒绝 */ }
          }
          if (pluginType !== 'code') throw Object.assign(new Error('仅 code 插件可订阅事件'), { code: 'EPERMISSION' })
          const r = subscribePluginEvents(ctx.pluginId, list, ctx.capabilities)
          if (r.subscribed.length === 0) {
            throw Object.assign(new Error(`无可用订阅：${r.denied.map(d => `${d.event}（${d.reason}）`).join('；')}`), { code: 'EPERMISSION' })
          }
          return { subscribed: r.subscribed, denied: r.denied }
        },
      },
      'kb.events.unsubscribe': {
        capability: '',
        run: (ctx, params) => {
          const p = (params ?? {}) as { events?: unknown }
          const list = Array.isArray(p.events) ? p.events.filter((e): e is string => typeof e === 'string') : undefined
          unsubscribePluginEvents(ctx.pluginId, list)
          return { ok: true }
        },
      },

      // ---- kb.metadata.* 知识库元数据只读面（knowledge-index-design §9 / plugin-api-v2-design §5.3）----
      // capability 统一 vault:read（只读，但暴露全部笔记元数据与检索结果 → C 级授权）。
      // 范围与知识库 UI 搜索同口径：草稿页不出（status !== 'draft'），二进制归档文件除外。
      'kb.metadata.search': {
        capability: 'vault:read',
        run: async (_ctx, params) => {
          const p = (params ?? {}) as { query?: unknown; topK?: unknown; mode?: unknown }
          const q = typeof p.query === 'string' ? p.query.trim() : ''
          if (!q) throw Object.assign(new Error('query 缺失'), { code: 'EPARAM' })
          const topK = Math.min(Math.max(Math.floor(Number(p.topK) || 8), 1), 30)
          const mode = p.mode === 'keyword' || p.mode === 'semantic' ? p.mode : 'auto'
          const r = await searchKnowledge({ query: q, topK, mode })
          return { hits: r.hits, semantic: r.semantic }
        },
      },
      'kb.metadata.get': {
        capability: 'vault:read',
        run: (_ctx, params) => {
          const p = (params ?? {}) as { pageId?: unknown; path?: unknown }
          const idx = getKnowledgeIndex()
          let entry = null
          if (typeof p.pageId === 'string' && p.pageId) {
            entry = idx.byId[p.pageId] ?? null
          } else if (typeof p.path === 'string' && p.path) {
            // 只做字符串匹配（不触盘），路径归一化后与索引条目比对——无越界面
            const norm = p.path.replace(/\\/g, '/').replace(/^\/+/, '')
            entry = idx.pages.find((x) => x.path === norm) ?? null
          } else {
            throw Object.assign(new Error('pageId 或 path 缺失'), { code: 'EPARAM' })
          }
          if (!entry || entry.entryKind === 'file') throw Object.assign(new Error('页面不存在'), { code: 'ENOTFOUND' })
          return {
            pageId: entry.id, path: entry.path, title: entry.title, tags: entry.tags,
            status: entry.status, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
            frontmatter: entry.frontmatter, outgoingTitles: entry.outgoingTitles,
          }
        },
      },
      'kb.metadata.query': {
        capability: 'vault:read',
        run: (_ctx, params) => {
          const p = (params ?? {}) as { tag?: unknown; folder?: unknown; frontmatter?: unknown; limit?: unknown }
          const idx = getKnowledgeIndex()
          const tag = typeof p.tag === 'string' ? p.tag.trim().toLowerCase() : ''
          const folder = typeof p.folder === 'string' ? p.folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : ''
          const expr = typeof p.frontmatter === 'string' ? p.frontmatter.trim() : ''
          if (!tag && !folder && !expr) throw Object.assign(new Error('tag / folder / frontmatter 至少给一个'), { code: 'EPARAM' })
          const limit = Math.min(Math.max(Math.floor(Number(p.limit) || 50), 1), 200)
          const results: Array<{ pageId: string; path: string; title: string; tags: string[]; updatedAt: string }> = []
          for (const e of idx.pages) {
            if (e.status === 'draft' || e.entryKind === 'file') continue
            if (tag && !e.tags.some((t) => t.toLowerCase().includes(tag))) continue
            if (folder && !e.path.startsWith(folder + '/')) continue
            if (expr) {
              try {
                if (!evaluateFrontmatterQuery(expr, e.frontmatter)) continue
              } catch (err) {
                throw Object.assign(new Error(String((err as Error).message)), { code: 'EPARAM' })
              }
            }
            results.push({ pageId: e.id, path: e.path, title: e.title, tags: e.tags, updatedAt: e.updatedAt })
            if (results.length >= limit) break
          }
          return { results, total: results.length }
        },
      },
      'kb.metadata.backlinks': {
        capability: 'vault:read',
        run: (_ctx, params) => {
          const p = (params ?? {}) as { pageId?: unknown; path?: unknown }
          const idx = getKnowledgeIndex()
          let pageId = typeof p.pageId === 'string' ? p.pageId : ''
          if (!pageId && typeof p.path === 'string' && p.path) {
            const norm = p.path.replace(/\\/g, '/').replace(/^\/+/, '')
            pageId = idx.pages.find((x) => x.path === norm)?.id ?? ''
          }
          if (!pageId || !idx.byId[pageId]) throw Object.assign(new Error('页面不存在'), { code: 'ENOTFOUND' })
          // 复用知识库反链面板同一份 GraphIndex 解析（R2/R4），不新写链接解析
          const backlinks = vaultGetBacklinks(pageId).map((v) => ({ pageId: v.id, title: v.title, path: v.path }))
          return { backlinks, total: backlinks.length }
        },
      },

      // ---- kb.vault.* 仓库文件只读/受控写（P2，plugin-api-v2-design §5.2）----
      // 安全链：resolveSafe（拒越界/盘符/符号链接逐段校验）→ 保护区规则（assertAiWritable 等
      // builtin.vault.* 同款 helper）→ 写/删额外过 manifest.vaultScope 前缀收敛（ADR-7：读全库、写限域）。
      'kb.vault.getInfo': {
        capability: 'vault:read',
        run: () => {
          const cur = getCurrentVault()
          if (!cur?.rootPath) throw Object.assign(new Error('仓库未打开'), { code: 'EHOST' })
          // 红线：永不返回 rootPath（插件永不接触绝对路径）
          return { rootId: cur.rootId, name: cur.name ?? '' }
        },
      },
      'kb.vault.list': {
        capability: 'vault:read',
        run: (_ctx, params) => {
          const p = (params ?? {}) as { path?: unknown }
          const rel = typeof p.path === 'string' ? p.path.trim() : ''
          const root = vaultRootPath()
          const abs = resolveSafe(root, rel || '.')
          if (!abs) throw Object.assign(new Error(`路径非法或越出仓库: ${rel || '.'}`), { code: 'EPATH' })
          let isDir = false
          try { isDir = statSync(abs).isDirectory() } catch { throw Object.assign(new Error(`路径不存在: ${rel || '.'}`), { code: 'ENOTFOUND' }) }
          if (!isDir) throw Object.assign(new Error('kb.vault.list 只接受目录（读文件用 kb.vault.read）'), { code: 'EPARAM' })
          const entries: Array<{ name: string; type: 'dir' | 'file'; size?: number }> = []
          for (const name of readdirSync(abs)) {
            if (entries.length >= MAX_VAULT_LIST_ENTRIES) break
            const full = join(abs, name)
            if (!childAiAllowed(root, full)) continue
            let st: ReturnType<typeof lstatSync>
            try { st = lstatSync(full) } catch { continue }
            if (st.isSymbolicLink()) continue
            if (st.isDirectory()) entries.push({ name, type: 'dir' })
            else if (st.isFile() && isAiReadableFile(root, full)) entries.push({ name, type: 'file', size: st.size })
          }
          entries.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'zh-Hans-CN'))
          return { path: rel || '.', total: entries.length, entries }
        },
      },
      'kb.vault.read': {
        capability: 'vault:read',
        run: (_ctx, params) => {
          const p = (params ?? {}) as { path?: unknown }
          const rel = typeof p.path === 'string' ? p.path.trim() : ''
          if (!rel) throw Object.assign(new Error('path 缺失'), { code: 'EPARAM' })
          const root = vaultRootPath()
          const abs = resolveSafe(root, rel)
          if (!abs) throw Object.assign(new Error(`路径非法或越出仓库: ${rel}`), { code: 'EPATH' })
          let st: ReturnType<typeof statSync>
          try { st = statSync(abs) } catch { throw Object.assign(new Error(`文件不存在: ${rel}`), { code: 'ENOTFOUND' }) }
          if (!st.isFile()) throw Object.assign(new Error('仅支持文件（列目录用 kb.vault.list）'), { code: 'EPARAM' })
          if (st.size > MAX_VAULT_FILE) throw Object.assign(new Error(`文件过大（${st.size} 字节 > 10MB），拒绝读取`), { code: 'ELIMIT' })
          if (!isAiReadableFile(root, abs)) throw Object.assign(new Error('该文件类型不可读（仅 .md/.txt 与 .knowbase/modules/*.json）'), { code: 'EPARAM' })
          return { path: rel, content: readFileSync(abs, 'utf-8'), size: st.size, mtimeMs: st.mtimeMs }
        },
      },
      'kb.vault.stat': {
        capability: 'vault:read',
        run: (_ctx, params) => {
          const p = (params ?? {}) as { path?: unknown }
          const rel = typeof p.path === 'string' ? p.path.trim() : ''
          if (!rel) throw Object.assign(new Error('path 缺失'), { code: 'EPARAM' })
          const root = vaultRootPath()
          const abs = resolveSafe(root, rel)
          if (!abs) throw Object.assign(new Error(`路径非法或越出仓库: ${rel}`), { code: 'EPATH' })
          let st: ReturnType<typeof lstatSync>
          try { st = lstatSync(abs) } catch { throw Object.assign(new Error(`路径不存在: ${rel}`), { code: 'ENOTFOUND' }) }
          if (st.isSymbolicLink()) throw Object.assign(new Error('拒绝符号链接'), { code: 'EPATH' })
          return {
            path: rel,
            type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
            ...(st.isFile() ? { size: st.size } : {}),
            mtimeMs: st.mtimeMs,
          }
        },
      },
      'kb.vault.write': {
        capability: 'vault:write',
        run: (ctx, params) => {
          const p = (params ?? {}) as { path?: unknown; content?: unknown; expectedMtimeMs?: unknown }
          const rel = typeof p.path === 'string' ? p.path.trim() : ''
          const content = typeof p.content === 'string' ? p.content : null
          if (!rel || content === null) throw Object.assign(new Error('path / content 缺失'), { code: 'EPARAM' })
          if (content.length > 2_000_000) throw Object.assign(new Error('内容过大（>2MB），拒绝写入'), { code: 'ELIMIT' })
          if (content.includes('\u0000')) throw Object.assign(new Error('内容含 NUL 字符，拒绝写入'), { code: 'EPARAM' })
          enforceVaultScope(rel, ctx.vaultScope)
          const root = vaultRootPath()
          const abs = resolveSafe(root, rel)
          if (!abs) throw Object.assign(new Error(`路径非法或越出仓库: ${rel}`), { code: 'EPATH' })
          let existing = false
          try { existing = statSync(abs).isFile() } catch { /* 新建 */ }
          assertAiWritable(root, abs, existing && typeof p.expectedMtimeMs === 'number' ? p.expectedMtimeMs : null)
          if (!existing) mkdirSync(dirname(abs), { recursive: true })
          writeWorkspaceFile(abs, content)
          if (rel.toLowerCase().endsWith('.md')) invalidateIndexIfCurrentVault(getCurrentVault()?.rootId ?? '')
          const st = statSync(abs)
          return { ok: true, path: rel, created: !existing, size: st.size, mtimeMs: st.mtimeMs }
        },
      },
      'kb.vault.trash': {
        capability: 'vault:write',
        run: async (ctx, params) => {
          const p = (params ?? {}) as { path?: unknown }
          const rel = typeof p.path === 'string' ? p.path.trim() : ''
          if (!rel) throw Object.assign(new Error('path 缺失'), { code: 'EPARAM' })
          enforceVaultScope(rel, ctx.vaultScope)
          const root = vaultRootPath()
          const abs = resolveSafe(root, rel)
          if (!abs) throw Object.assign(new Error(`路径非法或越出仓库: ${rel}`), { code: 'EPATH' })
          if (!isAiWritableFile(root, abs)) throw Object.assign(new Error('仅可移入回收站普通区 .md/.txt 文件（.knowbase 内部数据禁动）'), { code: 'EPARAM' })
          if (!statSync(abs).isFile()) throw Object.assign(new Error('kb.vault.trash 仅支持文件'), { code: 'EPARAM' })
          const rootId = getCurrentVault()?.rootId
          if (!rootId) throw Object.assign(new Error('仓库上下文未就绪'), { code: 'EHOST' })
          await trashWorkspacePath(rootId, rel)
          return { ok: true, trashed: rel }
        },
      },
    },
  })

  // token 会话生命周期由 PluginFrame 管理：挂载 open、卸载 close、宿主退出全清。
  // 注意：sessionState 读的是磁盘 index——enable/disable 变更后新 open 立即反映。
  ipcMain.handle('host:bridge-open', (_e, pluginId: unknown) => {
    const r = gateway.open(typeof pluginId === 'string' ? pluginId : '')
    if (!r.ok) return r
    return { ok: true, token: r.token, hostVersion: app.getVersion() }
  })
  ipcMain.handle('host:bridge-close', (_e, token: unknown) => {
    if (typeof token === 'string') gateway.close(token)
    return { ok: true }
  })
  ipcMain.handle('host:rpc', async (_e, msg: unknown) => {
    const m = (msg ?? {}) as { token?: unknown; id?: unknown; method?: unknown; params?: unknown }
    const res = gateway.rpc(m.token, m.method, m.params)
    // async handler 需 await；统一返回 { id, ...结果 } 供渲染层按 id 配对
    const settled = res instanceof Promise ? await res : res
    return { id: m.id, ...settled }
  })
}
