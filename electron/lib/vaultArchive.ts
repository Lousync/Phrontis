import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, lstatSync } from 'fs'
import { join, dirname, relative, sep, basename, extname } from 'path'
import { zipBuffer, unzipBuffer } from './zip'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { invalidateKnowledgeIndex } from 'phrontis-core/kbStore/knowledgeIndex'
import { invalidateGraphIndex } from 'phrontis-core/kbStore/graphIndex'
import { adoptImportedVault } from './workspaceManager'

/**
 * 整仓导出 / 导入（P6 / D5）
 * - 导出：仓库根全部内容（含 .knowbase、.attachments，无排除项）→ zip（lib/zip.ts 复用）
 * - 导入：剥壳（zip 内单一顶层目录则去掉一层）→ 路径安全校验（拒绝绝对路径/../深层 .knowbase，
 *   P5a 的导入侧层）→ 冲突扫描 → 渲染层逐条决策（覆盖/跳过/重命名）→ 落盘 → 登记/重建索引
 * - 交互为「设置页组件发起并持有 promise」的同步 IPC 回合：importStart 返回冲突清单（或结果），
 *   有冲突时渲染层弹列表，再调 importDecide 提交决定。主进程只暂存一份待决计划（可被新导入覆盖）。
 */

interface PendingPlan {
  target: string
  mergeIntoExistingVault: boolean
  entries: Array<{ path: string; data: Buffer; size: number }>
  conflicts: Array<{ relPath: string; zipSize: number; existingSize: number }>
  /** 扫描层「目标与归档字节级一致」直接跳过的条数（并入最终 skipped 统计） */
  identicalSkipped: number
  createdAt: number
}
let pendingPlan: PendingPlan | null = null

/** 递归收集目录内全部文件路径（含隐藏项；跳过 symlink 防环）*/
function collectFiles(dirAbs: string, out: string[]): void {
  let names: string[]
  try {
    names = readdirSync(dirAbs)
  } catch {
    return
  }
  for (const name of names) {
    const abs = join(dirAbs, name)
    try {
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) collectFiles(abs, out)
      else if (st.isFile()) out.push(abs)
    } catch { /* 单文件不可读不阻断 */ }
  }
}

function win(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

/** 归一 zip 路径为 posix 相对路径；非法（绝对/盘符/../UNC）返回 null */
function sanitizeEntryPath(raw: string): string | null {
  const p = raw.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!p || p.includes(':')) return null
  const segs = p.split('/').filter((s) => s !== '' && s !== '.')
  if (segs.length === 0 || segs.some((s) => s === '..')) return null
  return segs.join('/')
}

/** 剥壳：全部条目共享唯一顶层目录 → 去掉一层（zip 带不带外层文件夹都兼容） */
function peelShell(paths: string[]): number {
  if (paths.length === 0) return 0
  const first = paths[0].split('/')[0]
  if (!first) return 0
  return paths.every((p) => p.split('/')[0] === first && p.includes('/')) ? 1 : 0
}

/** P5a 导入侧：剥壳后 `.knowbase` 只允许出现在首段（仓库根的 .knowbase）；深层出现 = 布局违规 */
function hasDeepKnowbase(paths: string[]): string | null {
  for (const p of paths) {
    const segs = p.split('/')
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].toLowerCase() === '.knowbase') return p
    }
  }
  return null
}

