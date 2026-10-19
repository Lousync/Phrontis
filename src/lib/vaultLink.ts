/**
 * 仓库内相对链接解析（纯函数、零依赖）。
 *
 * 用途：把正文里 markdown 的相对链接（`../README.md`、`./sub/a.md`、`a.md#sec`）
 * 按**当前页所在目录**归一成「仓库相对路径」，交给知识库按 path 命中。
 *
 * 2026-10-19 修：知识页的页内链接原先是「按标题猜」，猜不中就交给
 * `window.api.openExternal` —— 主进程按自己的 cwd 解析相对路径，判为 userData 之外并拒绝
 * （控制台 `[Security] Blocked opening path outside data dir`），表象是「点了没反应」。
 * 相对路径**永远不该**交给系统打开：它只在仓库语境里才有意义。
 *
 * 返回 `null` 的四种情况（调用方据此走别的路径，**不要**当成「仓库根」）：
 *   1. 带协议的链接（`http:` / `mailto:` / `kbloc:` …）—— 不是仓库内路径；
 *   2. 纯锚点（`#section`）—— 同页滚动，不需要导航；
 *   3. 绝对路径（`/x.md` 或以分隔符开头）—— 渲染层不接触绝对路径（AGENTS 铁律 3）；
 *   4. `..` 越出了仓库根 —— 越界一律拒绝，不静默夹回根目录。
 */
export function resolveVaultRel(curRelPath: string, href: string): string | null {
  let raw = href.trim()
  if (!raw || raw.startsWith('#')) return null
  // 协议判定放在最前：Windows 盘符（C:）也会命中这条，正好一并拒绝
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  raw = raw.split('#')[0].split('?')[0]
  if (!raw) return null
  try { raw = decodeURIComponent(raw) } catch { /* 编码坏了就按原样，交给后续匹配 */ }
  raw = raw.replace(/\\/g, '/')
  if (raw.startsWith('/')) return null

  const base = curRelPath.replace(/\\/g, '/')
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
  const out: string[] = []
  for (const seg of `${dir ? dir + '/' : ''}${raw}`.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null   // 越界：不夹回根目录，直接判不可解析
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}
