import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePageStoreBridge } from '../../../lib/pageStoreBridge'

/**
 * 知识库内的「欢迎.html」渲染器（2026-09-10）。
 *
 * 唯一放行 HTML 渲染的知识页：主进程 kbview:// 协议白名单**精确匹配**仓库根同名文件
 * （electron/lib/kbVisualProtocol.ts，响应头 CSP 锁死网络、剥文档自带 CSP meta）。
 * 此处 iframe 保持 sandbox="allow-scripts"——绝不加 allow-same-origin（安全红线同 AI 工件）。
 *
 * 主题（2026-09-10 二次修，跟随软件背景）：
 * - 明暗判定改为**读应用当前 --bg-primary 的相对亮度**。原实现只看 `theme-light` 类名，
 *   「非 theme-light 即成 dark」——插件主题（类名 theme-plugin-*）于是恒被判成深色：
 *   浅色插件主题下页面发黑、与软件背景割裂（实锤：OpenCode 终端灰 --bg-primary #f1ecec）。
 * - 除 ?theme= 定首帧外，再把应用真实的 CSS 变量经 postMessage 下发，页内以行内自定义属性落地，
 *   页面背景/文字/描边/强调色因此等于软件主题的取值（含插件主题），而非固定两套色板。
 * - 切换应用主题 → MutationObserver 重发变量，不重挂 iframe；换 URL 只为兜底与文档重载。
 * 监听 kb-reload-detail（模块激活重读广播）刷新，编辑器里改完欢迎页切回来即见新内容。
 */

/** 应用主题变量 → 欢迎页设计 token 的映射。
 *  右侧取值来自宿主 <html> 上已生效的主题（内置或插件），左侧是页面的设计 token；
 *  未取到就不下发，页面回落到自带的明暗设计色板（独立用浏览器打开时即此路径）。
 *  刻意**不映射** --line/--line-2：它被页面用了 40+ 处细分割线，而应用的 --border-color 是组件描边色
 *  （手绘线条主题 #7a756a 这类偏重），替换后细线会变成重线条。发丝线保持页面自带值更稳。 */
const VAR_MAP: ReadonlyArray<readonly [string, string]> = [
  ['--bg', '--bg-primary'],
  ['--surface', '--card-bg'],
  ['--surface-2', '--bg-secondary'],
  ['--ink', '--text-primary'],
  ['--ink-2', '--text-secondary'],
  ['--ink-3', '--text-muted'],
  ['--accent', '--accent'],
  ['--accent-ink', '--accent'],
  ['--ok', '--success'],
  ['--amber', '--warning'],
  ['--amber-line', '--warning'],
]

function readAppVar(name: string): string {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() } catch { return '' }
}

/** WCAG 相对亮度（0=纯黑, 1=纯白）；解析不了返回 -1（调用方回退类名判断）。
 *  支持 #rgb / #rrggbb / rgb() / rgba()——主题变量在插件里通常是十六进制，内置主题同。 */
function luminance(color: string): number {
  if (!color) return -1
  const c = color.trim()
  const chan = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  let m = /^#([0-9a-f]{3})$/i.exec(c)
  if (m) return chan(...m[1].split('').map(x => parseInt(x + x, 16)) as [number, number, number])
  m = /^#([0-9a-f]{6})$/i.exec(c)
  if (m) {
    const n = parseInt(m[1], 16)
    return chan((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[\s,]+(\d+)/i.exec(c)
  if (m) return chan(+m[1], +m[2], +m[3])
  return -1
}

/** 应用当前主题的明暗：以真实背景色为准（插件主题也正确），解析失败才退回类名约定。 */
function resolveMode(): 'light' | 'dark' {
  const lum = luminance(readAppVar('--bg-primary'))
  if (lum >= 0) return lum > 0.5 ? 'light' : 'dark'
  return document.documentElement.classList.contains('theme-light') ? 'light' : 'dark'
}

export function WelcomeHtmlView({ path }: { path: string }) {
  const [mode, setMode] = useState<'light' | 'dark'>(() => resolveMode())
  const [reloadSeq, setReloadSeq] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)

  // 页面数据桥（docs/html-page-store.md）：页面声明 <meta name="kb-store"> 后即可读写
  // .knowbase/pagesdata/*.json；未声明的页面完全不受影响
  usePageStoreBridge(frameRef, path)

  /** 把应用主题变量下发给沙箱页面（沙箱是不透明源，读不到宿主样式） */
  const pushTheme = useCallback(() => {
    const vars: Record<string, string> = {}
    for (const [to, from] of VAR_MAP) {
      if (vars[to]) continue
      const v = readAppVar(from)
      if (v) vars[to] = v
    }
    // 半透明/柔和底色原设计写死，换主题后会露白露黑或串色 —— 由对应主色派生（Electron 33 = Chromium 130，支持 color-mix）
    if (vars['--bg']) vars['--nav'] = `color-mix(in srgb, ${vars['--bg']} 78%, transparent)`
    if (vars['--accent']) vars['--accent-soft'] = `color-mix(in srgb, ${vars['--accent']} 10%, transparent)`
    if (vars['--ok']) vars['--ok-soft'] = `color-mix(in srgb, ${vars['--ok']} 12%, transparent)`
    if (vars['--amber']) vars['--amber-soft'] = `color-mix(in srgb, ${vars['--amber']} 12%, transparent)`
    try {
      frameRef.current?.contentWindow?.postMessage({ __kbWelcomeTheme: { mode: resolveMode(), vars } }, '*')
    } catch { /* iframe 未就绪，onLoad / ready 握手会补发 */ }
  }, [])

  useEffect(() => {
    const sync = () => { setMode(resolveMode()); pushTheme() }
    // class=内置/插件主题类切换，style=插件主题变量更新，data-theme=外部主题标记
    const mo = new MutationObserver(sync)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    const onReload = () => setReloadSeq(s => s + 1)
    window.addEventListener('kb-reload-detail', onReload)
    return () => { mo.disconnect(); window.removeEventListener('kb-reload-detail', onReload) }
  }, [pushTheme])

  // 沙箱页面脚本就绪后补发一次（不依赖 onLoad 与父文档脚本的执行时序）
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { __kbWelcomeReady?: boolean } | null
      if (d && d.__kbWelcomeReady === true && e.source === frameRef.current?.contentWindow) pushTheme()
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [pushTheme])

  const src = useMemo(() => {
    const seg = path.split('/').map(s => encodeURIComponent(s)).join('/')
    return `kbview://vault/${seg}?theme=${mode}&r=${reloadSeq}`
  }, [path, mode, reloadSeq])

  return (
    <div className="flex-1 min-h-0">
      <iframe
        ref={frameRef}
        key={src}
        src={src}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title="欢迎"
        onLoad={pushTheme}
        className="w-full h-full"
        style={{ border: 'none', display: 'block', background: 'var(--bg-primary)' }}
      />
    </div>
  )
}
