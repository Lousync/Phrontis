/**
 * LibreOffice (soffice) 无头转换 —— pptx → pdf，为 AI教学素材视觉转写补上 pptx 栅格化前置
 * （docsReader 文本层拿不到的 MathType 图公式/版式，交给既有 3-21 视觉转写管线；2026-09-09 A+B 方案 B 侧）。
 *
 * 定位顺序：设置项 sofficePath → SOFFICE_PATH 环境变量 → **Windows 注册表**（安装器写的权威位置，
 *           含 WOW6432Node 与 HKCU）→ 常见安装目录 → PATH(where / which)。找不到时返回 null，
 *           由调用方给出**可操作**的降级提示（pdf 路径完全不受影响）。
 * 注册表这条是给「自定义安装盘」用户的兜底：安装在 D 盘等非默认位置时，固定候选路径必然落空，
 * 而安装器总会把 program 目录写进 InstallPath（2026-09-13 实测：D:\tools\LibreOffice 就是这种情况）。
 *
 * 缓存：进程内缓存探测结果并带 TTL —— 用户「装完 LibreOffice 但没重启应用」时不必等重启，
 *       超过 TTL 自动重探；设置页可经 IPC aiTeachSrc:sofficeProbe 手动重探（内部先 resetSofficeCache）。
 *       注意：显式传了非空 settingPath 时永远绕过缓存，保证「设置页填完路径立即生效」。
 * 结果按 文件名+mtime+size 键缓存于系统临时目录：同一 pptx 重复转写/分批续转只做一次转换。
 */
import { spawn, execSync } from 'child_process'
import { existsSync, mkdirSync, copyFileSync, statSync } from 'fs'
import { join, basename, extname } from 'path'
import { tmpdir } from 'os'

const CANDIDATES = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  // 只在 LOCALAPPDATA 存在时才构造 —— 否则 join('', 'Programs', …) 会得到相对路径，
  // existsSync 相对当前工作目录判断，可能误命中同名的相对目录
  ...(process.env.LOCALAPPDATA
    ? [join(process.env.LOCALAPPDATA, 'Programs', 'LibreOffice', 'program', 'soffice.exe')]
    : []),
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/soffice',
]

/** 命中来源 —— 给设置页解释「这个路径是从哪儿找到的」 */
export type SofficeSource = 'setting' | 'env' | 'registry' | 'candidate' | 'path'
export interface SofficeProbeResult { ok: boolean; path?: string; source?: SofficeSource }

/** 探测缓存 TTL：覆盖「装完 LibreOffice 直接重试」的场景，不必重启应用 */
const CACHE_TTL_MS = 30_000

let cached: SofficeProbeResult | null = null
let cachedAt = 0

/** 未找到 soffice 的提示：必须可操作 —— 只说「装好即可」会把用户卡死（装完不重启就永远找不到，见 TTL 注释） */
const NO_SOFFICE_ERROR = '未找到 LibreOffice（soffice）：已装却仍报错时，多为装在了自定义目录 —— 到「设置 → AI 工具 → 模型 → LibreOffice 路径」手填 soffice.exe 绝对路径（填完立即生效，不必重启）；刚装完也可直接重试，探测缓存 30 秒自动刷新。或改用文本提取（公式已支持 Symbol 还原）'

/** 清空探测缓存（设置页手动重探时调用） */
export function resetSofficeCache(): void {
  cached = null
  cachedAt = 0
}

/** 探测 soffice 可执行文件（带缓存 + TTL）；env/SOFFICE_PATH 便于测试注入 */
export function findSoffice(settingPath?: unknown): string | null {
  // 显式配了路径 = 用户刚在设置页改动，必须立即生效 → 绕过缓存
  if (settingPath) return probeSoffice(settingPath).path ?? null
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached.path ?? null
  cached = probeSoffice(settingPath)
  cachedAt = Date.now()
  return cached.path ?? null
}

/** 实际执行整条探测链（不走缓存）；IPC 手动重探也走这里 */
export function probeSoffice(settingPath?: unknown): SofficeProbeResult {
  const pick = (p: unknown): string | null => {
    if (typeof p === 'string' && p.trim() && existsSync(p.trim())) return p.trim()
    return null
  }

  const fromSetting = pick(settingPath)
  if (fromSetting) return { ok: true, path: fromSetting, source: 'setting' }

  const fromEnv = pick(process.env.SOFFICE_PATH)
  if (fromEnv) return { ok: true, path: fromEnv, source: 'env' }

  const fromRegistry = probeRegistry()
  if (fromRegistry) return { ok: true, path: fromRegistry, source: 'registry' }

  const fromCandidate = CANDIDATES.find(p => p && existsSync(p))
  if (fromCandidate) return { ok: true, path: fromCandidate, source: 'candidate' }

  const fromPath = probeWhere()
  if (fromPath) return { ok: true, path: fromPath, source: 'path' }

  return { ok: false }
}

