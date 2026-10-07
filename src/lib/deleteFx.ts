import type { DeleteFxSkin } from '../types'
import { pluginListDeleteFxSkins, getSetting } from './ipc'

/** 内置默认皮肤 id */
export const BUILTIN_DELETE_FX = 'builtin'

/**
 * 加载当前激活的删除动画皮肤（设置 deleteFxSkin 指定的插件皮肤；未指定/未安装 → 内置默认 null）。
 * 模块级缓存：DeleteWipe 每次挂载复用，避免重复 IPC。
 */
let cache: DeleteFxSkin | null | undefined = undefined

export function getDeleteFxSkin(): Promise<DeleteFxSkin | null> {
  if (cache !== undefined) return Promise.resolve(cache)
  return (async () => {
    try {
      const selected = String(await getSetting('deleteFxSkin') ?? BUILTIN_DELETE_FX)
      if (selected !== BUILTIN_DELETE_FX) {
        const skins = await pluginListDeleteFxSkins()
        cache = skins.find(s => s.id === selected || s.pluginId === selected) ?? null
        return cache
      }
      cache = null
    } catch {
      cache = null
    }
    return cache
  })()
}

