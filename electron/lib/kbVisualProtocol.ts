import { existsSync, readFileSync, statSync } from 'fs'
import { protocol } from 'electron'
import { getCurrentVault } from './kbStore/vaultContext'
import { isArchivedByManifest } from './kbStore/archivedFilesRepo'
import { rootDirName } from './aiTeachingFolders'
import { WELCOME_DOC_FILENAME } from './kbStore/welcomeDoc'
import { safePathInside } from './pathGuard'

/**
 * kbview:// 协议 —— 仓库内受控 HTML 的沙箱渲染载体，三个白名单入口：
 *
 *  ① AI教学工件栏「示意图渲染」（docs/ai-teaching-artifacts-pane-design.md §4 实修裁决）
 *  ② 仓库根「欢迎.html」（新用户导览页；知识库阅读器内渲染，2026-09-10）
 *  ③ 归档清单内的 html（全类型归档 docs/vault-archive-all-files-design.md §4.3；知识库阅读器内渲染，2026-09-10）
 *
 * 为什么不用 iframe srcDoc：srcdoc 子框架会**继承父文档 CSP**（index.html `script-src 'self'`），
 * 文档脚本与宿主量高脚本全被拦（2026-09-09 实锤 Refused to execute inline script）；
 * blob: 载体又被 sandbox（无 allow-same-origin → opaque origin）拒绝加载。
 * 跨 scheme 正常导航不继承，与既有 plugin:// 同思路。
 *
 * 安全边界（**只放行这三个白名单，其余一律 403**）：
 * - AI教学：仅「AI教学产物根/{...}/*.html」——safePathInside 防穿越 + 前缀与扩展名白名单 + 2MB 上限；
 * - 欢迎页：仅仓库根同名文件（精确相等，不接受子目录同名）+ 4MB 上限；
 * - 归档 html：仅归档清单（archived-files.json）覆盖到的 *.html + 2MB 上限——清单外 html 一律 403，
 *   「归档了才可渲染」由本处收敛（未归档的 html 不能经 kbview 探测）；
 * - 响应头 CSP 锁死网络（default-src 'none'，仅放行内联样式脚本与 data:/blob: 图片——connect-src 'none'
 *   即「沙箱渲染+断外联」档：页面 JS 可跑但 fetch/XHR 全断，无法外传数据），并剥掉文档自带的 CSP meta
 *   （取交集会反噬）；
 * - 渲染侧仍必须配合 iframe sandbox="allow-scripts"（无 allow-same-origin，不透明源拿不到宿主 bridge）。
 */

const VISUAL_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'"
const MAX_VISUAL_BYTES = 2 * 1024 * 1024
/** 欢迎页：自包含整页（含内联样式/脚本），不复用 AI 工件的居中量高壳（那是给示意图用的，会毁掉整页布局） */
const MAX_WELCOME_BYTES = 4 * 1024 * 1024

