import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { readJson, writeJson } from 'phrontis-core/kbStore/jsonStore'

// R6 去库化：真相源 = .knowbase/modules/toolbox/scripts.json（sql.js 路径已移除，D9）
// 行快照 schema（snake_case 字段）与迁移器 planTable 产物约定一致（同 study/sets.json 风格）

interface ScriptRow {
  id: string; name: string; description: string | null; content: string
  language: string; sort_order: number; created_at: string; updated_at: string
}

function rowToScript(row: ScriptRow) {
  return {
    id: row.id, name: row.name, description: row.description || '',
    content: row.content, language: row.language,
    sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at
  }
}

/** 对齐 sqlite datetime('now','localtime') 的本地时间串 */
function localNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function readRows(): ScriptRow[] {
  return readJson<ScriptRow[]>('toolbox', 'scripts.json', [])
}

function writeRows(rows: ScriptRow[]): void {
  writeJson('toolbox', 'scripts.json', rows)
}

// ---- IPC handlers ----
export function registerToolboxHandlers(): void {

  ipcMain.handle('toolbox:getScripts', () => {
    return readRows()
      .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
      .map(rowToScript)
  })

  ipcMain.handle('toolbox:getScriptById', (_e, id: string) => {
    const row = readRows().find((r) => r.id === id)
    return row ? rowToScript(row) : null
  })

  ipcMain.handle('toolbox:createScript', (_e, data: {
    name?: string; description?: string; content?: string; language?: string
  }) => {
    const rows = readRows()
    const id = randomUUID()
    const now = localNow()
    const sortOrder = rows.reduce((m, r) => Math.max(m, r.sort_order), -1) + 1
    const row: ScriptRow = {
      id,
      name: data.name || '未命名脚本',
      description: data.description || '',
      content: data.content || '',
      language: data.language || 'plaintext',
      sort_order: sortOrder,
      created_at: now,
      updated_at: now,
    }
    rows.push(row)
    writeRows(rows)
    return rowToScript(row)
  })

  ipcMain.handle('toolbox:updateScript', (_e, id: string, data: {
    name?: string; description?: string; content?: string; language?: string; sortOrder?: number
  }) => {
    const rows = readRows()
    const i = rows.findIndex((r) => r.id === id)
    if (i < 0) throw new Error('脚本不存在: ' + id)
    const cur = rows[i]
    const next: ScriptRow = {
      ...cur,
      name: data.name !== undefined ? data.name : cur.name,
      description: data.description !== undefined ? data.description : cur.description,
      content: data.content !== undefined ? data.content : cur.content,
      language: data.language !== undefined ? data.language : cur.language,
      sort_order: data.sortOrder !== undefined ? data.sortOrder : cur.sort_order,
      updated_at: localNow(),
    }
    rows[i] = next
    writeRows(rows)
    return rowToScript(next)
  })

  ipcMain.handle('toolbox:deleteScript', (_e, id: string) => {
    writeRows(readRows().filter((r) => r.id !== id))
  })

  ipcMain.handle('toolbox:reorderScripts', (_e, orderedIds: string[]) => {
    const rows = readRows()
    const idxOf = new Map(orderedIds.map((id, idx) => [id, idx]))
    for (const row of rows) {
      if (idxOf.has(row.id)) row.sort_order = idxOf.get(row.id)!
    }
    writeRows(rows)
  })
}
