/**
 * AI教学 · 课程文件夹布局纯函数（chapter-segment-v1）。
 *
 * 目标布局（**唯一真相源**，主进程与契约脚本共用）：
 *   {工作区}/第N章 章名/段N
 *   {工作区}/第N章 章名/章末复习/
 *   {工作区}/第N章 章名/知识点/{NN} 知识点/   ← 可选元数据，不自动创建
 *
 * 上一版（v3.16 `chapter-unit-v1`）：
 *   {工作区}/第N章 章名/{NN} 知识点/段N
 *
 * 本文件零 fs / electron 依赖，只做「名称、路径、迁移对」的推导，
 * 让自动迁移与契约脚本能直接 import，不把路径规则散落在多个模块。
 */

import type { CourseOutline } from './aiTeachingCoursePure'

export const REVIEW_FOLDER_NAME = '章末复习'
export const UNIT_META_FOLDER_NAME = '知识点'
export const LAYOUT_VERSION = 'chapter-segment-v1'

/** 目录名清洗：非法字符→空格、折叠空白、截 40、去尾点尾空格 */
export function folderSegment(v: unknown, fallback = '未命名'): string {
  const cleaned = String(v ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .replace(/[. ]+$/, '')
  return cleaned || fallback
}

/** 章名开头的“第X章”前缀（中文数字 / 阿拉伯数字 / 全角空格 / 常见分隔符） */
const CHAPTER_PREFIX_RE = /^\s*第\s*[0-9〇零一二三四五六七八九十百千两]+\s*章[\s·:：.．\-—_]*/u

/** 目录名只保留课程顺序号：剥掉章名自带的“第X章”，避免“第2章 第1章 ...” */
export function stripLeadingChapterNumber(v: unknown): string {
  return String(v ?? '').replace(CHAPTER_PREFIX_RE, '').trim()
}

/** 章目录名：`第1章 微处理器与微机`（章名自带的“第X章”会被剥掉） */
export function chapterFolderName(index: number, name: string): string {
  return `第${Number(index) + 1}章 ${folderSegment(stripLeadingChapterNumber(name), '未命名')}`
}

/** v3.16 旧章目录名：`第2章 第1章 输入输出技术基础`（迁移定位用，章名原样保留） */
export function chapterFolderNameV316(index: number, name: string): string {
  return `第${Number(index) + 1}章 ${folderSegment(name, '未命名')}`
}

/** 知识点元数据目录名：`01 微处理器、微机与单片机` */
export function unitFolderName(index: number, name: string): string {
  return `${String(Number(index) + 1).padStart(2, '0')} ${folderSegment(name, '知识点')}`
}

/** 段目录名：只写 `段N`，不带知识点名 */
export function segmentFolderName(order: number): string {
  return `段${Number(order)}`
}

export interface LayoutUnit {
  unitId: string
  chapterId: string
  chapterIndex: number
  unitIndex: number
  unitName: string
  chapterName: string
  /** 新布局：{工作区}/第N章 章名/知识点/{NN} 知识点 */
  unitRel: string
  /** v3.16 旧路径：{工作区}/第N章 章名/{NN} 知识点 */
  v316UnitRel: string
  /** SOURCES 平铺夹名：{章号}·{知识点} */
  sourceKey: string
}

export interface LayoutChapter {
  chapterId: string
  chapterIndex: number
  chapterName: string
  /** 新章节夹：{工作区}/第N章 章名 */
  chapterRel: string
  /** v3.16 旧章节夹：{工作区}/第N章 章名（章名原样，可能含自带第X章） */
  v316ChapterRel: string
  /** 新复习夹：{工作区}/第N章 章名/章末复习 */
  reviewRel: string
  /** v3.16 旧复习夹：{工作区}/第N章 章名/章末复习 */
  v316ReviewRel: string
  units: LayoutUnit[]
}

export interface CourseLayoutPlan {
  wsRel: string
  chapters: LayoutChapter[]
  /** 扁平索引，迁移按 unitId 查 */
  units: LayoutUnit[]
}

function relJoin(...parts: string[]): string {
  return parts
    .map((p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

/** 由大纲生成完整布局计划：同时给新路径与 v3.16 旧路径，迁移/改名共用一份规则 */
export function buildCourseLayoutPlan(outline: CourseOutline, wsRel: string): CourseLayoutPlan {
  const ws = relJoin(wsRel)
  const chapters: LayoutChapter[] = []
  const units: LayoutUnit[] = []
  ;(outline?.chapters ?? []).forEach((chapter, ci) => {
    const chapterRel = relJoin(ws, chapterFolderName(ci, chapter.name))
    const v316ChapterRel = relJoin(ws, chapterFolderNameV316(ci, chapter.name))
    const ch: LayoutChapter = {
      chapterId: chapter.id,
      chapterIndex: ci,
      chapterName: chapter.name,
      chapterRel,
      v316ChapterRel,
      reviewRel: relJoin(chapterRel, REVIEW_FOLDER_NAME),
      v316ReviewRel: relJoin(v316ChapterRel, REVIEW_FOLDER_NAME),
      units: [],
    }
    ;(chapter.units ?? []).forEach((unit, ui) => {
      const u: LayoutUnit = {
        unitId: unit.id,
        chapterId: chapter.id,
        chapterIndex: ci,
        unitIndex: ui,
        unitName: unit.name,
        chapterName: chapter.name,
        unitRel: relJoin(chapterRel, UNIT_META_FOLDER_NAME, unitFolderName(ui, unit.name)),
        v316UnitRel: relJoin(v316ChapterRel, unitFolderName(ui, unit.name)),
        sourceKey: `${ci + 1}·${folderSegment(unit.name)}`,
      }
      ch.units.push(u)
      units.push(u)
    })
    chapters.push(ch)
  })
  return { wsRel: ws, chapters, units }
}

/** 仓库相对路径前缀替换；不匹配返回 null（调用方据此判断是否要改写） */
export function rewriteRelPrefix(rel: string | null | undefined, from: string, to: string): string | null {
  const value = String(rel ?? '').replace(/\\/g, '/')
  const src = String(from ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const dst = String(to ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!value || !src) return null
  if (value === src) return dst
  if (value.startsWith(`${src}/`)) return `${dst}${value.slice(src.length)}`
  return null
}

/** 段目录相对路径：`{章}/段N` */
export function segmentRel(chapterRel: string, order: number): string {
  return relJoin(chapterRel, segmentFolderName(order))
}

/**
 * 由知识点目录反解「平铺 SOURCES 夹」：
 *   新布局 `第N章 章名/知识点/{NN} 知识点` → `{N}·{知识点}`
 *   v3.16  `第N章 章名/{NN} 知识点`        → `{N}·{知识点}`
 *   旧扁平  `{N}·{知识点}`                 → 原样
 * `SOURCES` 本期仍平铺，路径解析必须兼容。
 */
export function sourceKeyFromUnitRel(unitFolder: string | null | undefined): { wsRel: string; key: string } | null {
  const dir = String(unitFolder ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!dir) return null
  const parts = dir.split('/').filter(Boolean)

  // 新布局：.../第N章 章名/知识点/{NN} 知识点
  if (parts.length >= 5 && parts[parts.length - 2] === UNIT_META_FOLDER_NAME) {
    const unitSeg = parts[parts.length - 1]
    const chapterSeg = parts[parts.length - 3]
    const chapter = /^第(\d+)章\s+/.exec(chapterSeg)
    const unit = /^\d+\s+(.+)$/.exec(unitSeg)
    if (chapter && unit) {
      return { wsRel: parts.slice(0, -3).join('/'), key: `${chapter[1]}·${unit[1]}` }
    }
  }

  // v3.16：.../第N章 章名/{NN} 知识点
  if (parts.length >= 3) {
    const unitSeg = parts[parts.length - 1]
    const chapterSeg = parts[parts.length - 2]
    const chapter = /^第(\d+)章\s+/.exec(chapterSeg)
    const unit = /^\d+\s+(.+)$/.exec(unitSeg)
    if (chapter && unit) {
      return { wsRel: parts.slice(0, -2).join('/'), key: `${chapter[1]}·${unit[1]}` }
    }
  }

  // 旧扁平：{N}·{知识点}
  const unitSeg = parts[parts.length - 1] ?? ''
  if (/^(\d+)·(.+)$/.test(unitSeg)) {
    return { wsRel: parts.slice(0, -1).join('/'), key: unitSeg }
  }
  return null
}