export function registerVaultArchiveHandlers(): void {
  // ===== 导出 =====
  ipcMain.handle('va:export', async () => {
    const vault = getCurrentVault()
    if (!vault) return { error: '当前没有打开的仓库' }
    const w = win()
    if (!w) return { error: '主窗口不可用' }
    const safeName = String(vault.name || basename(vault.rootPath)).replace(/[\\/:*?"<>|]/g, '_')
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    const suggested = join(app.getPath('documents'), `knowbase-${safeName}-${stamp}.zip`)
    const save = await dialog.showSaveDialog(w, {
      title: '导出整个仓库（zip）',
      defaultPath: suggested,
      filters: [{ name: 'Zip 归档', extensions: ['zip'] }],
    })
    if (save.canceled || !save.filePath) return { canceled: true }
    try {
      const files: string[] = []
      collectFiles(vault.rootPath, files)
      const entries = files.map((abs) => ({
        path: relative(vault.rootPath, abs).split(sep).join('/'),
        data: readFileSync(abs),
      }))
      const buf = zipBuffer(entries)
      writeFileSync(save.filePath, buf)
      console.log(`[vaultArchive] Exported ${entries.length} files -> ${save.filePath} (${Math.round(buf.length / 1024)}KB)`)
      return { ok: true, path: save.filePath, files: entries.length, bytes: buf.length }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // ===== 导入 · 第一步：选 zip + 目标目录，扫描冲突 =====
  ipcMain.handle('va:importStart', async () => {
    const w = win()
    if (!w) return { error: '主窗口不可用' }
    const pick = await dialog.showOpenDialog(w, {
      title: '选择仓库归档（zip）',
      properties: ['openFile'],
      filters: [{ name: 'Zip 归档', extensions: ['zip'] }],
    })
    if (pick.canceled || pick.filePaths.length === 0) return { canceled: true }
    const zipPath = pick.filePaths[0]

    const dst = await dialog.showOpenDialog(w, {
      title: '选择导入目标文件夹（空文件夹=新建仓库；已有 .knowbase 的仓库=合并导入）',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (dst.canceled || dst.filePaths.length === 0) return { canceled: true }
    const target = dst.filePaths[0]

    try {
      const map = unzipBuffer(readFileSync(zipPath))
      const normalized: Array<{ path: string; data: Buffer }> = []
      for (const [raw, data] of map.entries()) {
        if (raw.endsWith('/')) continue // 目录项（zip.ts 不写目录项，防御历史包）
        const p = sanitizeEntryPath(raw)
        if (!p) return { error: `归档含非法路径：${raw}` }
        normalized.push({ path: p, data })
      }
      if (normalized.length === 0) return { error: '归档为空，没有可导入的文件' }
      const shell = peelShell(normalized.map((e) => e.path))
      const paths = normalized.map((e) => (shell ? e.path.split('/').slice(shell).join('/') : e.path))
      const deep = hasDeepKnowbase(paths)
      if (deep) return { error: `归档布局违规：嵌套 .knowbase（${deep}）。一个仓库最多一个 .knowbase` }

      // 目标形态判定
      const targetHasKb = existsSync(join(target, '.knowbase'))
      if (!targetHasKb) {
        // 空目录才允许作为新仓库导入（防打乱用户已有文件夹）
        let hasOther = false
        try { hasOther = readdirSync(target).some((n) => !n.startsWith('.')) } catch { /* ignore */ }
        if (hasOther) return { error: '目标文件夹非空且不是仓库：请选择空文件夹（新建）或仓库根目录（合并）' }
      }
      const cur = getCurrentVault()
      if (cur && relative(cur.rootPath, target) && !relative(cur.rootPath, target).startsWith('..')) {
        return { error: '不能把仓库导入到当前仓库内部（嵌套仓库）' }
      }

      const entries: PendingPlan['entries'] = []
      const conflicts: PendingPlan['conflicts'] = []
      let identicalSkipped = 0
      for (let i = 0; i < normalized.length; i++) {
        const p = paths[i]
        const data = normalized[i].data
        const abs = join(target, ...p.split('/'))
        if (existsSync(abs) && statSync(abs).isFile()) {
          const existingSize = statSync(abs).size
          if (existingSize === data.length) {
            // 尺寸相同再比内容：完全一致 → 整条剔除（幂等，不重复写盘）
            let same = false
            try { same = data.length <= 25 * 1024 * 1024 && readFileSync(abs).equals(data) } catch { same = false }
            if (same) { identicalSkipped++; continue }
          }
          conflicts.push({ relPath: p, zipSize: data.length, existingSize })
        }
        entries.push({ path: p, data, size: data.length })
      }

      if (conflicts.length > 0) {
        pendingPlan = { target, mergeIntoExistingVault: targetHasKb, entries, conflicts, identicalSkipped, createdAt: Date.now() }
        return { pending: true, target, conflicts, totalFiles: entries.length }
      }
      const written = applyWrites(target, entries, new Map())
      return finishImport(target, targetHasKb, { ...written, skipped: written.skipped + identicalSkipped })
    } catch (e) {
      return { error: `导入失败：${(e as Error).message}` }
    }
  })

  // ===== 导入 · 第二步：提交逐条决策（覆盖/跳过/重命名）=====
  ipcMain.handle('va:importDecide', (_e, decisions: Array<{ relPath: string; action: 'overwrite' | 'skip' | 'rename' }>) => {
    if (!pendingPlan) return { error: '没有待决的导入（已过期或被新导入取代）' }
    const plan = pendingPlan
    pendingPlan = null
    try {
      const map = new Map((Array.isArray(decisions) ? decisions : []).map((d) => [d.relPath, d.action]))
      const written = applyWrites(plan.target, plan.entries, map)
      return finishImport(plan.target, plan.mergeIntoExistingVault, { ...written, skipped: written.skipped + (plan.identicalSkipped ?? 0) })
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // 放弃待决导入
  ipcMain.handle('va:importCancel', () => {
    pendingPlan = null
    return { ok: true }
  })
}

/** 落盘：决策 map（仅冲突项需要动作；默认覆盖写；rename 加时间戳后缀） */
function applyWrites(
  target: string,
  entries: PendingPlan['entries'],
  decisions: Map<string, 'overwrite' | 'skip' | 'rename'>,
): { written: number; skipped: number; renamed: number } {
  let written = 0
  let skipped = 0
  let renamed = 0
  for (const e of entries) {
    const action = decisions.get(e.path)
    if (action === 'skip') { skipped++; continue }
    let rel = e.path
    if (action === 'rename') {
      const ext = extname(e.path)
      const d = new Date()
      const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
      rel = e.path.slice(0, e.path.length - ext.length) + `.imported-${ts}` + ext
      renamed++
    }
    const abs = join(target, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, e.data)
    written++
  }
  return { written, skipped, renamed }
}

/** 导入收尾：新仓库则登记为当前仓库；合并进已有仓库则失效缓存索引 */
function finishImport(target: string, mergeIntoExistingVault: boolean, counts: { written: number; skipped: number; renamed: number }) {
  invalidateKnowledgeIndex()
  invalidateGraphIndex()
  if (mergeIntoExistingVault) {
    const cur = getCurrentVault()
    const isCurrent = cur && cur.rootPath === target
    return { ok: true, ...counts, registered: isCurrent ? 'current' : 'existing' }
  }
  const adopted = adoptImportedVault(target)
  return { ok: true, ...counts, registered: 'new', rootId: adopted.rootId, name: adopted.name, path: adopted.path }
}
