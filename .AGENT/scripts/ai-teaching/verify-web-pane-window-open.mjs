#!/usr/bin/env node
/**
 * 契约验证（运行时）：AI 教学右侧网页页签 · 新窗口请求分流
 *
 * 覆盖的不变量（全部跑**真实的** `electron/lib/webPaneView.ts`，esbuild 打包后进 Electron 执行）：
 *   ① `target="_blank"` 普通链接 → 在当前 view 内导航（不开窗口、地址变化、后退可回原页）；
 *   ② `window.open(url)` 不带尺寸 → 同上（实测 disposition = foreground-tab + features 为空）；
 *   ③ `window.open(url, name, 'width=..,height=..')` → 应用内受控小窗：
 *      与页面**共用 persist:webtabs 分区**（Cookie 通）、保留 `window.opener` / `window.name`、
 *      `opener.postMessage` 能回到宿主、`window.close()` 能关掉窗口；
 *   ④ 并发弹窗上限 `WEB_PANE_POPUP_MAX = 2`；
 *   ⑤ 关页签（closeWebPane）连带关掉它开出的弹窗；
 *   ⑥ `mailto:` 交给系统、且**不许任何 http(s) 地址泄漏到系统浏览器**。
 *
 * 为什么要有这一层：静态契约只能看到「写了 allow / deny」，看不到 Electron 真实的
 * disposition、分区继承、opener 关系与 window.close 行为 —— 这些恰好是「应用内登录」成立的全部前提。
 *
 * 运行（项目根目录，需要有桌面会话）：
 *   node .AGENT/scripts/ai-teaching/verify-web-pane-window-open.mjs
 * 输出纯 ASCII（AGENTS.md 禁 emoji）；退出码 0 才代表全部通过。
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

const workDir = mkdtempSync(join(tmpdir(), 'web-pane-window-open-'))
const bundle = join(workDir, 'webPaneView.bundle.cjs')

await build({
  entryPoints: [join(ROOT, 'electron/lib/webPaneView.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'error',
})

const electronPath = require('electron')
const args = []
if (process.platform === 'linux') args.push('--no-sandbox')
args.push(join(HERE, 'harness-web-pane-window-open.cjs'))

const code = await new Promise((resolve) => {
  const child = spawn(electronPath, args, {
    stdio: 'inherit',
    // 走环境变量而不是 argv：Electron 会把 `--no-sandbox` 之类的开关留在 process.argv 里，
    // 位置会随平台 / 启动方式漂移（2026-11-25 实测 Windows 与 Linux 不同）。
    env: { ...process.env, WEB_PANE_BUNDLE: bundle },
  })
  child.on('exit', (c) => resolve(c ?? 1))
  child.on('error', (e) => {
    console.log(`[FAIL] could not start electron: ${e.message}`)
    resolve(1)
  })
})

try {
  rmSync(workDir, { recursive: true, force: true })
} catch {
  /* temp cleanup is best-effort */
}

console.log(`\n${code === 0 ? 'PASS' : 'FAIL'} - verify-web-pane-window-open (exit ${code})`)
process.exit(code)
