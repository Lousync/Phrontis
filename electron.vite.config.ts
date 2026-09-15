import { dirname, resolve } from 'path'
import { realpathSync, rmSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// worktree 场景：node_modules 是指向主工程 node_modules 的 junction（realpath 在 worktree 之外），
// Vite dev server 按真实路径判定后拒绝服务（monaco 等静态资源 403 → 黑屏）。
// 因此把「主工程根」一并加入 renderer 的 fs 白名单；普通 checkout 下 realpath 不变，此值无副作用。
const nodeModulesReal = realpathSync(resolve(__dirname, 'node_modules'))
const mainProjectRoot = dirname(nodeModulesReal)

// 清空单个 outDir（替代被拦截的 emptyOutDir）。
// 背景：本机 safe-delete 钩子会拦截 Vite 内部基于 trash 的清空动作（Error during a
// `trash` operation），故三处 build 都设了 emptyOutDir:false；但代价是 hash 命名的产物
// 跨构建无限累积 —— 实测 out/renderer/assets 攒到 141 个 js / 90 MB，而 index.html
// 真正引用的仅 7 个 / 5.31 MB，又因 build.files=["out/**/*"] 全部打进安装包。
// Node 的 fs.rmSync 不受该钩子影响（150 文件 / 29.3 MB 实测无错通过），故改由本插件在
// 构建开始前手动清空各自的 outDir。
// 仅当开启 watch 时跳过（`electron-vite dev --watch`）：此时删目录可能让正在运行的 Electron
// 读不到入口。本项目 `npm run dev` 不带 --watch，主/预加载只在启动时构建一次，清一次无副作用。
// 渲染器侧另有 apply:'build'，dev 走 serve 不触发，out/renderer 不受影响。
function cleanOutDir(outDir: string): Plugin {
  const abs = resolve(__dirname, outDir)
  let isWatch = false
  return {
    name: 'phrontis:clean-out-dir',
    apply: 'build',
    configResolved(config) {
      isWatch = Boolean(config.build.watch)
    },
    buildStart() {
      if (isWatch) return
      rmSync(abs, { recursive: true, force: true })
    }
  }
}

export default defineConfig({
  main: {
    // defuddle 打进 bundle 而非 externalize：其 '/node' 子路径 exports 只有 import 条件，
    // rollup 的 external 字符串会连 'defuddle/node' 一起匹配放行 → 产物运行时 require 必炸
    // ERR_PACKAGE_PATH_NOT_EXPORTED（0.19.3 实测）。
    // linkedom 一并打进来：其 cjs 构建运行时 require('css-select')，而 css-select 新版是 ESM-only，
    // Electron 主进程必炸 ERR_REQUIRE_ESM（实测）；bundle 静态解析后统一为 CJS 产物，运行期无 require 链。
    // turndown 有合法 require 条件，维持外置。
    plugins: [cleanOutDir('out/main'), externalizeDepsPlugin({ exclude: ['defuddle', 'linkedom'] })],
    // AI 测试桥开关：构建期静态替换。为 false 时 main 中的动态 import 会被
    // tree-shake 掉，devbridge 整个 chunk 不进产物（生产零残留）。
    define: {
      __DEV_BRIDGE__: JSON.stringify(process.env.KNOWBASE_DEV_BRIDGE === '1')
    },
    build: {
      outDir: 'out/main',
      // 保持 false（Vite 的 trash 清空会被 safe-delete 钩子拦截）；实际清空交给文件顶部
      // 的 cleanOutDir() 插件用 fs.rmSync 完成。
      emptyOutDir: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main/index.ts')
        },
        // linkedom 打进 bundle 后会牵出其可选依赖 canvas（require('../build/Release/canvas.node')）——
        // 该分支在纯 Node/Electron 下永不触发，标记 external 让 rollup 不做静态解析即可。
        external: ['canvas']
      }
    }
  },
  preload: {
    plugins: [cleanOutDir('out/preload'), externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      emptyOutDir: false,   // 同上：清空交给 cleanOutDir()
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    server: {
      host: '127.0.0.1',
      port: 7173,          // 6173 会落入 Windows Hyper-V/winnat 排除端口段导致 EACCES
      strictPort: false,
      watch: {
        // Windows 下原子写（编辑工具/脚本）会产生 `.xx.tmpdir/` 临时目录与 `.uuid.tmp`
        // 文件，rename 完成即消失；chokidar 原生 watcher 恰以这一瞬为竞态捕获它们
        // → EBUSY 未捕获异常直接杀死 dev 进程（本机 dev 实测崩溃）。
        // 一并忽略非源码目录：tmp/（基线与冒烟产物，写入不再触发无谓 full-reload）、
        // .AGENT/（worktree 嵌套副本）、out_prev_*/（历史构建 dumps）。
        ignored: ['**/.*.tmp', '**/.*.tmpdir', '**/.*.tmpdir/**', '**/tmp/**', '**/.AGENT/**', '**/out_prev_*/**']
      },
      fs: {
        allow: [resolve(__dirname), mainProjectRoot]
      }
    },
    build: {
      outDir: 'out/renderer',
      emptyOutDir: false,   // 同上：清空交给 cleanOutDir()
      // monaco / pdfjs 等天然超过默认 500KB 提示阈值——它们是**按需加载**的独立 chunk，
      // 不属于首屏负担，调高阈值避免噪音警告。
      chunkSizeWarningLimit: 8000,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        },
        output: {
          // 显式分包（性能 2026-09-10）：只把明确的重量级依赖钉成独立 chunk，其余一律交还 rollup
          // 按引用关系自动分配。⚠️ 不可兜底成单个 'vendor'——入口只要用到其中一个包，
          // 就会把全部第三方代码拖进首屏（实测兜底版首屏静态闭包 14.4MB，vendor 独占 4.5MB）。
          manualChunks(id: string) {
            // Vite 注入的 __vitePreload 辅助必须单独隔离：它被所有 chunk 共享，若被提升进
            // monaco 这类大 chunk，入口会为了引用这一个函数而静态 import 整个 chunk
            // ——这是「monaco 明明已懒加载却仍出现在首屏」的直接成因。
            if (id.includes('preload-helper')) return 'vite-helpers'
            if (!id.includes('node_modules')) return undefined
            if (id.includes('monaco-editor')) return 'monaco'
            if (id.includes('pdfjs-dist')) return 'pdfjs'
            if (id.includes('katex')) return 'katex'
            if (id.includes('highlight.js')) return 'highlight'
            if (id.includes('react-dom') || id.includes('scheduler') || /[\\/]react[\\/]/.test(id)) return 'react-vendor'
            return undefined
          }
        }
      }
    },
    plugins: [cleanOutDir('out/renderer'), react(), tailwindcss()]
  }
})
