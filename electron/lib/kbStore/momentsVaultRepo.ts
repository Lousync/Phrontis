import { exists, readJson, writeJson } from './jsonStore'

/**
 * 说说 vault 数据仓库（去库化 P2）：`.knowbase/modules/moments/{posts.json, albums.json}`
 *
 * 行结构与 moments_posts / moments_albums 表行一致（snake_case 原样保留，与迁移器
 * 迁移器产物、回收站快照兼容）；images_data_urls / attachment_ids /
 * tags 等列内 JSON 字符串保持为字符串（不反序列化），parse 与 DTO 映射归 momentsRepo。
 * 文件顺序 = 表插入顺序（对应 sqlite 无 ORDER BY 的 SELECT * 语义），排序由调用方做。
 */
export interface MomentsRow {
  id: string
  content_md: string
  content_html: string | null
  image_data_url: string | null
  images_data_urls: string | null
  tags: string | null
  album_id: string | null
  attachment_ids: string | null
  is_pinned: number
  show_in_timeline: number | null
  created_at: string
  updated_at: string
}

export interface AlbumRow {
  id: string
  name: string
  cover_data_url: string | null
  cover_post_id: string | null
  cover_index: number | null
  created_at: string
  updated_at: string
}

const MOD = 'modules/moments'
const POSTS_FILE = 'posts.json'
const ALBUMS_FILE = 'albums.json'


/** 按表列默认值补齐缺失字段（手工编辑过的 json 也保持表行形状） */
function normPost(r: Record<string, unknown>): MomentsRow {
  return {
    id: (r.id as string) ?? '',
    content_md: (r.content_md as string) ?? '',
    content_html: (r.content_html as string) ?? null,
    image_data_url: (r.image_data_url as string) ?? null,
    images_data_urls: (r.images_data_urls as string) ?? '[]',
    tags: (r.tags as string) ?? '[]',
    album_id: (r.album_id as string) ?? '',
    attachment_ids: (r.attachment_ids as string) ?? '[]',
    is_pinned: r.is_pinned ? 1 : 0,
    // 列约束 NOT NULL DEFAULT 1：仅显式 0 视为隐藏，其余（含缺失）按显示
    show_in_timeline: r.show_in_timeline === 0 ? 0 : 1,
    created_at: (r.created_at as string) ?? '',
    updated_at: (r.updated_at as string) ?? '',
  }
}

function normAlbum(r: Record<string, unknown>): AlbumRow {
  return {
    id: (r.id as string) ?? '',
    name: (r.name as string) ?? '',
    cover_data_url: (r.cover_data_url as string) ?? '',
    cover_post_id: (r.cover_post_id as string) ?? '',
    cover_index: typeof r.cover_index === 'number' ? r.cover_index : 0,
    created_at: (r.created_at as string) ?? '',
    updated_at: (r.updated_at as string) ?? '',
  }
}

/** 全部说说行（文件原序，不做排序） */
export function vaultPostsAll(): MomentsRow[] {
  return readJson<Record<string, unknown>[]>(MOD, POSTS_FILE, []).map(normPost)
}

export function vaultPostsSave(rows: MomentsRow[]): void {
  writeJson(MOD, POSTS_FILE, rows)
}

/** 全部相册行（文件原序，不做排序） */
export function vaultAlbumsAll(): AlbumRow[] {
  return readJson<Record<string, unknown>[]>(MOD, ALBUMS_FILE, []).map(normAlbum)
}

export function vaultAlbumsSave(rows: AlbumRow[]): void {
  writeJson(MOD, ALBUMS_FILE, rows)
}