/**
 * Windows 注册表探测：安装器把 program 目录写进 InstallPath 的默认值（带尾反斜杠）。
 * 三条都试：64 位安装 → HKLM\SOFTWARE\…；32 位安装（64 位系统上）→ WOW6432Node 分支；用户级安装 → HKCU。
 * 编码：reg.exe 按 OEM 代码页输出，中文路径会乱码 → 先 chcp 65001 让 reg 输出 UTF-8，再按 utf8 解码。
 */
/**
 * 解析 `reg query <key> /ve` 的输出，取出 REG_SZ 值（InstallPath = program 目录）。
 * 抽成纯函数是为了可验证：这段静默解析错就会直接表现为「装了 LibreOffice 却找不到」。
 * 典型输出（有缩进，值可能带尾反斜杠）：
 *     (默认)    REG_SZ    D:\tools\LibreOffice\program\
 */
export function parseRegistryInstallPath(out: string): string | null {
  const dir = out.match(/REG_SZ\s+(.+)/)?.[1]?.trim()
  if (!dir) return null
  return dir.endsWith('\\') || dir.endsWith('/') ? dir.slice(0, -1) : dir
}

function probeRegistry(): string | null {
  if (process.platform !== 'win32') return null
  const subKeys = [
    'HKLM\\SOFTWARE\\LibreOffice\\UNO\\InstallPath',
    'HKLM\\SOFTWARE\\WOW6432Node\\LibreOffice\\UNO\\InstallPath',
    'HKCU\\SOFTWARE\\LibreOffice\\UNO\\InstallPath',
  ]
  for (const key of subKeys) {
    try {
      const out = execSync(`chcp 65001 >nul & reg query "${key}" /ve`, {
        timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      }).toString('utf8')
      const dir = parseRegistryInstallPath(out)
      if (!dir) continue
      const exe = join(dir, 'soffice.exe') // join 会规范化路径分隔
      if (existsSync(exe)) return exe
    } catch { /* 键不存在 / reg 被安全策略拦 → 试下一条 */ }
  }
  return null
}

function probeWhere(): string | null {
  try {
    // execSync 场景小（一次 where），同步可接受；spawn 异步版留给转换
    const out = execSync(process.platform === 'win32' ? 'where soffice' : 'which soffice', { timeout: 5000, windowsHide: true }).toString()
    const p = out.split(/\r?\n/)[0]?.trim()
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}

function cacheKey(absPath: string): string {
  const st = statSync(absPath)
  return `${basename(absPath, extname(absPath))}-${st.mtimeMs.toFixed(0)}-${st.size}`
}

/** pptx → pdf（无头转换）。成功返回转换后 PDF 绝对路径；失败/超时/无 soffice 返回 error。 */
export function convertToPdf(absPath: string, settingSofficePath?: unknown): Promise<{ ok: boolean; pdfPath?: string; error?: string }> {
  const exe = findSoffice(settingSofficePath)
  if (!exe) return Promise.resolve({ ok: false, error: NO_SOFFICE_ERROR })
  const dir = join(tmpdir(), 'knowbase-soffice')
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { /* tmp 不可写走 error */ }
  const outPdf = join(dir, `${cacheKey(absPath)}.pdf`)
  if (existsSync(outPdf) && statSync(outPdf).size > 0) return Promise.resolve({ ok: true, pdfPath: outPdf })
  const profileDir = join(dir, 'lo-profile') // 独立 UserInstallation：避免与正在运行的 Office 实例互锁
  return new Promise(resolve => {
    const child = spawn(exe, [
      '--headless', '--norestore', '--convert-to', 'pdf',
      `-env:UserInstallation=${('file:///' + profileDir.replace(/\\/g, '/'))}`,
      '--outdir', dir, absPath,
    ], { windowsHide: true })
    let settled = false
    const finish = (r: { ok: boolean; pdfPath?: string; error?: string }) => { if (!settled) { settled = true; try { child.kill() } catch { /* gone */ } resolve(r) } }
    const timer = setTimeout(() => finish({ ok: false, error: 'LibreOffice 转换超时（>120s），文件可能损坏或被占用' }), 120_000)
    child.on('error', err => { clearTimeout(timer); finish({ ok: false, error: `无法启动 soffice：${err.message}` }) })
    child.on('close', () => {
      clearTimeout(timer)
      // soffice 产物名 = 源文件名；改名进缓存键路径（含同名多版本区分）
      const native = join(dir, `${basename(absPath, extname(absPath))}.pdf`)
      if (existsSync(native)) {
        try {
          if (native !== outPdf) copyFileSync(native, outPdf)
          finish({ ok: true, pdfPath: outPdf })
        } catch (e) { finish({ ok: false, error: `转换产物落盘失败：${(e as Error).message}` }) }
      } else {
        finish({ ok: false, error: 'LibreOffice 转换未产出 PDF（检查文件是否损坏/加密）' })
      }
    })
  })
}
