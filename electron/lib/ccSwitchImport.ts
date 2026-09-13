import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import initSqlJs from 'sql.js'

/**
 * CC Switch 导入器 —— 读取 ~/.cc-switch/cc-switch.db（新版 SSOT SQLite），
 * 把用户已配置的供应商一键导入模型网关。
 *
 * 安全约定：
 * - Key 明文只在主进程内存的导入缓存中短暂存在（list 时缓存，import 时取用并立即加密落盘，secretBox）
 * - 渲染层仅收到打码预览（前6位+***+后4位），全程接触不到明文
 */

export interface CcSwitchItem {
  /** 导入缓存键（渲染层回传它即可完成导入） */
  id: string
  name: string
  type: 'openai-compatible' | 'ollama' | 'anthropic'
  baseUrl: string
  keyPreview: string
}

interface CachedItem extends CcSwitchItem {
  apiKey: string
}

/** 模块级缓存：list 时填充、import 时消费；键为 CcSwitchItem.id */
let cache = new Map<string, CachedItem>()

function maskKey(k: string): string {
  if (!k) return ''
  return k.length > 12 ? k.slice(0, 6) + '***' + k.slice(-4) : '***'
}

function inferType(baseUrl: string): CcSwitchItem['type'] {
  let host = ''
  try { host = new URL(baseUrl).hostname } catch { /* ignore */ }
  if (host === 'localhost' || host === '127.0.0.1') return 'ollama'
  if (/anthropic/i.test(baseUrl)) return 'anthropic'
  return 'openai-compatible'
}

function extractFromToml(toml: string): string | null {
  const m = /^\s*base_url\s*=\s*"([^"]+)"/m.exec(toml ?? '')
  return m ? m[1] : null
}

/** 解析 providers 表 → 可导入条目（跳过官方登录占位与无 Key 条目） */
function extractItems(rows: any[]): CcSwitchItem[] {
  const out: CcSwitchItem[] = []
  cache = new Map()
  const seen = new Set<string>()
  for (const row of rows) {
    try {
      const appType = String(row.app_type ?? '')
      const name = String(row.name ?? '').trim()
      if (!name || String(row.category ?? '') === 'official') continue

      const cfg = JSON.parse(String(row.settings_config ?? '{}'))
      let baseUrl = ''
      let apiKey = ''

      if (appType === 'claude' || appType === 'claude-desktop') {
        const env = cfg.env ?? {}
        apiKey = String(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? '')
        baseUrl = String(env.ANTHROPIC_BASE_URL ?? '')
        if (!apiKey || !baseUrl) continue // 官方登录占位等
      } else if (appType === 'codex') {
        apiKey = String(cfg.auth?.OPENAI_API_KEY ?? '')
        baseUrl = extractFromToml(String(cfg.config ?? '')) ?? ''
        if (!apiKey || !baseUrl) continue
      } else {
        continue // gemini/grokbuild 等暂不支持
      }

      baseUrl = baseUrl.replace(/\/+$/, '')
      const type = inferType(baseUrl)
      const dedup = `${type}|${baseUrl}|${apiKey}`
      if (seen.has(dedup)) continue
      seen.add(dedup)

      const item: CachedItem = {
        id: `${appType}:${row.id}`,
        name,
        type,
        baseUrl,
        keyPreview: maskKey(apiKey),
        apiKey,
      }
      cache.set(item.id, item)
      out.push({ id: item.id, name: `${name}（${appType}）`, type, baseUrl, keyPreview: item.keyPreview })
    } catch { /* 单行解析失败跳过 */ }
  }
  return out
}

export interface CcSwitchScanResult {
  found: boolean
  source: string
  items: CcSwitchItem[]
}

/** 扫描 CC Switch 数据库（只读快照方式打开，不影响原应用） */
export async function scanCcSwitch(): Promise<CcSwitchScanResult> {
  const dbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db')
  if (!fs.existsSync(dbPath)) {
    return { found: false, source: dbPath, items: [] }
  }
  const { default: initSqlJs } = await import('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  try {
    const res = db.exec('SELECT id, app_type, name, settings_config, category FROM providers ORDER BY app_type, sort_index')
    const rows = res[0]?.values?.map((cols: unknown[]) => ({
      id: cols[0], app_type: cols[1], name: cols[2], settings_config: cols[3], category: cols[4],
    })) ?? []
    return { found: true, source: dbPath, items: extractItems(rows) }
  } finally {
    db.close()
  }
}

/** 导入选中项：复用网关的加密存储链路 */
export function takeCached(id: string): CachedItem | undefined {
  return cache.get(id)
}

export interface ImportOutcome {
  imported: number
  skipped: number
  errors: string[]
}

/** 由 llmService 注入的实际落库动作（避免循环依赖） */
let saveFn: ((draft: { name: string; type: 'openai-compatible' | 'ollama' | 'anthropic'; baseUrl: string; apiKey: string }) => { ok: boolean; error?: string }) | null = null

export function bindCcSwitchSaver(fn: typeof saveFn): void {
  saveFn = fn
}

export async function importCcSwitchIds(ids: string[]): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { imported: 0, skipped: 0, errors: [] }
  for (const id of ids) {
    const item = cache.get(id)
    if (!item) { outcome.skipped++; continue }
    if (!saveFn) { outcome.errors.push('服务未就绪'); continue }
    const r = saveFn({
      name: `${item.name}`,
      type: item.type,
      baseUrl: item.baseUrl,
      apiKey: item.apiKey,
    })
    if (r.ok) outcome.imported++
    else outcome.errors.push(`${item.name}: ${r.error ?? '未知错误'}`)
  }
  return outcome
}
