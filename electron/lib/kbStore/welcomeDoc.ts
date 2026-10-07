import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 新仓库欢迎文档（2026-09-08 立项 / 09-09 改版为 HTML / 09-10 采用精修版并接入知识库渲染）：
 * - 仅在仓库「首次初始化」（.knowbase/meta.json 尚不存在）时写入仓库根 欢迎.html
 * - 它是普通用户文件：不登记 SOFT_ENTRY_NAMES、可编辑可删除
 * - 知识库按 HTML 渲染管线展示（kbview:// 协议 + 沙箱 iframe），且**只放行这一个 html**：
 *   knowledgeIndex 扫描器仅收仓库根同名文件，其余 .html 一律不入索引
 * - 09-08~09-09 窗口期建过的仓库可能已有 欢迎.md：视为已欢迎，不重复落 HTML（防双欢迎页）
 * - 自包含：内联 CSS/JS、零外部资源（本地优先，离线可开）
 * - 主题（2026-09-10 二次修）：首帧读 URL ?theme=dark|light 定明暗；宿主随后经 postMessage
 *   {__kbWelcomeTheme:{mode,vars}} 把**应用当前主题的真实 CSS 变量**落到 <html> 行内属性上，
 *   压过 :root / html[data-theme] 声明 —— 背景/文字/描边/强调色随软件主题（含插件主题）一致，
 *   而不是只切固定的明暗两套色板。无消息（独立用浏览器打开）时退化为自带的明暗设计色板。
 * - 写入失败静默跳过（不阻断仓库创建）
 */

export const WELCOME_DOC_FILENAME = '欢迎.html'

/** 预览/校验用：正文以 /*==WELCOME-HTML-START==*\/ 与 END 标记包裹，脚本可据此提取渲染
 *  （tmp/extract-welcome-preview.mjs 生成浏览器预览；注意它会覆盖 tmp/welcome-preview.html） */
