/**
 * 契约脚本的 strip-types 装载器（共享工具，不是被测模块）。
 *
 * 背景：纯函数层开始互相 import（如 `electron/lib/courseOutlinePure.ts` →
 * `src/lib/courseOutlineTopo.ts`），原来是「一个文件 strip 后写进 tmp 再 import」。
 * 这里把相对 import 递归 stage 成 tmp 里的同级 `.mjs`，脚本行为不变。
 *
 * 只处理**相对** import；裸包（react / electron / node:）一律不解析 —— 那些文件本来
 * 就不该进契约脚本（调用方仍可自己断言）。
 *
 * 输出纯 ASCII（脚本禁 emoji）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

/** node:module 的 stripTypeScriptTypes 在旧运行时可能缺失 → 用一次性提示替代静默崩溃 */
export function assertStripSupported() {
  if (typeof stripTypeScriptTypes !== 'function') {
    throw new Error('node:module stripTypeScriptTypes unavailable; node >= 22.13 required')
  }
}

/**
 * 建一个 staging 加载器。
 * @param {string} ROOT 仓库根（绝对路径）
 */
export function makeStager(ROOT) {
  assertStripSupported()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-strip-'))
  /** repo 相对路径 -> tmp 内 .mjs 绝对路径（防重复 stage / 递归） */
  const staged = new Map()

  const stage = (rel) => {
    const key = rel.replace(/\\/g, '/')
    const cached = staged.get(key)
    if (cached) return cached
    const abs = path.resolve(ROOT, key)
    const outName = `${key.replace(/\.tsx?$/, '').split('/').join('__')}.mjs`
    const out = path.join(tmpDir, outName)
    staged.set(key, out)

    let code = stripTypeScriptTypes(fs.readFileSync(abs, 'utf8'), { mode: 'strip' })
    code = code.replace(/(\bfrom\s*['"])(\.{1,2}\/[^'"]+)(['"])/g, (m, head, spec, tail) => {
      const depAbs = path.resolve(path.dirname(abs), spec)
      const candidate = [depAbs, `${depAbs}.ts`, `${depAbs}.tsx`].find(
        (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
      )
      if (!candidate) return m
      const depRel = path.relative(ROOT, candidate)
      if (depRel.startsWith('..')) return m
      return `${head}./${path.basename(stage(depRel))}${tail}`
    })
    fs.writeFileSync(out, code)
    return out
  }

  return {
    tmpDir,
    stage,
    /** 装载一个仓库内模块（strip 后 import），返回 module namespace */
    async load(rel) {
      return import(pathToFileURL(stage(rel)).href)
    },
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* 临时目录清理失败不影响结论 */
      }
    },
  }
}
