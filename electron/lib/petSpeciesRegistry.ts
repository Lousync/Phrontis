/**
 * 桌宠品种注册表（2026-09-29，插件贡献宠物品种扩展点）。
 *
 * 分层解耦：petVaultRepo（kbStore 层）只 import 本模块做「品种是否合法 / 默认名」判定，
 * 不直接依赖 pluginRegistry（插件层）。pluginRegistry 在 registerPluginHandlers 时把
 * 扫描函数注入进来，注入方保证 provider 每次调用返回**当前实时**的品种清单
 * （每次重扫 index + 插件清单，插件启停/卸载后无需任何钩子即自动生效）。
 *
 * 立绘 URL 由 plugin:// 协议承载（特权 scheme，主窗口 img 可直接用），
 * 素材只存在本地插件目录，公开仓零接触——这是本扩展点的版权隔离意义。
 */

/** 内置品种固定两只；其他品种必须由启用中的插件贡献 */
export const BUILTIN_PET_SPECIES = ['dog', 'cat'] as const

export type PetPoseKey =
  | 'baby-base' | 'baby-hungry' | 'baby-lie' | 'baby-pet' | 'baby-eat'
  | 'adult-base' | 'adult-hungry' | 'adult-lie' | 'adult-pet' | 'adult-eat'

/** 立绘键全集：贡献品种必须 10 张齐，缺一张即不上架 */
export const PET_SPRITE_KEYS: readonly PetPoseKey[] = [
  'baby-base', 'baby-hungry', 'baby-lie', 'baby-pet', 'baby-eat',
  'adult-base', 'adult-hungry', 'adult-lie', 'adult-pet', 'adult-eat',
]

export interface PluginPetInfo {
  pluginId: string
  speciesId: string
  name: string
  /** 键 = `${stage}-${pose}`（见 PET_SPRITE_KEYS），值 = plugin:// 立绘 URL */
  sprites: Record<string, string>
}

let provider: (() => PluginPetInfo[]) | null = null

/** pluginRegistry 注入扫描器（每次调用实时重扫）；传 null 解除 */
export function setPluginPetProvider(fn: (() => PluginPetInfo[]) | null): void {
  provider = fn
}

export function listPluginPets(): PluginPetInfo[] {
  try {
    return provider ? provider() : []
  } catch {
    return []
  }
}

export function findPluginPet(speciesId: string): PluginPetInfo | null {
  return listPluginPets().find((p) => p.speciesId === speciesId) ?? null
}

export function isBuiltinPetSpecies(v: unknown): v is 'dog' | 'cat' {
  return typeof v === 'string' && (BUILTIN_PET_SPECIES as readonly string[]).includes(v)
}
