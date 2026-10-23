import { parseQuickDate } from '../../daypanel/parseQuickDate'

export interface QuickAddTagLike {
  id: string
  name: string
}

export interface QuickAddResult {
  title: string
  date: string
  time: string | null
  tagId: string | null
  tagName: string | null
  estimateMin: number | null
  deadline: string | null
}

function strip(text: string, matched: string): string {
  return text.replace(matched, ' ').replace(/\s+/g, ' ').trim()
}

export function parseQuickAdd(raw: string, tags: QuickAddTagLike[], now = new Date()): QuickAddResult {
  const parsed = parseQuickDate(raw, now)
  let title = parsed.title
  let date = parsed.date
  let time = parsed.time
  let tagId: string | null = null
  let tagName: string | null = null
  let estimateMin: number | null = null
  let deadline: string | null = null

  const tagMatch = /#([^\s#]+)/.exec(title)
  if (tagMatch) {
    const name = tagMatch[1].trim()
    const tag = tags.find(t => t.name === name)
    tagName = name
    tagId = tag?.id ?? null
    title = strip(title, tagMatch[0])
  }

  const hourMatch = /(?:^|\s)(\d+(?:\.\d+)?)\s*(?:h|小时|hr|hour)(?=\s|$)/i.exec(title)
  if (hourMatch) {
    estimateMin = Math.round(Number(hourMatch[1]) * 60)
    title = strip(title, hourMatch[0])
  } else {
    const minuteMatch = /(?:^|\s)(\d+)\s*(?:m|分钟|min)(?=\s|$)/i.exec(title)
    if (minuteMatch) {
      estimateMin = Number(minuteMatch[1])
      title = strip(title, minuteMatch[0])
    }
  }

  const deadlineDate = /截止\s*(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/.exec(title)
  if (deadlineDate) {
    deadline = `${deadlineDate[1]} ${deadlineDate[2] || '23:59'}`
    title = strip(title, deadlineDate[0])
  } else {
    const deadlineTime = /截止\s*(\d{1,2}:\d{2})/.exec(title)
    if (deadlineTime) {
      deadline = `${date} ${deadlineTime[1].padStart(5, '0')}`
      title = strip(title, deadlineTime[0])
    }
  }

  if (!title.trim()) title = raw.trim()
  if (date === '') date = parsed.date
  if (time && !deadline) deadline = `${date} ${time}`
  return { title, date, time, tagId, tagName, estimateMin, deadline }
}
