import { randomBytes } from 'crypto'
import { readJson, writeJsonOrThrow } from '../kbStore/jsonStore'
import { broadcastDataChanged } from '../../main/windowBus'
import type { IntelCustomSource, IntelSection } from '../../../src/types'

/**
 * 用户自定义 RSS 源 CRUD（v2，docs/intel-module-plan.md D12）。
 * 随仓库走：.knowbase/modules/intel/sources.json；开关也存这里（不进 SETTINGS——换仓库即换一套源）。
 * 增删改后 broadcastDataChanged('intel')，侧栏 / 设置编辑器 / feed 即时刷新。
 */

const MOD = 'modules/intel'
const MAX_CUSTOM = 20

const SECTIONS: readonly IntelSection[] = ['tech', 'domestic', 'world', 'finance']

export function intelListCustomSources(): IntelCustomSource[] {
  const list = readJson<unknown[]>(MOD, 'sources.json', [])
  return (Array.isArray(list) ? list : []).filter((s): s is IntelCustomSource =>
    !!s && typeof s === 'object' && typeof (s as IntelCustomSource).id === 'string' && typeof (s as IntelCustomSource).url === 'string')
}

export function intelAddCustomSource(d: { name: string; url: string; section: IntelSection }): { ok: true; source: IntelCustomSource } | { ok: false; error: string } {
  const name = String(d?.name ?? '').trim().slice(0, 40)
  const url = String(d?.url ?? '').trim()
  const section = SECTIONS.includes(d?.section) ? d.section : 'tech'
  if (!name) return { ok: false, error: '名称不能为空' }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '地址必须是 http(s):// 开头的 RSS/Atom 链接' }
  const list = intelListCustomSources()
  if (list.some((s) => s.url === url)) return { ok: false, error: '该地址已添加过（同名源去重）' }
  if (list.length >= MAX_CUSTOM) return { ok: false, error: `自定义源上限 ${MAX_CUSTOM} 个，先删掉不用的再加` }
  const source: IntelCustomSource = { id: randomBytes(3).toString('hex'), name, url, section, enabled: true }
  writeJsonOrThrow(MOD, 'sources.json', [...list, source])
  broadcastDataChanged('intel')
  return { ok: true, source }
}

export function intelRemoveCustomSource(id: string): boolean {
  const list = intelListCustomSources()
  const next = list.filter((s) => s.id !== id)
  if (next.length === list.length) return false
  writeJsonOrThrow(MOD, 'sources.json', next)
  broadcastDataChanged('intel')
  return true
}

export function intelToggleCustomSource(id: string): IntelCustomSource | null {
  const list = intelListCustomSources()
  const i = list.findIndex((s) => s.id === id)
  if (i < 0) return null
  list[i] = { ...list[i], enabled: !list[i].enabled }
  writeJsonOrThrow(MOD, 'sources.json', list)
  broadcastDataChanged('intel')
  return list[i]
}
