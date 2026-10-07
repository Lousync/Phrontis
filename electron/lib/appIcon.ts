import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeImage, type NativeImage } from 'electron'

/**
 * 应用图标装载的唯一事实源（v3.4.0 台账 F-3，2026-09-26）—— 托盘与任务栏窗口共用。
 *
 * 根因链（打包态三候选全灭）：electron-builder 的 `files` 只打包 out/**，build/icon.png
 * 不进 asar —— 安装版旧三个候选路径全部不存在，恒走兜底（旧兜底 = 无意义的紫色方块）。
 * 「有时正常有时不正常」的另一候选解释是开机自启 / 杀软对读盘的瞬时竞态 → 用有限重试兜住。
 *
 * 三层防线：
 * ① 候选按 isPackaged 分叉（打包走 process.resourcesPath —— 配合 package.json extraResources
 *    把 build/icon.png 带出到资源根，这一步是打包态能从磁盘装载的前提）；
 * ② loadAppIconWithRetry：全部候选失败后有限重试（默认 4 轮 × 400ms）；
 * ③ 最终兜底 = 内嵌 48px 真应用图标（从 build/icon.ico 第三帧抽出的 PNG base64）——
 *    最坏情况用户看到的也是正常图标，紫色方块退役。
 *
 * 更换应用图标后重跑抽帧：node 读 build/icon.ico 帧表（6B ICONDIR + 16B/项，宽度字节 0 = 256），
 * 取 48×48 PNG 帧转 base64 按 100 列折行替换下方常量（生成器 tmp/gen-appicon.mjs）。
 */

export const ICON_FALLBACK_DATA_URL =
'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'

export interface AppIconResult {
  img: NativeImage
  /** 'path:<候选序号>' | 'builtin' —— 供日志定位装载来源 */
  source: string
}

/** 候选路径（按环境分叉；dev 下 appPath 即项目根，build/ 直接可读） */
function iconCandidates(): string[] {
  const appPath = app.getAppPath()
  const resPath = process.resourcesPath ?? ''
  return app.isPackaged
    ? [join(resPath, 'icon.png'), join(resPath, 'build', 'icon.png'), join(appPath, 'build', 'icon.png')]
    : [join(appPath, 'build', 'icon.png'), join(resPath, 'build', 'icon.png'), join(resPath, 'icon.png')]
}

/** 单轮装载：存在性 + 非空图双重校验（createFromPath 对损坏文件返回空图而非抛错） */
export function loadAppIconSync(): AppIconResult {
  const candidates = iconCandidates()
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i]
    if (!p || !existsSync(p)) continue
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) return { img, source: `path:${i}` }
  }
  return { img: nativeImage.createFromDataURL(ICON_FALLBACK_DATA_URL), source: 'builtin' }
}

/** 有限重试装载：防开机自启 / 杀软句柄占用等瞬时读盘竞态。
 *  成功即返回；全部失败回内置真图标兜底（不抛错 —— 托盘创建永不因图标失败）。 */
export async function loadAppIconWithRetry(attempts = 4, delayMs = 400, log?: (msg: string) => void): Promise<AppIconResult> {
  let last = loadAppIconSync()
  if (last.source !== 'builtin') return last
  for (let i = 2; i <= attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs))
    last = loadAppIconSync()
    if (last.source !== 'builtin') {
      log?.(`icon loaded from path after retry #${i - 1}`)
      return last
    }
  }
  log?.('all icon candidates failed after retries -> using builtin 48px app icon')
  return last
}
