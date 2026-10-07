import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { getVaultKbRoot } from './vaultContext'
import { encryptSecret, decryptSecret } from '../secretBox'

/**
 * 敏感数据存储（密码本等）：加密 JSON 落盘。
 * 加密复用 secretBox（Electron safeStorage；密文机制与格式见 secretBox.ts 头注释），落盘为 'enc1:' 密文。
 * 解密失败返回 null（如密文来自其他机器——AES 密钥由 DPAPI 绑本机，跨机不可解）。
 */

/** 读加密 JSON；文件不存在返回 null，解密失败返回 null（不把密文当有效值） */
export function readSecret<T>(module: string, key: string): T | null {
  const root = getVaultKbRoot()
  if (!root) return null
  const p = join(root, module, key)
  if (!existsSync(p)) return null
  try {
    const plain = decryptSecret(readFileSync(p, 'utf-8'))
    if (!plain) return null
    return JSON.parse(plain) as T
  } catch {
    return null
  }
}

/** 写加密 JSON（原子写）。成功返回 true */
export function writeSecret(module: string, key: string, data: unknown): boolean {
  const root = getVaultKbRoot()
  if (!root) return false
  const p = join(root, module, key)
  const dir = dirname(p)
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${randomUUID()}.tmp`)
    writeFileSync(tmp, encryptSecret(JSON.stringify(data)), 'utf-8')
    try {
      renameSync(tmp, p)
    } catch {
      if (existsSync(p)) unlinkSync(p)
      renameSync(tmp, p)
    }
    return true
  } catch {
    return false
  }
}