export function buildWelcomeDocContent(now = new Date()): string {
  const year = now.getFullYear()
  /*==WELCOME-HTML-START==*/
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>欢迎 · Phrontis</title>
<link rel="icon" type="image/png" href="data:image/png;base64,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">
<script>
(function () {
  var root = document.documentElement;
  /* 首帧明暗：宿主 ?theme=dark|light（沙箱 iframe 读不到宿主主题）；退化：localStorage → 系统偏好。
     只决定明暗是刻意的——它在文档解析前就执行，用来避免首帧闪错色板。 */
  var t = null;
  try { var q = new URLSearchParams(location.search).get('theme'); if (q === 'light' || q === 'dark') t = q; } catch (e) {}
  if (!t) { try { t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { t = 'light'; } }
  try { root.setAttribute('data-theme', t); } catch (e) {}

  /* 宿主主题跟随（2026-09-10 二次修）：接收 {__kbWelcomeTheme:{mode,vars}}。
     mode 写 data-theme（切设计色板与图标）；vars 以**行内自定义属性**落在 <html> 上，
     优先级高于 :root / html[data-theme] 的声明，因此页面背景·文字·描边·强调色 = 应用当前主题的真实取值。
     换了插件主题（类名 theme-plugin-*，无 theme-light）也只走这一条路，不再被误判成深色。 */
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.__kbWelcomeTheme) return;
    var p = d.__kbWelcomeTheme;
    try {
      if (p.mode === 'light' || p.mode === 'dark') root.setAttribute('data-theme', p.mode);
      var vars = p.vars || {};
      for (var k in vars) { try { root.style.setProperty(k, vars[k]); } catch (x) {} }
    } catch (x) {}
  });
  /* 反向握手：脚本（含上面的监听）就绪即告知宿主，宿主收到后补发主题——不依赖 iframe onLoad 时序 */
  try { parent.postMessage({ __kbWelcomeReady: true }, '*'); } catch (e) {}
})();
</script>
<style>
  :root {
    --bg:#f5f5f7; --surface:#ffffff; --surface-2:#fafafa;
    --ink:#1d1d1f; --ink-2:#6e6e73; --ink-3:#8e8e93;
    --line:#e3e3e6; --line-2:#d2d2d7;
    --accent:#0071e3; --accent-ink:#0062cc; --accent-soft:rgba(0,113,227,.08);
    --ok:#248a3d; --ok-soft:rgba(36,138,61,.09);
    --amber:#b25000; --amber-soft:rgba(255,159,10,.12); --amber-line:#ff9f0a;
    --nav:rgba(255,255,255,.72);
    --shadow:0 1px 2px rgba(0,0,0,.04), 0 10px 30px rgba(0,0,0,.06);
    --shadow-lg:0 2px 6px rgba(0,0,0,.05), 0 24px 60px rgba(0,0,0,.10);
    --r:18px;
  }
  html[data-theme="dark"] {
    --bg:#000000; --surface:#1c1c1e; --surface-2:#161617;
    --ink:#f5f5f7; --ink-2:#a1a1a6; --ink-3:#7c7c81;
    --line:#2c2c2e; --line-2:#3a3a3c;
    --accent:#2997ff; --accent-ink:#6cb2ff; --accent-soft:rgba(41,151,255,.13);
    --ok:#30d158; --ok-soft:rgba(48,209,88,.12);
    --amber:#ffd60a; --amber-soft:rgba(255,214,10,.10); --amber-line:#ffd60a;
    --nav:rgba(22,22,23,.72);
    --shadow:0 1px 2px rgba(0,0,0,.5), 0 10px 30px rgba(0,0,0,.45);
    --shadow-lg:0 2px 6px rgba(0,0,0,.5), 0 24px 60px rgba(0,0,0,.6);
  }

  * { box-sizing:border-box; margin:0; padding:0; }
  html { scroll-behavior:smooth; -webkit-text-size-adjust:100%; }
  body {
    background:var(--bg); color:var(--ink);
    font:16px/1.75 -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display",
         "Helvetica Neue", "PingFang SC", "Microsoft YaHei UI", sans-serif;
    -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
    letter-spacing:.01em;
  }
  .wrap { max-width:820px; margin:0 auto; padding:0 28px 120px; }
  section { scroll-margin-top:76px; }
  b, strong { font-weight:600; }
  code {
    font:13px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    color:var(--accent-ink); background:var(--accent-soft);
    border-radius:5px; padding:2px 6px;
  }
  kbd {
    font:12px/1 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    color:var(--ink); background:var(--surface); border:1px solid var(--line-2);
    border-bottom-width:2px; border-radius:6px; padding:4px 7px; white-space:nowrap;
    display:inline-block;
  }
  h1, h2, h3 { letter-spacing:-.022em; font-weight:600; }

  /* ===== 顶部导航 ===== */
  .nav {
    position:sticky; top:0; z-index:60; height:48px;
    background:var(--nav); backdrop-filter:saturate(180%) blur(20px);
    -webkit-backdrop-filter:saturate(180%) blur(20px);
    border-bottom:1px solid var(--line);
    display:flex; align-items:center; gap:18px; padding:0 22px;
  }
  .nav-brand { font-size:13px; font-weight:600; letter-spacing:-.01em; display:inline-flex; align-items:center; gap:6px; }
  .brand-ico { width:16px; height:16px; border-radius:4px; vertical-align:-3px; margin-right:6px; }
  .nav-links { display:flex; gap:4px; margin-left:auto; }
  .nav-links a {
    font:600 11.5px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    color:var(--ink-3); text-decoration:none; padding:6px 9px; border-radius:99px;
    transition:all .2s;
  }
  .nav-links a:hover { color:var(--ink); background:var(--accent-soft); }
  .nav-links a.on { color:var(--accent-ink); background:var(--accent-soft); }
  .icon-btn {
    width:28px; height:28px; border:1px solid var(--line); border-radius:99px;
    background:var(--surface); color:var(--ink-2); cursor:pointer;
    display:grid; place-items:center; transition:all .2s; flex-shrink:0;
  }
  .icon-btn:hover { color:var(--ink); border-color:var(--line-2); }
  .icon-btn svg { width:14px; height:14px; }
  .progress {
    position:fixed; top:0; left:0; height:2px; width:100%; z-index:70;
    background:var(--accent); transform:scaleX(0); transform-origin:0 50%;
  }

  /* ===== 页眉 ===== */
  .hero { position:relative; padding:92px 0 60px; overflow:hidden; }
  .hero::before {
    content:""; position:absolute; top:-160px; left:-80px; width:520px; height:520px;
    background:radial-gradient(circle, var(--accent-soft), transparent 62%);
    filter:blur(10px); pointer-events:none;
    animation:drift 18s ease-in-out infinite alternate;
  }
  @keyframes drift { from{transform:translate3d(0,0,0)} to{transform:translate3d(40px,30px,0)} }
  .kicker {
    font:600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing:.24em; color:var(--accent-ink); margin-bottom:20px;
    display:flex; align-items:center; gap:12px;
  }
  .kicker::after { content:""; flex:1; height:1px; background:linear-gradient(90deg,var(--line-2),transparent); }
  .hero h1 { font-size:clamp(38px,6.2vw,58px); line-height:1.1; letter-spacing:-.03em; }
  .hero h1 em { font-style:normal; color:var(--accent-ink); }
  .lede { margin-top:20px; font-size:16.5px; color:var(--ink-2); max-width:600px; line-height:1.8; }
  .meta { margin-top:26px; display:flex; flex-wrap:wrap; gap:8px; }
  .meta span {
    font-size:12.5px; color:var(--ink-2); background:var(--surface);
    border:1px solid var(--line); border-radius:99px; padding:5px 13px;
  }

  /* ===== 章节 ===== */
  section { padding-top:76px; }
  .sec-head { display:flex; align-items:baseline; gap:14px; margin-bottom:26px; }
  .sec-no { font:600 11.5px/1 ui-monospace, Menlo, monospace; color:var(--accent); letter-spacing:.14em; }
  .sec-title { font-size:26px; letter-spacing:-.02em; }
  .sec-note { font-size:12.5px; color:var(--ink-3); margin-left:auto; white-space:nowrap; }
  @media (max-width:640px) { .sec-note { display:none; } }

  /* 01 三句话 */
  .laws { display:flex; flex-direction:column; gap:12px; }
  .law {
    display:flex; gap:18px; padding:22px 24px; background:var(--surface);
    border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow);
    transition:transform .25s, box-shadow .25s, border-color .25s;
  }
  .law:hover { transform:translateY(-2px); box-shadow:var(--shadow-lg); border-color:var(--line-2); }
  .law-i {
    font:600 13px/1 ui-monospace, Menlo, monospace; color:var(--accent);
    width:26px; padding-top:5px; flex-shrink:0;
  }
  .law b { display:block; font-size:16px; margin-bottom:5px; letter-spacing:-.01em; }
  .law p { font-size:14px; color:var(--ink-2); line-height:1.78; }
  .tree {
    margin-top:12px; font:12px/1.9 ui-monospace, SFMono-Regular, Menlo, monospace;
    color:var(--ink-3); background:var(--surface-2); border:1px solid var(--line);
    border-radius:10px; padding:12px 14px;
  }
  .tree .dim { color:var(--ink-3); opacity:.75; }
  .tree .tag { color:var(--amber); }
  .tree b { color:var(--ink-2); font-weight:600; }

  /* 02 演示播放器 */
  .demo {
    background:var(--surface); border:1px solid var(--line); border-radius:var(--r);
    box-shadow:var(--shadow); overflow:hidden;
  }
  .demo-bar {
    height:44px; display:flex; align-items:center; gap:10px; padding:0 12px;
    background:var(--surface-2); border-bottom:1px solid var(--line);
  }
  .dots3 { display:flex; gap:5px; }
  .dots3 i { width:9px; height:9px; border-radius:50%; background:var(--line-2); }
  .dtabs { display:flex; gap:2px; margin-left:8px; }
  .dtab {
    font-size:12.5px; color:var(--ink-3); background:none; border:none; cursor:pointer;
    padding:5px 12px; border-radius:99px; transition:all .2s; font-family:inherit;
  }
  .dtab:hover { color:var(--ink); }
  .dtab.on { color:var(--accent-ink); background:var(--accent-soft); font-weight:600; }
  .demo-name { font-size:11.5px; color:var(--ink-3); margin-left:10px; }
  .demo-bar .icon-btn { margin-left:auto; }

  .stage { position:relative; height:266px; background:var(--surface); }
  .pane {
    position:absolute; inset:0; opacity:0; pointer-events:none;
    transition:opacity .35s ease; display:flex;
  }
  .pane.on { opacity:1; }

  /* 迷你文件树 */
  .m-tree {
    width:172px; flex-shrink:0; border-right:1px solid var(--line);
    padding:14px 10px; background:var(--surface-2);
  }
  .m-tree h4 {
    font:600 10.5px/1 ui-monospace, Menlo, monospace; letter-spacing:.1em;
    color:var(--ink-3); padding:0 6px 10px;
  }
  .m-row {
    display:flex; align-items:center; gap:7px; font-size:12px; color:var(--ink-2);
    padding:5px 7px; border-radius:6px;
  }
  .m-row svg { width:12px; height:12px; flex-shrink:0; opacity:.7; }
  .m-row.dim { color:var(--ink-3); opacity:.8; }
  .m-row.new { background:var(--accent-soft); color:var(--accent-ink); font-weight:600; }
  .m-row.new svg { opacity:1; }
  .m-row.hidden { opacity:0; transform:translateX(-6px); transition:all .35s; }
  .m-row.hidden.show { opacity:1; transform:none; }

  .m-editor { flex:1; position:relative; padding:26px 28px; }
  .m-title { font-size:19px; font-weight:600; letter-spacing:-.02em; margin-bottom:14px; }
  .m-body { font-size:13.5px; color:var(--ink-2); line-height:2; min-height:76px; }
  .m-body .link { color:var(--accent-ink); background:var(--accent-soft); border-radius:4px; padding:1px 4px; }
  .caret {
    display:inline-block; width:1.5px; height:15px; background:var(--accent);
    vertical-align:-2px; animation:blink 1s steps(2) infinite;
  }
  @keyframes blink { 50% { opacity:0; } }
  .m-save {
    position:absolute; right:20px; bottom:18px; font-size:11px; color:var(--ok);
    background:var(--ok-soft); border:1px solid transparent; border-radius:99px;
    padding:4px 11px; opacity:0; transform:translateY(4px); transition:all .35s;
  }
  .m-save.on { opacity:1; transform:none; }
  .m-menu {
    position:absolute; left:60px; top:96px; width:132px; background:var(--surface);
    border:1px solid var(--line-2); border-radius:10px; box-shadow:var(--shadow-lg);
    padding:5px; opacity:0; transform:scale(.96); transform-origin:top left;
    transition:all .22s cubic-bezier(.2,.8,.3,1);
  }
  .m-menu.on { opacity:1; transform:none; }
  .m-mi { font-size:12px; color:var(--ink-2); padding:6px 9px; border-radius:6px; }
  .m-mi.hi { background:var(--accent); color:#fff; font-weight:600; }

  /* 迷你笔记列表 */
  .m-kb { flex:1; padding:20px 24px; }
  .m-kb h4 {
    font:600 11px/1 ui-monospace, Menlo, monospace; letter-spacing:.1em;
    color:var(--ink-3); margin-bottom:14px; display:flex; align-items:center; gap:8px;
  }
  .m-kb h4 span { font-weight:400; letter-spacing:0; }
  .m-page {
    display:flex; align-items:center; gap:10px; font-size:13.5px; color:var(--ink-2);
    padding:13px 16px; border:1px solid var(--line); border-radius:12px; margin-bottom:9px;
    background:var(--surface-2);
  }
  .m-page.new {
    opacity:0; transform:translateY(10px);
    border-color:var(--accent); background:var(--accent-soft);
  }
  .m-page.new.in { animation:pop .5s cubic-bezier(.2,.8,.3,1) forwards; }
  @keyframes pop { to { opacity:1; transform:none; } }
  .pill {
    margin-left:auto; font-size:10.5px; font-weight:600; padding:3px 9px; border-radius:99px;
    background:var(--surface); border:1px solid var(--line-2); color:var(--ink-3);
  }
  .pill.ok { color:var(--ok); background:var(--ok-soft); border-color:transparent; }

  /* 迷你图谱 */
  .m-graph { flex:1; display:grid; place-items:center; }
  .m-graph svg { width:100%; max-width:400px; height:auto; }
  .g-link {
    fill:none; stroke:var(--accent); stroke-width:1.4; opacity:.55;
    stroke-dasharray:300; stroke-dashoffset:300;
  }
  .g-node { fill:var(--surface); stroke:var(--accent); stroke-width:1.6; opacity:0; transform:scale(.4); transform-box:fill-box; transform-origin:center; }
  .g-label { fill:var(--ink-2); font-size:9px; text-anchor:middle; opacity:0; }
  .play .g-link { animation:draw .8s ease forwards; }
  .play .g-node { animation:popn .45s cubic-bezier(.2,.9,.3,1.3) forwards; }
  .play .g-label { animation:fadein .4s ease forwards; }
  @keyframes draw { to { stroke-dashoffset:0; } }
  @keyframes popn { to { opacity:1; transform:scale(1); } }
  @keyframes fadein { to { opacity:1; } }

  .demo-foot {
    padding:14px 18px 16px; border-top:1px solid var(--line); background:var(--surface-2);
    display:flex; align-items:center; gap:16px;
  }
  .demo-dots { display:flex; gap:6px; flex-shrink:0; }
  .demo-dots button {
    width:22px; height:22px; border-radius:50%; border:1px solid var(--line-2);
    background:var(--surface); color:var(--ink-3); cursor:pointer;
    font:600 10.5px/1 ui-monospace, Menlo, monospace; transition:all .2s; padding:0;
  }
  .demo-dots button:hover { border-color:var(--accent); color:var(--accent); }
  .demo-dots button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
  .demo-cap { font-size:13px; color:var(--ink-2); line-height:1.65; }

  /* 步骤文字 */
  .steps { list-style:none; margin-top:30px; counter-reset:s; }
  .steps li { position:relative; padding:0 0 18px 34px; counter-increment:s; font-size:14.5px; }
  .steps li::before {
    content:counter(s); position:absolute; left:0; top:3px; width:21px; height:21px;
    border-radius:50%; background:var(--accent-soft); color:var(--accent-ink);
    font:600 11.5px/21px ui-monospace, Menlo, monospace; text-align:center;
  }
  .steps b { font-weight:600; }
  .steps .d { display:block; font-size:13.5px; color:var(--ink-2); margin-top:2px; line-height:1.72; }

  /* 上手清单 */
  .checklist {
    margin-top:26px; background:var(--surface); border:1px solid var(--line);
    border-radius:var(--r); padding:22px 24px; box-shadow:var(--shadow);
  }
  .cl-head { display:flex; align-items:center; gap:12px; margin-bottom:8px; }
  .cl-head b { font-size:15px; }
  .ring { margin-left:auto; position:relative; width:34px; height:34px; flex-shrink:0; }
  .ring svg { width:34px; height:34px; transform:rotate(-90deg); }
  .ring circle { fill:none; stroke-width:3; }
  .ring .bg { stroke:var(--line); }
  .ring .fg { stroke:var(--accent); stroke-linecap:round; transition:stroke-dashoffset .45s cubic-bezier(.2,.8,.3,1); }
  .ring span {
    position:absolute; inset:0; display:grid; place-items:center;
    font:600 10px/1 ui-monospace, Menlo, monospace; color:var(--accent-ink);
  }
  .cl-sub { font-size:12.5px; color:var(--ink-3); margin-bottom:6px; }
  .checklist label {
    display:flex; gap:12px; align-items:flex-start; padding:9px 0;
    font-size:14px; color:var(--ink-2); cursor:pointer; transition:color .2s;
    border-top:1px solid var(--line);
  }
  .checklist label:hover { color:var(--ink); }
  .checklist input {
    appearance:none; -webkit-appearance:none; width:18px; height:18px; flex-shrink:0;
    margin-top:4px; border:1.5px solid var(--line-2); border-radius:6px;
    background:var(--surface); cursor:pointer; position:relative; transition:all .2s;
  }
  .checklist input:checked { background:var(--accent); border-color:var(--accent); }
  .checklist input:checked::after {
    content:""; position:absolute; left:5px; top:1.5px; width:5px; height:9px;
    border:solid #fff; border-width:0 2px 2px 0; transform:rotate(45deg);
  }
  .checklist input:checked ~ s { color:var(--ink-3); text-decoration:line-through; }
  .checklist.done .cl-sub { color:var(--ok); font-weight:600; }
  .cl-foot { font-size:11.5px; color:var(--ink-3); margin-top:12px; line-height:1.7; }
  .cl-foot .no-js { display:none; }
  body.no-storage .cl-foot .no-js { display:inline; }

  /* 03 AI */
  .ai-stack { display:flex; flex-direction:column; gap:16px; }
  .ai-panel {
    background:var(--surface); border:1px solid var(--line); border-radius:var(--r);
    padding:24px 26px; box-shadow:var(--shadow);
  }
  .ai-panel h3 { font-size:17px; display:flex; align-items:center; gap:9px; }
  .ai-tag {
    font:600 10.5px/1 ui-monospace, Menlo, monospace; color:var(--accent-ink);
    background:var(--accent-soft); border-radius:99px; padding:4px 10px; margin-left:auto;
    white-space:nowrap;
  }
  .ai-moto { font-size:13.5px; color:var(--ink-2); margin:6px 0 16px; line-height:1.7; }
  .ai-panel ol { list-style:none; counter-reset:ai; }
  .ai-panel ol li { counter-increment:ai; position:relative; padding:0 0 12px 32px; font-size:13.5px; color:var(--ink-2); line-height:1.72; }
  .ai-panel ol li:last-child { padding-bottom:0; }
  .ai-panel ol li::before {
    content:counter(ai); position:absolute; left:0; top:2px; width:20px; height:20px;
    border-radius:50%; background:var(--accent-soft); color:var(--accent-ink);
    font:600 11px/20px ui-monospace, Menlo, monospace; text-align:center;
  }
  .ai-panel ol b { color:var(--ink); }
  .ai-foot {
    margin-top:16px; padding-top:14px; border-top:1px solid var(--line);
    font-size:12.5px; color:var(--ink-3); line-height:1.75;
  }

  /* 演示窗口 */
  .demo.sub { margin-top:20px; }
  .stage.tall { height:322px; }
  .bubble { font-size:12px; line-height:1.7; padding:9px 12px; border-radius:13px; max-width:96%; }
  .bubble.me { align-self:flex-end; background:var(--accent); color:#fff; border-bottom-right-radius:5px; }
  .bubble.ai { background:var(--surface-2); border:1px solid var(--line); color:var(--ink-2); border-bottom-left-radius:5px; min-height:36px; }
  .lnk {
    margin-top:12px; font-size:12px; color:var(--accent-ink); background:none; border:none;
    cursor:pointer; padding:0; font-family:inherit; display:inline-flex; align-items:center; gap:5px;
  }
  .lnk:hover { text-decoration:underline; }

  /* 屏幕骨架：活动栏 + 主区 */
  .scr { position:absolute; inset:0; display:flex; }
  .scr-rail {
    width:40px; flex-shrink:0; border-right:1px solid var(--line); background:var(--surface-2);
    display:flex; flex-direction:column; align-items:center; gap:11px; padding:14px 0;
  }
  .scr-rail i { width:17px; height:17px; border-radius:5px; background:var(--line-2); opacity:.6; }
  .scr-rail i.on { background:var(--accent); opacity:1; }
  .scr-main { flex:1; min-width:0; padding:15px 20px; display:flex; flex-direction:column; }
  .scr-h {
    font:600 10.5px/1 ui-monospace, Menlo, monospace; letter-spacing:.08em; color:var(--ink-3);
    margin-bottom:12px; display:flex; align-items:center; gap:8px; flex-shrink:0;
  }
  .scr-h .ctx-tag {
    letter-spacing:0; color:var(--accent-ink); background:var(--accent-soft);
    border-radius:99px; padding:4px 9px; opacity:0; transform:translateY(-3px);
    transition:all .35s; font-weight:600;
  }
  .scr-h .ctx-tag.on { opacity:1; transform:none; }
  .scr-doc h5 { font-size:15px; margin-bottom:9px; letter-spacing:-.01em; }
  .scr-doc p { font-size:11.5px; color:var(--ink-3); line-height:1.95; margin-bottom:7px; }
  .scr-doc p.hl { color:var(--ink-2); }

  /* AI 助手侧栏 */
  .scr-ai {
    width:216px; flex-shrink:0; border-left:1px solid var(--line); background:var(--surface-2);
    padding:13px; display:flex; flex-direction:column; gap:8px;
    transform:translateX(105%); opacity:0;
    transition:transform .5s cubic-bezier(.2,.8,.3,1), opacity .4s;
  }
  .scr-ai.in { transform:none; opacity:1; }
  .scr-ai-h { font-size:12px; font-weight:600; display:flex; align-items:center; gap:8px; flex-shrink:0; }
  .scr-ai-h span {
    font:600 9.5px/1 ui-monospace, Menlo, monospace; color:var(--accent-ink);
    background:var(--accent-soft); border-radius:99px; padding:4px 7px; margin-left:auto;
  }
  .scr-ai .bubble { opacity:0; transition:opacity .35s; }
  .scr-ai .bubble.on { opacity:1; }
  .scr-ai .audit {
    margin-top:auto; font-size:10.5px; color:var(--ink-3); border-top:1px solid var(--line);
    padding-top:8px; opacity:0; transition:opacity .4s;
  }
  .scr-ai .audit.on { opacity:1; }

  /* AI 教学三栏 */
  .t-side {
    width:130px; flex-shrink:0; border-right:1px solid var(--line);
    background:var(--surface-2); padding:12px 9px;
  }
  .t-side-h {
    font:600 10px/1 ui-monospace, Menlo, monospace; letter-spacing:.1em;
    color:var(--ink-3); padding:0 5px 10px;
  }
  .t-ws { font-size:11.5px; font-weight:600; color:var(--ink-2); padding:6px 8px; border-radius:7px; transition:all .3s; }
  .t-ws.hot { background:var(--accent-soft); color:var(--accent-ink); }
  .t-ses { font-size:11px; color:var(--ink-3); padding:5px 8px 5px 17px; border-radius:6px; transition:all .3s; }
  .t-ses.hot { color:var(--ink); background:var(--surface); border:1px solid var(--line); padding:4px 7px 4px 16px; }
  .t-main { flex:1; min-width:0; padding:13px 15px; display:flex; flex-direction:column; gap:10px; }
  .t-req {
    display:flex; align-items:center; gap:9px; font-size:11.5px; background:var(--surface-2);
    border:1px solid var(--line); border-radius:9px; padding:8px 11px; flex-shrink:0;
  }
  .t-req b { color:var(--ink-3); font-weight:600; flex-shrink:0; font-size:11px; }
  .t-req em { font-style:normal; color:var(--ink-2); }
  .t-main .bubble { align-self:flex-start; max-width:100%; }
  .t-mat {
    width:156px; flex-shrink:0; border-left:1px solid var(--line);
    background:var(--surface-2); padding:12px 11px; display:flex; flex-direction:column; gap:7px;
  }
  .t-mat-h {
    font:600 10px/1 ui-monospace, Menlo, monospace; letter-spacing:.1em; color:var(--ink-3);
    display:flex; align-items:center; margin-bottom:2px;
  }
  .t-mat-h .plus {
    margin-left:auto; width:17px; height:17px; border-radius:50%; border:1px solid var(--line-2);
    display:grid; place-items:center; font:11px/1 sans-serif; color:var(--ink-3);
  }
  .t-mat-h .plus.hot { background:var(--accent); border-color:var(--accent); color:#fff; }
  .chip {
    font-size:10.5px; color:var(--ink-2); background:var(--surface);
    border:1px solid var(--line-2); border-radius:8px; padding:5px 8px;
    opacity:0; transform:translateY(6px); transition:all .4s;
  }
  .chip.in { opacity:1; transform:none; }
  .chip b { font:600 10px ui-monospace, Menlo, monospace; color:var(--accent-ink); margin-left:4px; }
  .t-ring { margin-top:6px; display:flex; align-items:center; gap:8px; font-size:10.5px; color:var(--ink-3); }
  .t-ring svg { width:30px; height:30px; transform:rotate(-90deg); flex-shrink:0; }
  .t-ring circle { fill:none; stroke-width:3; }
  .t-ring .bg { stroke:var(--line); }
  .t-ring .fg { stroke:var(--accent); stroke-linecap:round; transition:stroke-dashoffset .9s cubic-bezier(.2,.8,.3,1); }
  .t-out {
    margin-top:auto; font:10.5px/1.6 ui-monospace, Menlo, monospace; color:var(--ok);
    background:var(--ok-soft); border:1px solid transparent; border-radius:8px; padding:8px 9px;
    opacity:0; transform:translateY(6px); transition:all .45s;
  }
  .t-out.in { opacity:1; transform:none; }
  @media (max-width:620px) {
    .stage.tall { height:360px; }
    .t-side { display:none; }
  }

  /* 04 模块 */
  .mods { display:grid; grid-template-columns:1fr 1fr; gap:11px; }
  @media (max-width:600px) { .mods { grid-template-columns:1fr; } }
  .mod {
    display:flex; gap:13px; padding:16px 18px; background:var(--surface);
    border:1px solid var(--line); border-radius:14px;
    transition:transform .22s, box-shadow .22s, border-color .22s;
  }
  .mod:hover { transform:translateY(-2px); box-shadow:var(--shadow); border-color:var(--line-2); }
  .mod .ic-wrap {
    width:30px; height:30px; border-radius:9px; background:var(--accent-soft);
    color:var(--accent-ink); display:grid; place-items:center; flex-shrink:0;
  }
  .mod .ic-wrap svg { width:16px; height:16px; }
  .mod b { display:block; font-size:14px; margin-bottom:2px; }
  .mod span { display:block; font-size:12.5px; color:var(--ink-2); line-height:1.65; }

  /* 05 提醒 */
  .notes { display:flex; flex-direction:column; gap:12px; }
  .note {
    border-radius:14px; padding:18px 22px; font-size:13.5px; color:var(--ink-2);
    line-height:1.85; border-left:3px solid;
  }
  .note b { color:var(--ink); display:block; margin-bottom:3px; font-size:14.5px; }
  .note.amber { background:var(--amber-soft); border-color:var(--amber-line); }
  .note.blue { background:var(--accent-soft); border-color:var(--accent); }
  .note.green { background:var(--ok-soft); border-color:var(--ok); }

  /* 快捷键 */
  .keys { display:grid; grid-template-columns:repeat(3,1fr); gap:11px; margin-top:4px; }
  @media (max-width:640px) { .keys { grid-template-columns:1fr; } }
  .key {
    background:var(--surface); border:1px solid var(--line); border-radius:14px;
    padding:16px 18px; cursor:pointer; text-align:left; font-family:inherit;
    transition:transform .22s, box-shadow .22s, border-color .22s; color:inherit;
  }
  .key:hover { transform:translateY(-2px); box-shadow:var(--shadow); border-color:var(--accent); }
  .key .kc { display:flex; gap:4px; }
  .key b { display:block; font-size:14px; margin:9px 0 3px; }
  .key span { font-size:12.5px; color:var(--ink-2); line-height:1.6; display:block; }

  /* 快捷键浮层 */
  .ov { position:fixed; inset:0; z-index:90; pointer-events:none; }
  .ov-card {
    position:absolute; background:var(--surface); border:1px solid var(--line-2);
    border-radius:14px; box-shadow:var(--shadow-lg); padding:16px 20px;
    font-size:13px; color:var(--ink-2); opacity:0; transition:all .35s cubic-bezier(.2,.8,.3,1);
  }
  .ov-card b { display:block; color:var(--ink); font-size:14px; margin-bottom:4px; }
  .ov-card .kc { display:flex; gap:4px; margin-bottom:10px; }
  .ov.show-n .c-n { opacity:1; left:50%; top:34%; transform:translate(-50%,-10px); }
  .ov.show-j .c-j { opacity:1; right:22px; top:70px; bottom:22px; width:300px; }
  .ov.show-p .c-p { opacity:1; left:50%; top:64px; width:min(460px,88vw); transform:translateX(-50%); }
  .c-n { left:50%; top:38%; transform:translate(-50%,0); }
  .c-j { right:0; top:70px; bottom:22px; width:300px; }
  .c-p { left:50%; top:40px; width:min(460px,88vw); transform:translateX(-50%); }
  .c-p .row {
    display:flex; align-items:center; gap:9px; padding:7px 9px; border-radius:7px;
    font-size:12.5px; color:var(--ink-2);
  }
  .c-p .row.hi { background:var(--accent); color:#fff; font-weight:600; }
  .c-p .row.hi small { color:rgba(255,255,255,.8); }
  .c-p .row small { margin-left:auto; font-size:11px; color:var(--ink-3); }
  .c-j .ai-line { background:var(--surface-2); border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin-top:10px; }

  /* 出场动画 */
  .reveal { opacity:0; transform:translateY(16px); transition:opacity .8s cubic-bezier(.22,.61,.36,1), transform .8s cubic-bezier(.22,.61,.36,1); }
  .reveal.in { opacity:1; transform:none; }

  footer {
    margin-top:84px; padding-top:30px; border-top:1px solid var(--line);
    font-size:13px; color:var(--ink-3); line-height:2;
  }
  footer .sig {
    font:600 10.5px/1 ui-monospace, Menlo, monospace; letter-spacing:.2em;
    color:var(--line-2); margin-top:14px;
  }
  @media (prefers-reduced-motion:reduce) {
    * { animation-duration:.001s !important; transition-duration:.001s !important; }
    html { scroll-behavior:auto; }
  }
</style>
</head>
<body>

<div class="progress" id="prog"></div>

<nav class="nav">
  <span class="nav-brand"><img class="brand-ico" alt="" src="data:image/png;base64,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">Phrontis · 欢迎</span>
  <div class="nav-links">
    <a href="#laws">01</a><a href="#loop">02</a><a href="#ai">03</a>
    <a href="#mods">04</a><a href="#notes">05</a><a href="#keys">06</a>
  </div>
</nav>

<div class="wrap">

  <header class="hero">
    <div class="kicker">PHRONTIS · 本地优先的个人知识系统</div>
    <h1>欢迎来到<br><em>你自己的仓库</em></h1>
    <p class="lede">
      这是 Phrontis 为你生成的第一份文件，读完大约 3 分钟。它和一篇普通笔记没有任何区别——
      你可以改写它、删掉它，应用的一切功能都不会受影响。
    </p>
    <div class="meta">
      <span>约 3 分钟</span>
      <span>进度只存在本机</span>
      <span>随时可改写或删除</span>
    </div>
  </header>

  <!-- 01 -->
  <section id="laws" class="reveal">
    <div class="sec-head"><span class="sec-no">01</span><h2 class="sec-title">先记住三句话</h2><span class="sec-note">理解了它们，就不会卡住</span></div>
    <div class="laws">
      <div class="law"><span class="law-i">Ⅰ</span><div>
        <b>仓库就是一个普通文件夹</b>
        <p>所有内容都是文件夹里的文件，用任何编辑器都能直接打开——没有私有格式锁定，数据永远是你的。</p>
      </div></div>
      <div class="law"><span class="law-i">Ⅱ</span><div>
        <b>写和读，都在笔记区</b>
        <p>笔记区读写一体：新建一篇直接写（Monaco 编辑器 + 自动保存），同一篇页面转身就是阅读视图——标签、双链、反链、图谱也都在这里，不用在两个模块之间搬内容。</p>
      </div></div>
      <div class="law"><span class="law-i">Ⅲ</span><div>
        <b>以 . 开头的文件夹是软件的地盘</b>
        <p><code>.knowbase/</code> 存书签、日程等结构化数据，<code>.attachments/</code> 是插图附件区。请不要手工改动；整个仓库搬家时它们跟着走就行。</p>
        <div class="tree">
          <div><b>我的仓库/</b></div>
          <div>├─ 我的第一篇笔记.md</div>
          <div>├─ AI教学/</div>
          <div>├─ <span class="dim">.knowbase/</span> <span class="tag">← 别手动改</span></div>
          <div>└─ <span class="dim">.attachments/</span> <span class="tag">← 插图区</span></div>
        </div>
      </div></div>
    </div>
  </section>

  <!-- 02 -->
  <section id="loop" class="reveal">
    <div class="sec-head"><span class="sec-no">02</span><h2 class="sec-title">十分钟跑通第一圈</h2><span class="sec-note">走完一遍，软件就是你的了</span></div>

    <div class="demo" id="demo">
      <div class="demo-bar">
        <div class="dots3"><i></i><i></i><i></i></div>
        <div class="dtabs">
          <button class="dtab on" data-view="editor">笔记 · 写</button>
          <button class="dtab" data-view="kb">列表 · 读</button>
          <button class="dtab" data-view="graph">图谱</button>
        </div>
        <button class="icon-btn" id="demoPlay" title="播放 / 暂停">
          <svg id="icPause" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5v14M15 5v14"/></svg>
          <svg id="icPlay" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M8 5.5v13l11-6.5z"/></svg>
        </button>
      </div>

      <div class="stage">
        <div class="pane on" data-pane="editor">
          <aside class="m-tree">
            <h4>我的仓库</h4>
            <div class="m-row"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 1h4l2 2v8H3z"/></svg>读书笔记.md</div>
            <div class="m-row"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 1h4l2 2v8H3z"/></svg>周计划.md</div>
            <div class="m-row new hidden" id="treeNew"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 1h4l2 2v8H3z"/></svg>我的第一篇.md</div>
            <div class="m-row dim"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1 3h10v7H1z"/></svg>.knowbase/</div>
          </aside>
          <div class="m-editor">
            <div class="m-title">我的第一篇笔记</div>
            <div class="m-body"><span id="typeBox"></span><span class="caret" id="caret"></span></div>
            <div class="m-save" id="savePill">已自动保存</div>
          </div>
        </div>

        <div class="pane" data-pane="kb">
          <div class="m-kb">
            <h4>笔记列表 <span id="kbCount">2 个页面</span></h4>
            <div class="m-page">读书笔记 <span class="pill ok">正式页</span></div>
            <div class="m-page">周计划 <span class="pill ok">正式页</span></div>
            <div class="m-page new" id="kbNew">我的第一篇笔记 <span class="pill ok" id="kbPill">已入列</span></div>
          </div>
        </div>

        <div class="pane" data-pane="graph">
          <div class="m-graph">
            <svg viewBox="0 0 300 200" id="graph">
              <g class="g-links" id="gLinks"></g>
                <g class="g-nodes" id="gNodes"></g>
                <g class="g-labels" id="gLabels"></g>
              </svg>
          </div>
        </div>
      </div>

      <div class="demo-foot">
        <div class="demo-dots" id="dots">
          <button data-i="0" class="on">1</button><button data-i="1">2</button>
          <button data-i="2">3</button><button data-i="3">4</button>
        </div>
        <p class="demo-cap" id="cap"></p>
      </div>
    </div>

    <ol class="steps">
      <li><b>新建，直接写</b><span class="d">笔记区按 <kbd>Ctrl</kbd>+<kbd>N</kbd>（或文件树「＋」）——新建即入列，不用归档；写完不用按保存，它自动保存。</span></li>
      <li><b>整理它</b><span class="d">贴标签、加星标、建分类目录——把笔记拖进目录就算归类。</span></li>
      <li><b>连上第一根线</b><span class="d">写第二篇，正文里打 <code>[[第一篇的标题]]</code> 建立双链。</span></li>
      <li><b>去图谱看它</b><span class="d">双链会把笔记连成一张网，图谱里节点可以拖着玩。</span></li>
    </ol>

    <div class="checklist" id="cl">
      <div class="cl-head">
        <b>上手清单</b>
        <div class="ring">
          <svg viewBox="0 0 34 34"><circle class="bg" cx="17" cy="17" r="14"/><circle class="fg" id="ringFg" cx="17" cy="17" r="14"/></svg>
          <span id="ringTxt">0/7</span>
        </div>
      </div>
      <div class="cl-sub" id="clSub">勾完这 7 件事，你就出师了</div>
      <label><input type="checkbox" data-cl="a"><s style="text-decoration:none">在笔记区按 <kbd>Ctrl</kbd>+<kbd>N</kbd> 写下第一篇笔记</s></label>
      <label><input type="checkbox" data-cl="b"><s style="text-decoration:none">建出第一条双链，去图谱看一眼连线</s></label>
      <label><input type="checkbox" data-cl="c"><s style="text-decoration:none">把一本 PDF 拖进书架，划选一段试试「AI 讲题 / 翻译」</s></label>
      <label><input type="checkbox" data-cl="d"><s style="text-decoration:none">导出一次 ZIP 备份，知道恢复方法是「把备份包拖进窗口」</s></label>
      <label><input type="checkbox" data-cl="e"><s style="text-decoration:none">在任意界面按 <kbd>Ctrl</kbd>+<kbd>J</kbd>，问 AI 助手一个当前页面的问题</s></label>
      <label><input type="checkbox" data-cl="f"><s style="text-decoration:none">去 AI 教学登记一份真实资料（PDF 标页码区间），让它讲第一节</s></label>
      <label><input type="checkbox" data-cl="g"><s style="text-decoration:none">记住万能键 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>：找不到功能，就搜功能</s></label>
      <div class="cl-foot">勾选只存在这台电脑的本机，不会改动这份文件。<span class="no-js">（当前环境不允许本机存储，勾选仅本次浏览有效。）</span></div>
    </div>
  </section>

  <!-- 03 -->
  <section id="ai" class="reveal">
    <div class="sec-head"><span class="sec-no">03</span><h2 class="sec-title">两位 AI 伙伴</h2><span class="sec-note">配置一次，到处好用</span></div>
    <div class="ai-stack">

      <div class="ai-panel">
        <h3>AI 助手<span class="ai-tag">Ctrl+J</span></h3>
        <p class="ai-moto">读任何东西时随手唤起侧栏，边看边问——它带着你正在读的内容回答。</p>
        <ol>
          <li><b>配模型</b>：设置 → AI 工具，选本地 Ollama（离线免费）或在线 API；装过 CC Switch 可一键导入。</li>
          <li><b>唤起提问</b>：任何模块按 <kbd>Ctrl</kbd>+<kbd>J</kbd>，右栏滑出 AI 侧栏，自动带上当前页面；点 <kbd>⤢</kbd> 扩大成中间宽版对话。</li>
          <li><b>喂它上下文</b>：输入 <code>@</code> 引用仓库里的笔记；开着「感知模式」，它还会自动检索相关笔记作素材，回答带脚注可溯源。</li>
          <li><b>让它动手</b>：搜索笔记、读文件、整理内容——每次工具调用都有审计记录可回看。</li>
        </ol>

        <div class="demo sub" id="demoAi">
          <div class="demo-bar">
            <div class="dots3"><i></i><i></i><i></i></div>
            <span class="demo-name">笔记 · 读一篇</span>
            <button class="icon-btn" id="aiPlay" title="播放 / 暂停">
              <svg id="aiIcPause" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5v14M15 5v14"/></svg>
              <svg id="aiIcPlay" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M8 5.5v13l11-6.5z"/></svg>
            </button>
          </div>
          <div class="stage tall">
            <div class="scr">
              <div class="scr-rail"><i></i><i class="on"></i><i></i><i></i><i></i></div>
              <div class="scr-main">
                <div class="scr-h">笔记 › 虚拟内存 <span class="ctx-tag" id="ctxTag">已附带当前页面</span></div>
                <div class="scr-doc">
                  <h5>虚拟内存</h5>
                  <p class="hl">虚拟内存为每个进程提供独立的地址空间，</p>
                  <p class="hl">把物理内存和磁盘组合成一层「看起来很大」的内存。</p>
                  <p>核心机制有三块：地址转换、按需调页、页面置换……</p>
                </div>
              </div>
              <aside class="scr-ai" id="aiPane">
                <div class="scr-ai-h">AI 助手 <span>Ctrl+J</span></div>
                <div class="bubble me" id="aiQ">这段讲了什么？</div>
                <div class="bubble ai" id="aiA"><span id="aiAnsTxt"></span><span class="caret"></span></div>
                <div class="audit" id="aiAudit">审计：调用 search_notes ×1 · 全部已授权</div>
              </aside>
            </div>
          </div>
          <div class="demo-foot">
            <div class="demo-dots" id="aiDots">
              <button data-i="0" class="on">1</button><button data-i="1">2</button><button data-i="2">3</button><button data-i="3">4</button>
            </div>
            <p class="demo-cap" id="aiCap"></p>
          </div>
        </div>
        <button class="lnk" id="aiReplay">▸ 再演示一次</button>
        <div class="ai-foot">安全边界：设置 → AI 工具 → 权限，按模块给「禁止 / 只读 / 读写」；没授权的模块 AI 完全碰不到。写作时笔记区还会自动出接续建议（浅色续写），<kbd>Alt</kbd>+<kbd>A</kbd> 立即要一条。</div>
      </div>

      <div class="ai-panel">
        <h3>AI 教学<span class="ai-tag">用你的资料教你</span></h3>
        <p class="ai-moto">把手头的教材、讲义、源码交给它——登记成素材，AI 只依据这些资料讲课、出讲义、考你。</p>
        <ol>
          <li><b>建工作区与会话</b>：活动栏进 AI 教学，比如「408 备考」；每个会话对应仓库 <code>AI教学/</code> 下的文件夹，产物全落在里面。</li>
          <li><b>登记素材</b>：右栏「＋素材」——PDF／PPT 标页码区间（如 <code>12-34</code>），代码标行号（如 <code>L100-250</code>）。</li>
          <li><b>说清目标</b>：顶栏「会话要求」写下这轮要干什么，AI 每轮都遵守。</li>
          <li><b>学完就考</b>：「整理成文档」即得讲义；要求出题进题目视图，一题一屏判分，成绩自动存成测验报告。</li>
        </ol>

        <div class="demo sub" id="demoTeach">
          <div class="demo-bar">
            <div class="dots3"><i></i><i></i><i></i></div>
            <span class="demo-name">AI 教学 · 408 备考</span>
            <button class="icon-btn" id="tchPlay" title="播放 / 暂停">
              <svg id="tchIcPause" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5v14M15 5v14"/></svg>
              <svg id="tchIcPlay" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M8 5.5v13l11-6.5z"/></svg>
            </button>
          </div>
          <div class="stage tall">
            <div class="scr">
              <div class="scr-rail"><i></i><i></i><i class="on"></i><i></i><i></i></div>
              <aside class="t-side">
                <div class="t-side-h">AI 教学</div>
                <div class="t-ws" id="tWs">408 备考</div>
                <div class="t-ses" id="tSes">虚存 · 第 1 节</div>
                <div class="t-ses" style="opacity:.55">进程调度</div>
                <div class="t-ws" style="opacity:.45;margin-top:8px">英语</div>
              </aside>
              <div class="t-main">
                <div class="t-req"><b>会话要求</b><em id="tReqTxt"></em></div>
                <div class="bubble ai" id="tA"><span id="tAnsTxt"></span><span class="caret"></span></div>
              </div>
              <aside class="t-mat">
                <div class="t-mat-h">素材库 <span class="plus" id="tPlus">＋</span></div>
                <div class="chip" id="tChip1">操作系统教材.pdf <b>P12-34</b></div>
                <div class="chip" id="tChip2">paging.c <b>L100-250</b></div>
                <div class="t-ring">
                  <svg viewBox="0 0 34 34"><circle class="bg" cx="17" cy="17" r="14"/><circle class="fg" id="tRing" cx="17" cy="17" r="14"/></svg>
                  <span id="tRingTxt">0%</span>
                </div>
                <div class="t-out" id="tOut">AI教学/408备考/虚存-讲义.md<br>已写入仓库</div>
              </aside>
            </div>
          </div>
          <div class="demo-foot">
            <div class="demo-dots" id="tchDots">
              <button data-i="0" class="on">1</button><button data-i="1">2</button><button data-i="2">3</button><button data-i="3">4</button><button data-i="4">5</button>
            </div>
            <p class="demo-cap" id="tchCap"></p>
          </div>
        </div>
        <button class="lnk" id="tchReplay">▸ 再演示一次</button>
        <div class="ai-foot">大文件只喂你标的那一段，不挤占上下文；输入旁的圆环显示用量，快满了它会提醒你。学习者画像分全局／工作区／本主题三层。</div>
      </div>

    </div>
  </section>

  <!-- 04 -->
  <section id="mods" class="reveal">
    <div class="sec-head"><span class="sec-no">04</span><h2 class="sec-title">模块速览</h2><span class="sec-note">左栏书签与图标条直达</span></div>
    <div class="mods">
      <div class="mod"><span class="ic-wrap"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5l3 3L7 16H4v-3z"/></svg></span><div><b>笔记</b><span>读写一体：Monaco 写作、双链 <code>[[]]</code>、沉浸阅读、标签与全文搜索、知识图谱</span></div></div>
      <div class="mod"><span class="ic-wrap"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 4.5h8a1 1 0 0 1 1 1V16a1.5 1.5 0 0 0-1.5-1.5H4zM12 5.5c1.2-1.6 3-1.6 4 0V16c-1-1.6-2.8-1.6-4 0z"/></svg></span><div><b>书架 · 阅读器</b><span>PDF / TXT 全格式阅读：三排列模式、划词问 AI / 翻译、摘录高亮、进度续读</span></div></div>
      <div class="mod"><span class="ic-wrap"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3.5" y="3" width="13" height="14" rx="2"/><path d="M6.5 7h7M6.5 10h7M6.5 13h4"/></svg></span><div><b>博客</b><span>长文写作、周月总结，可整体导出静态站点</span></div></div>
      <div class="mod"><span class="ic-wrap"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="4.5" width="14" height="12" rx="2"/><path d="M3 8.5h14M7 3v3M13 3v3"/></svg></span><div><b>日程 · 打卡</b><span>日历视图与四象限待办，习惯打卡到点提醒</span></div></div>
      <div class="mod"><span class="ic-wrap"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3.5 5.5h13v8h-7l-3.5 3v-3h-2.5z"/></svg></span><div><b>动态</b><span>带心情与图片的碎片记录，构成你的时间线</span></div></div>
      <div class="mod"><span class="ic-wrap"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="3" y="6" width="14" height="10" rx="2"/><path d="M7 6V4.5h6V6M3 10h14"/></svg></span><div><b>工具箱</b><span>番茄钟、网址导航、密码本、局域网互传——右栏工具区一键打开</span></div></div>
      <div class="mod"><span class="ic-wrap"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 3l1.7 4.3L16 9l-4.3 1.7L10 15l-1.7-4.3L4 9l4.3-1.7z"/></svg></span><div><b>AI 侧栏 · AI 教学</b><span>边看边问的侧栏，和用你资料讲课的工作台</span></div></div>
      <div class="mod"><span class="ic-wrap"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><path d="M14 11v6M11 14h6"/></svg></span><div><b>插件</b><span>官方市场：主题、预设、社区技能与知识包，安全分级</span></div></div>
      <div class="mod"><span class="ic-wrap"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M8.2 8.2A1.9 1.9 0 0 1 11.8 9c0 1.3-1.8 1.4-1.8 2.6"/><circle cx="10" cy="14.4" r=".7" fill="currentColor"/></svg></span><div><b>帮助</b><span>每个功能的完整手册，右下角一键反馈</span></div></div>
      <div class="mod"><span class="ic-wrap"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6h12M6.5 6V4.5h7V6M5.5 6l.8 10h7.4l.8-10"/></svg></span><div><b>回收站 · 导出</b><span>删除可还原；工具箱内一键 ZIP 备份全部数据</span></div></div>
    </div>
  </section>

  <!-- 05 -->
  <section id="notes" class="reveal">
    <div class="sec-head"><span class="sec-no">05</span><h2 class="sec-title">三个常踩的坑，提前说</h2></div>
    <div class="notes">
      <div class="note amber"><b>「我在外面写的 md 怎么不在列表里？」</b>没有 frontmatter id 的 md 按草稿处理——点开补全即可，也可一键转正式笔记。想全局隐藏某些内容，用仓库根的 <code>.ignore</code> 文件，gitignore 语法。</div>
      <div class="note blue"><b>「换电脑、搬家怎么办？」</b>把整个仓库文件夹拷走即可，全部数据都在里面。日常备份用 工具箱 → 数据导出（ZIP），恢复时把备份包拖进应用窗口。</div>
      <div class="note green"><b>「数据到底在哪里？」</b>只在你这台电脑的这个文件夹里。应用不联网也完全可用；密码本与模型密钥以本机加密存储，离开这台机器无法解密。</div>
    </div>
  </section>

  <!-- 06 -->
  <section id="keys" class="reveal">
    <div class="sec-head"><span class="sec-no">06</span><h2 class="sec-title">试试这三个键</h2><span class="sec-note">点卡片，或直接按键盘</span></div>
    <div class="keys">
      <button class="key" data-k="n"><span class="kc"><kbd>Ctrl</kbd><kbd>N</kbd></span><b>新建笔记</b><span>在任何模块都能立刻开一篇新的。</span></button>
      <button class="key" data-k="j"><span class="kc"><kbd>Ctrl</kbd><kbd>J</kbd></span><b>唤起 AI 助手</b><span>右侧滑出侧栏，带着当前页面内容回答你。</span></button>
      <button class="key" data-k="p"><span class="kc"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>P</kbd></span><b>命令面板</b><span>找不到功能？搜功能名就够了。</span></button>
    </div>
  </section>

  <footer>
    <p>想更细致地了解每一步，应用内 <strong>帮助 →《快速上手》</strong> 是这份导览的加长版。</p>
    <p>这份文件属于你：改写它、删掉它、把它留成一年后的回忆，都可以。</p>
    <div class="sig">PHRONTIS · VAULT ${year} · LOCAL FIRST, ALWAYS</div>
  </footer>

</div>

<div class="ov" id="ov">
  <div class="ov-card c-n"><b>新建笔记</b>笔记区多了一个标签页，光标已经就位——直接开始写。</div>
  <div class="ov-card c-j">
    <b>AI 助手</b>它知道你正在读哪一篇。
    <div class="ai-line">「这篇讲了三件事：仓库是文件夹、写和读都在笔记区、双链把笔记连成网。」</div>
  </div>
  <div class="ov-card c-p">
    <div class="row hi">新建一篇笔记<small>Notes</small></div>
    <div class="row">打开 AI 教学<small>Activity</small></div>
    <div class="row">导出 ZIP 备份<small>Toolbox</small></div>
    <div class="row">重看新用户引导<small>Settings</small></div>
  </div>
</div>

<script>
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };


  /* ---------- 阅读进度 ---------- */
  var bar = $('#prog');
  function onScroll() {
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    bar.style.transform = 'scaleX(' + (max > 0 ? h.scrollTop / max : 0) + ')';
  }
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  /* ---------- 出场动画 ---------- */
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: .1 });
  $$('.reveal').forEach(function (el) { io.observe(el); });

  /* ---------- 导航高亮 ---------- */
  var links = $$('.nav-links a');
  var sio = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      links.forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id); });
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  links.forEach(function (a) { var t = document.getElementById(a.getAttribute('href').slice(1)); if (t) sio.observe(t); });

  /* ---------- 打字机（每个演示一条独立通道，互不打断） ---------- */
  function makeTyper() {
    var token = 0, timer = null;
    function type(el, text, speed, done) {
      token++; var mine = token, i = 0;
      el.textContent = '';
      clearTimeout(timer);
      (function tick() {
        if (mine !== token) return;
        if (i >= text.length) { done && done(); return; }
        el.textContent = text.slice(0, ++i);
        timer = setTimeout(tick, speed);
      })();
    }
    type.wrap = function (el, text, html, speed) { // 打完再上高亮，避免半截标签
      type(el, text, speed, function () { el.innerHTML = html; });
    };
    return type;
  }
  var type = makeTyper();          /* 02 主流程 */
  var typeThenWrap = type.wrap;
  var typeA = makeTyper();         /* AI 助手 */
  var typeT = makeTyper();         /* AI 教学 */

  /* ---------- 02 演示播放器 ---------- */
  var panes = $$('.pane'), dtabs = $$('.dtab'), dots = $$('#dots button');
  var cap = $('#cap'), savePill = $('#savePill'),
      treeNew = $('#treeNew'), kbNew = $('#kbNew'),
      kbCount = $('#kbCount'), typeBox = $('#typeBox'), caret = $('#caret'), graph = $('#graph');

  var TXT_1 = '今天搞懂了 Phrontis：仓库只是一个文件夹，写和读都在笔记区完成。';
  var TXT_2 = '再补一句：见 [[我的第一篇笔记]]，两根线就连上了。';
  var TXT_2_HTML = '再补一句：见 <span class="link">[[我的第一篇笔记]]</span>，两根线就连上了。';

  var steps = [
    { view: 'editor', cap: '① Ctrl+N 新建一篇，直接写。写完不用按保存——它自己会存。', run: function () {
        treeNew.classList.remove('show'); savePill.classList.remove('on');
        caret.style.display = '';
        type(typeBox, TXT_1, 42, function () {
          treeNew.classList.add('show');
          savePill.classList.add('on');
        });
      } },
    { view: 'kb', cap: '② 新建即入列——它已经在列表里了，不用归档。', run: function () {
        kbNew.classList.remove('in'); kbCount.textContent = '2 个页面';
        void kbNew.offsetWidth;
        kbNew.classList.add('in');
        setTimeout(function () { kbCount.textContent = '3 个页面'; }, 700);
      } },
    { view: 'editor', cap: '③ 再写一篇，正文里打 [[标题]]，双链就建好了。', run: function () {
        caret.style.display = '';
        typeThenWrap(typeBox, TXT_2, TXT_2_HTML, 26);
      } },
    { view: 'graph', cap: '④ 打开图谱——节点可以拖着玩，知识网络开始生长。', run: function () {
        graph.classList.remove('play'); void graph.offsetWidth; graph.classList.add('play');
      } }
  ];

  /* ---------- 图谱：力导向 + 可拖拽（节点可以拖着玩） ---------- */
  var NS = 'http://www.w3.org/2000/svg';
  var gSvg = $('#graph'), gLinks = $('#gLinks'), gNodesG = $('#gNodes'), gLabelsG = $('#gLabels');
  var GW = 300, GH = 200;
  var gNodes = [
    { x: 150, y: 100, r: 21, home: [150, 100], vx: 0, vy: 0, label: '第一篇', core: true, d: .05 },
    { x: 232, y: 52,  r: 14, home: [232, 52],  vx: 0, vy: 0, label: '反链', d: .25 },
    { x: 258, y: 118, r: 14, home: [258, 118], vx: 0, vy: 0, label: '双链', d: .45 },
    { x: 74,  y: 152, r: 12, home: [74, 152],  vx: 0, vy: 0, label: '标签', d: .6 },
    { x: 188, y: 166, r: 12, home: [188, 166], vx: 0, vy: 0, label: '图谱', d: .75 }
  ];
  var gEdges = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [2, 4]];
  var gLinkEls = gEdges.map(function () {
    var l = document.createElementNS(NS, 'path');
    l.setAttribute('class', 'g-link'); l.style.animationDelay = '.15s';
    gLinks.appendChild(l); return l;
  });
  gNodes.forEach(function (n) {
    var c = document.createElementNS(NS, 'circle');
    c.setAttribute('class', 'g-node'); c.setAttribute('r', n.r);
    c.style.animationDelay = n.d + 's';
    if (n.core) c.style.strokeWidth = '2';
    c.style.cursor = 'grab';
    gNodesG.appendChild(c); n.el = c;
    var t = document.createElementNS(NS, 'text');
    t.setAttribute('class', 'g-label');
    t.style.animationDelay = (n.d + .3) + 's';
    t.textContent = n.label;
    gLabelsG.appendChild(t); n.tEl = t;
  });
  var gDrag = null, gRunning = false;
  var gReduced = false; try { gReduced = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  function gPt(e) {
    var r = gSvg.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * GW, y: (e.clientY - r.top) / r.height * GH };
  }
  gSvg.addEventListener('pointerdown', function (e) {
    var p = gPt(e), best = null, bd = 1e9;
    gNodes.forEach(function (n) {
      var d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < n.r + 8 && d < bd) { bd = d; best = n; }
    });
    if (!best) return;
    if (playing) setPlaying(false);
    gDrag = best; best.vx = 0; best.vy = 0;
    try { gSvg.setPointerCapture(e.pointerId); } catch (x) {}
    gSvg.style.cursor = 'grabbing';
    gStart();
    e.preventDefault();
  });
  gSvg.addEventListener('pointermove', function (e) {
    if (!gDrag) return;
    var p = gPt(e); gDrag.x = p.x; gDrag.y = p.y; gDrag.vx = 0; gDrag.vy = 0; gStart();
  });
  function gUp() { gDrag = null; gSvg.style.cursor = 'default'; }
  gSvg.addEventListener('pointerup', gUp);
  gSvg.addEventListener('pointercancel', gUp);
  function gStart() { if (!gRunning) { gRunning = true; requestAnimationFrame(gFrame); } }
  function gFrame(t) {
    var i, n;
    for (i = 0; i < gNodes.length; i++) {
      n = gNodes[i];
      if (n === gDrag) continue;
      n.vx += (n.home[0] - n.x) * .004 + Math.sin((t || 0) / 900 + i * 1.7) * .012;
      n.vy += (n.home[1] - n.y) * .004 + Math.cos((t || 0) / 1100 + i * 2.3) * .010;
    }
    gEdges.forEach(function (e) {
      var a = gNodes[e[0]], b = gNodes[e[1]];
      var dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      var rest = Math.hypot(a.home[0] - b.home[0], a.home[1] - b.home[1]);
      var f = (d - rest) * .015, fx = dx / d * f, fy = dy / d * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    });
    for (i = 0; i < gNodes.length; i++) {
      n = gNodes[i];
      if (n === gDrag) { n.vx = 0; n.vy = 0; }
      else { n.vx *= .90; n.vy *= .90; n.x += n.vx; n.y += n.vy; }
      n.x = Math.max(14, Math.min(GW - 14, n.x));
      n.y = Math.max(12, Math.min(GH - 12, n.y));
      n.el.setAttribute('cx', n.x); n.el.setAttribute('cy', n.y);
      n.tEl.setAttribute('x', n.x);
      n.tEl.setAttribute('y', n.core ? n.y + 3 : n.y + n.r + 11);
    }
    gEdges.forEach(function (e, k) {
      var a = gNodes[e[0]], b = gNodes[e[1]];
      gLinkEls[k].setAttribute('d', 'M' + a.x + ' ' + a.y + ' L' + b.x + ' ' + b.y);
    });
    if (!gReduced || gDrag) requestAnimationFrame(gFrame);
    else gRunning = false;
  }
  gStart();

  var idx = 0, playing = false, stepTimer = null;

  function show(view) {
    panes.forEach(function (p) { p.classList.toggle('on', p.dataset.pane === view); });
    dtabs.forEach(function (t) { t.classList.toggle('on', t.dataset.view === view); });
  }
  function go(i, keepPlaying) {
    idx = (i + steps.length) % steps.length;
    var s = steps[idx];
    show(s.view);
    cap.textContent = s.cap;
    dots.forEach(function (d, n) { d.classList.toggle('on', n === idx); });
    s.run();
    clearTimeout(stepTimer);
    if (playing || keepPlaying) stepTimer = setTimeout(function () { go(idx + 1); }, 3100);
  }
  function setPlaying(v) {
    playing = v;
    $('#icPause').style.display = v ? '' : 'none';
    $('#icPlay').style.display = v ? 'none' : '';
    clearTimeout(stepTimer);
    if (v) stepTimer = setTimeout(function () { go(idx + 1); }, 3100);
  }

  $('#demoPlay').addEventListener('click', function () { setPlaying(!playing); });
  dots.forEach(function (d) {
    d.addEventListener('click', function () { go(parseInt(d.dataset.i, 10), playing); });
  });
  dtabs.forEach(function (t) {
    t.addEventListener('click', function () {
      setPlaying(false);
      var v = t.dataset.view;
      var map = { editor: 0, kb: 1, graph: 3 };
      go(map[v]);
    });
  });

  var dio = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (e.isIntersecting && !started) { started = true; go(0); setPlaying(true); }
      else if (!e.isIntersecting && playing) setPlaying(false);
      else if (e.isIntersecting && started && !playing) setPlaying(true);
    });
  }, { threshold: .35 });
  var started = false;
  dio.observe($('#demo'));

  /* ---------- 通用小播放器 ---------- */
  function makePlayer(opt) {
    var el = $(opt.el), steps = opt.steps, delay = opt.delay || 3000;
    var capEl = $(opt.cap), dotEls = $$('#' + opt.dots + ' button');
    var pauseIc = $(opt.pauseIc), playIc = $(opt.playIc);
    var idx = 0, playing = false, t = null;

    function paint() {
      capEl.textContent = steps[idx].cap;
      dotEls.forEach(function (d, n) { d.classList.toggle('on', n === idx); });
    }
    function setPlaying(v) {
      playing = v;
      pauseIc.style.display = v ? '' : 'none';
      playIc.style.display = v ? 'none' : '';
      clearTimeout(t);
      if (v) t = setTimeout(next, steps[idx].hold || delay);
    }
    function go(i) {
      idx = (i + steps.length) % steps.length;
      opt.reset();
      paint();
      steps[idx].run();
      clearTimeout(t);
      if (playing) t = setTimeout(next, steps[idx].hold || delay);
    }
    function next() { go(idx + 1); }

    $(opt.playBtn).addEventListener('click', function () { setPlaying(!playing); });
    dotEls.forEach(function (d, n) {
      d.addEventListener('click', function () { go(n); if (playing) setPlaying(true); });
    });
    if (opt.replay) $(opt.replay).addEventListener('click', function () { go(0); setPlaying(true); });

    var started = false;
    var o = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting && !started) { started = true; go(0); setPlaying(true); }
        else if (e.isIntersecting && started && !playing) setPlaying(true);
        else if (!e.isIntersecting && playing) setPlaying(false);
      });
    }, { threshold: .3 });
    o.observe(el);

    go(0); setPlaying(false);
    return { go: go, play: function () { setPlaying(true); } };
  }

  /* ---------- 03-A AI 助手演示 ---------- */
  var aiPane = $('#aiPane'), ctxTag = $('#ctxTag'), aiQ = $('#aiQ'), aiA = $('#aiA'),
      aiAnsTxt = $('#aiAnsTxt'), aiAudit = $('#aiAudit');
  var AI_TXT = '虚拟内存做三件事：① 给每个进程一个独立的地址空间；② 按需调页，缺页时才把磁盘页换入；③ 页满了按置换算法挑一页换出。';
  function resetA() {
    aiPane.classList.remove('in'); ctxTag.classList.remove('on');
    aiQ.classList.remove('on'); aiA.classList.remove('on'); aiAudit.classList.remove('on');
    aiAnsTxt.textContent = '';
  }
  makePlayer({
    el: '#demoAi', cap: '#aiCap', dots: 'aiDots', replay: '#aiReplay',
    playBtn: '#aiPlay', pauseIc: '#aiIcPause', playIc: '#aiIcPlay', delay: 3000,
    reset: resetA,
    steps: [
      { cap: '① 你正在笔记区读一篇笔记。', run: function () {} },
      { cap: '② 按 Ctrl+J —— 侧栏从右边滑出，并自动带上你正在读的这一页。', run: function () {
          aiPane.classList.add('in');
          setTimeout(function () { ctxTag.classList.add('on'); }, 420);
          setTimeout(function () { aiQ.classList.add('on'); }, 780);
        } },
      { cap: '③ 直接问就行。上下文它自己带着，不用你复制粘贴。', hold: 4200, run: function () {
          aiPane.classList.add('in'); ctxTag.classList.add('on'); aiQ.classList.add('on'); aiA.classList.add('on');
          typeA(aiAnsTxt, AI_TXT, 26, function () { aiAudit.classList.add('on'); });
        } },
      { cap: '④ 每一次工具调用都留痕，随时可回看审计记录。', run: function () {
          aiPane.classList.add('in'); ctxTag.classList.add('on'); aiQ.classList.add('on'); aiA.classList.add('on');
          aiAnsTxt.textContent = AI_TXT; aiAudit.classList.add('on');
        } }
    ]
  });

  /* ---------- 03-B AI 教学演示 ---------- */
  var tWs = $('#tWs'), tSes = $('#tSes'), tPlus = $('#tPlus'),
      tChip1 = $('#tChip1'), tChip2 = $('#tChip2'), tRing = $('#tRing'), tRingTxt = $('#tRingTxt'),
      tReqTxt = $('#tReqTxt'), tAnsTxt = $('#tAnsTxt'), tOut = $('#tOut'), tA = $('#tA');
  var C = 2 * Math.PI * 14;
  tRing.style.strokeDasharray = C;
  function setRing(p) { tRing.style.strokeDashoffset = C * (1 - p); tRingTxt.textContent = Math.round(p * 100) + '%'; }
  var T_REQ = '讲透虚存章节，章末出 5 道选择';
  var T_ANS = '这一节只讲三件事：地址空间为什么能隔离、缺页中断时内核做了什么、以及 LRU 为什么在工程上只能用近似实现。';
  function resetT() {
    tWs.classList.remove('hot'); tSes.classList.remove('hot'); tPlus.classList.remove('hot');
    tChip1.classList.remove('in'); tChip2.classList.remove('in');
    tOut.classList.remove('in'); setRing(0);
    tReqTxt.textContent = ''; tAnsTxt.textContent = '';
  }
  makePlayer({
    el: '#demoTeach', cap: '#tchCap', dots: 'tchDots', replay: '#tchReplay',
    playBtn: '#tchPlay', pauseIc: '#tchIcPause', playIc: '#tchIcPlay', delay: 3000,
    reset: resetT,
    steps: [
      { cap: '① 左侧图标条进 AI 教学，建一个工作区，比如「408 备考」。', run: function () {
          tWs.classList.add('hot');
          setTimeout(function () { tSes.classList.add('hot'); }, 500);
        } },
      { cap: '② 右栏「＋素材」登记资料：PDF 标页码区间，代码标行号。', run: function () {
          tWs.classList.add('hot'); tSes.classList.add('hot'); tPlus.classList.add('hot');
          setTimeout(function () { tChip1.classList.add('in'); }, 260);
          setTimeout(function () { tChip2.classList.add('in'); }, 640);
          setTimeout(function () { setRing(0.72); }, 900);
        } },
      { cap: '③ 顶栏「会话要求」写下这轮目标，AI 每轮都遵守。', run: function () {
          tWs.classList.add('hot'); tSes.classList.add('hot');
          tChip1.classList.add('in'); tChip2.classList.add('in'); setRing(0.72);
          typeT(tReqTxt, T_REQ, 46);
        } },
      { cap: '④ 让它讲第一节。它只依据你登记的素材回答。', hold: 4800, run: function () {
          tWs.classList.add('hot'); tSes.classList.add('hot');
          tChip1.classList.add('in'); tChip2.classList.add('in'); setRing(0.72);
          tReqTxt.textContent = T_REQ;
          typeT(tAnsTxt, T_ANS, 24);
        } },
      { cap: '⑤ 说一句「整理成文档」，讲义直接落进仓库 AI教学/ 目录。', run: function () {
          tWs.classList.add('hot'); tSes.classList.add('hot');
          tChip1.classList.add('in'); tChip2.classList.add('in'); setRing(0.72);
          tReqTxt.textContent = T_REQ; tAnsTxt.textContent = T_ANS;
          tOut.classList.add('in');
        } }
    ]
  });

  /* ---------- 06 快捷键演示 ---------- */
  var ov = $('#ov'), ovT = null;
  function fire(k) {
    ov.className = 'ov show-' + k;
    clearTimeout(ovT);
    ovT = setTimeout(function () { ov.className = 'ov'; }, 2600);
  }
  $$('.key').forEach(function (b) { b.addEventListener('click', function () { fire(b.dataset.k); }); });
  addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    var k = e.key.toLowerCase();
    if (e.shiftKey && k === 'p') { e.preventDefault(); fire('p'); return; }
    if (k === 'n') { e.preventDefault(); fire('n'); }
    else if (k === 'j') { e.preventDefault(); fire('j'); }
  });

  /* ---------- 上手清单 ---------- */
  var KEY = 'kb-welcome-checklist-v3';
  var boxes = $$('#cl input'), ringFg = $('#ringFg'), ringTxt = $('#ringTxt'), clSub = $('#clSub'), cl = $('#cl');
  var RC = 2 * Math.PI * 14;
  ringFg.style.strokeDasharray = RC;
  ringFg.style.strokeDashoffset = RC;
  var store = null;
  try { localStorage.getItem(KEY); store = localStorage; } catch (e) { document.body.classList.add('no-storage'); }
  var state = {};
  try { state = JSON.parse((store || { getItem: function () { return null; } }).getItem(KEY) || '{}'); } catch (e) { state = {}; }

  function render() {
    var done = 0;
    boxes.forEach(function (b) { if (b.checked) done++; });
    var p = done / boxes.length;
    ringFg.style.strokeDashoffset = RC * (1 - p);
    ringTxt.textContent = done + '/' + boxes.length;
    cl.classList.toggle('done', done === boxes.length);
    clSub.textContent = done === boxes.length ? '全部完成，欢迎正式入坑 🎉' : '还差 ' + (boxes.length - done) + ' 件';
  }
  boxes.forEach(function (b) {
    if (state[b.dataset.cl]) b.checked = true;
    b.addEventListener('change', function () {
      state[b.dataset.cl] = b.checked;
      try { if (store) store.setItem(KEY, JSON.stringify(state)); } catch (e) {}
      render();
    });
  });
  render();
})();
</script>
</body>
</html>
` 
  /*==WELCOME-HTML-END==*/
}

/** 幂等写入：欢迎文件（含旧版 欢迎.md）任一已存在时跳过。返回是否实际写入。失败不抛错（不阻断仓库创建） */
export function writeWelcomeDocOnce(rootPath: string): boolean {
  try {
    const target = join(rootPath, WELCOME_DOC_FILENAME)
    if (existsSync(target) || existsSync(join(rootPath, '欢迎.md'))) return false
    writeFileSync(target, buildWelcomeDocContent(), 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 旧版欢迎文档名（09-08~09-09 窗口期落盘的 md 版）；新装不再生成，仅用于「重复欢迎页」提示 */
export const LEGACY_WELCOME_DOC_FILENAME = '欢迎.md'

/** 仓库根欢迎页现状（供设置页「导入」按钮判断是否需要覆盖确认 / 提示重复标题） */
export function getWelcomeDocState(rootPath: string): { hasHtml: boolean; hasLegacyMd: boolean } {
  let hasHtml = false
  let hasLegacyMd = false
  try { hasHtml = existsSync(join(rootPath, WELCOME_DOC_FILENAME)) } catch { /* 路径不可读按不存在处理 */ }
  try { hasLegacyMd = existsSync(join(rootPath, LEGACY_WELCOME_DOC_FILENAME)) } catch { /* 同上 */ }
  return { hasHtml, hasLegacyMd }
}

/**
 * 手动导入欢迎页（设置 → 关于 → 新手引导）。
 *
 * 与 writeWelcomeDocOnce 的差别：**不做幂等跳过** —— 调用方（主进程 handler）负责
 * 「仓库里已存在时是否覆盖」的确认，这里只负责按当前版本内容落盘。
 * 覆盖是用户显式意图：欢迎页是可编辑的普通文件，覆盖会把内容重置为最新版导览。
 */
export function importWelcomeDoc(rootPath: string): { ok: true } | { ok: false; error: string } {
  try {
    writeFileSync(join(rootPath, WELCOME_DOC_FILENAME), buildWelcomeDocContent(), 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message || '写入失败' }
  }
}