/** 剥掉文档自带 CSP meta（响应头策略与之取交集会反噬，见 VISUAL_CSP 注释） */
function stripCspMeta(html: string): string {
  return html.replace(/<meta[^>]*http-equiv\s*=\s*["']?\s*content-security-policy\s*["']?[^>]*>/gi, '')
}

/** 基线样式 + 量高/主题/缩放壳（2026-09-09 四修，AI模板居中为所有 kbview:// 渲染的默认行为）：
 *  - 画布铺满 + 内容垂直居中（用户需求）：html{height:100%}、html body{min-height:100%;display:grid;place-items:center}，
 *    所有关键布局属性加 !important 并提升选择器到 `html body`，压过 AI 模板自身 `body{display:block}` / `body{min-height:100vh}` 等常见样板；
 *    grid + place-items:center 让唯一子节点 __kbWrap 在垂直+水平方向居中——内容矮于画布时上下留白对称、内容高于画布时 wrap 自然撑高、内部 overflow 滚动。
 *  - DOMContentLoaded 后把 body 子节点收进 __kbWrap：① 量高改测 wrap 自然高（body min-height:100% 会把 scrollHeight 拉到视口高，污染 fit baseH）；
 *    ② wrap width:100% + max-width:100% 防宽内容横向溢出。
 *  - 主题经 postMessage {__kbArtTheme} 下发；⤢ 放大经 {__kbArtZoom} 对 documentElement 施加 zoom（内容物理放大，横向超出图内拖动）。 */
const SHELL_HEAD = '<style>html{height:100% !important}html,body{margin:0 !important;padding:0 !important}html body{background:transparent !important;color:var(--text-primary,#1f2328) !important;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif !important;min-height:100% !important;display:grid !important;place-items:center !important;overflow:auto !important}</style>'
const SHELL_SCRIPT = [
  '<script>',
  '(function(){',
  'var rep=function(){try{var w=window.__kbWrap||document.body;var h=Math.ceil(w?w.getBoundingClientRect().height:0)||document.documentElement.scrollHeight||0;parent.postMessage({__kbArtH:Math.max(1,Math.min(12000,h)),__kbArtBox:{h:Math.max(1,h),sw:document.documentElement.scrollWidth||0,vw:window.innerWidth||0}},\'*\')}catch(e){}};',
  'document.addEventListener(\'DOMContentLoaded\',function(){try{var b=document.body;if(b&&b.children.length){var wrap=document.createElement(\'div\');wrap.className=\'__kbWrap\';wrap.style.cssText=\'display:block;width:100%;max-width:100%;box-sizing:border-box\';while(b.firstChild){wrap.appendChild(b.firstChild)}b.appendChild(wrap);window.__kbWrap=wrap}try{new ResizeObserver(rep).observe(window.__kbWrap||document.documentElement)}catch(e){}rep();setTimeout(rep,80);setTimeout(rep,400)}catch(e){}});',
  'window.addEventListener(\'message\',function(e){var d=e.data;if(!d)return;if(d.__kbArtTheme){var r=document.documentElement,s=d.__kbArtTheme;for(var k in s){try{r.style.setProperty(k,s[k])}catch(x){}}}',
  'if(typeof d.__kbArtZoom==="number"){var z=Math.max(0.5,Math.min(6,d.__kbArtZoom||1)),r2=document.documentElement;r2.style.zoom=z;r2.style.overflowX=z>1?"auto":"hidden";r2.style.overflowY=z>1?"auto":"hidden";setTimeout(rep,60)}});',
  // v3.1.1 条目11：手动缩放入口——沙箱捕获 Ctrl+滚轮 / Ctrl+=/-/0（iframe 内的输入宿主收不到，必须在这里拦）转报宿主；
  // 宿主换算后经 {__kbArtZoom} 下发，走同一条 zoom 通道（宿主 iframe 元素 zoom 空转，见 ArtHtmlView 头注释）
  'window.addEventListener(\'wheel\',function(e){if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();parent.postMessage({__kbArtZoomWheel:{dy:e.deltaY}},\'*\')},{passive:false});',
  'document.addEventListener(\'keydown\',function(e){if(!(e.ctrlKey||e.metaKey))return;var k=e.key;if(k===\'=\'||k===\'+\'){e.preventDefault();parent.postMessage({__kbArtZoomReq:\'in\'},\'*\')}else if(k===\'-\'||k===\'_\'){e.preventDefault();parent.postMessage({__kbArtZoomReq:\'out\'},\'*\')}else if(k===\'0\'){e.preventDefault();parent.postMessage({__kbArtZoomReq:\'reset\'},\'*\')}},true);',
  'window.addEventListener(\'error\',function(e){parent.postMessage({__kbArtErr:String((e&&e.message)||\'脚本错误\').slice(0,300)},\'*\')});',
  'rep();setTimeout(rep,120);setTimeout(rep,500);parent.postMessage({__kbArtReady:true},\'*\');',
  '})();',
  '<\/script>',
].join('\n')
const SHELL_INJECT = SHELL_HEAD + '\n' + SHELL_SCRIPT

function wrapVisualShell(raw: string): string {
  const src = stripCspMeta(raw)
  if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, m => `${m}\n${SHELL_INJECT}`)
  if (/<html[^>]*>/i.test(src)) return src.replace(/<html[^>]*>/i, m => `${m}\n<head>\n${SHELL_INJECT}\n</head>`)
  return `<!doctype html>\n<html>\n<head>\n${SHELL_INJECT}\n</head>\n<body>\n${src}\n</body>\n</html>`
}

export function registerKbVisualProtocol(getSetting: (key: string) => unknown): void {
  protocol.handle('kbview', async (request) => {
    try {
      const vault = getCurrentVault()
      if (!vault) return new Response('No vault', { status: 503 })
      const url = new URL(request.url)
      if (url.hostname !== 'vault') return new Response('Bad Request', { status: 400 })
      const rel = url.pathname.replace(/^\//, '').split('/').map(s => { try { return decodeURIComponent(s) } catch { return s } }).join('/').replace(/\\/g, '/')
      if (!rel || !/\.html?$/i.test(rel)) return new Response('Forbidden', { status: 403 })

      // ② 欢迎页（仓库根同名精确匹配）：整页原样返回，不注入 AI 工件的居中/量高壳
      if (rel === WELCOME_DOC_FILENAME) {
        const welcomeAbs = safePathInside(vault.rootPath, rel)
        if (!welcomeAbs) return new Response('Forbidden', { status: 403 })
        if (!existsSync(welcomeAbs) || !statSync(welcomeAbs).isFile()) return new Response('Not Found', { status: 404 })
        if (statSync(welcomeAbs).size > MAX_WELCOME_BYTES) return new Response('Too Large', { status: 413 })
        return new Response(stripCspMeta(readFileSync(welcomeAbs, 'utf-8')), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Content-Security-Policy': VISUAL_CSP,
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }

      // ③ 归档清单内的 html（全类型归档）：整页原样返回（同欢迎页，不注入 AI 工件的居中/量高壳）；
      //    CSP 同样锁死网络（断外联档），清单外 html 落到 ① 的前缀校验被 403
      if (isArchivedByManifest(rel)) {
        const abs = safePathInside(vault.rootPath, rel)
        if (!abs) return new Response('Forbidden', { status: 403 })
        if (!existsSync(abs) || !statSync(abs).isFile()) return new Response('Not Found', { status: 404 })
        if (statSync(abs).size > MAX_VISUAL_BYTES) return new Response('Too Large', { status: 413 })
        return new Response(stripCspMeta(readFileSync(abs, 'utf-8')), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Content-Security-Policy': VISUAL_CSP,
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }

      // ① AI 教学工件：仅产物根目录下的 *.html
      const rootDir = rootDirName(getSetting)
      if (rel !== rootDir && !rel.startsWith(`${rootDir}/`)) return new Response('Forbidden: 仅允许渲染 AI教学产物目录', { status: 403 })
      const abs = safePathInside(vault.rootPath, rel)
      if (!abs) return new Response('Forbidden', { status: 403 })
      if (!existsSync(abs) || !statSync(abs).isFile()) return new Response('Not Found', { status: 404 })
      if (statSync(abs).size > MAX_VISUAL_BYTES) return new Response('Too Large', { status: 413 })
      const html = wrapVisualShell(readFileSync(abs, 'utf-8'))
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': VISUAL_CSP,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (e) {
      console.error('[kbview://] handler error:', request.url, e)
      return new Response('Bad Request', { status: 400 })
    }
  })
}
