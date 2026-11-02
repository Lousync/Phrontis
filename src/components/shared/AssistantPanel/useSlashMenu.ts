/**
 * 斜杠指令弹层的状态与键盘语义（v3.16.1 F-2 抽口）
 *
 * 背景：`/` 弹层此前在 ChatBody / AI 教学输入卡里各写一份「查询词派生 + ↑↓/Enter/Tab/Esc」，
 * 工作台 AI 助手模块（第三处输入卡）漏接，表现为敲 `/` 毫无反应。本 hook 把这段纯逻辑抽出来，
 * 新宿主只负责渲染 `<SlashCommandMenu>` 与挂 `onKeyDown`，避免再出现「新增输入卡漏接共享能力」。
 *
 * 口径与 ChatBody 现有实现一致：
 *  - 输入为「/ + 无空白词」时打开（单独一个 `/` 也打开）；
 *  - 候选 = CHAT_COMMANDS + PASSTHROUGH_COMMANDS + 已安装 Skill，按聊天面过滤；
 *  - Enter 只选中不发送（宿主用 `e.defaultPrevented` 判断是否继续走发送）。
 */
import { useCallback, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SkillInfo } from '../../../types'
import type { ChatSurface } from '../../../lib/chatCommands'
import { buildSlashItems, filterSlashItems, type SlashMenuItem } from '../SlashCommandMenu'

interface UseSlashMenuArgs {
  input: string
  setInput: (v: string) => void
  skills: SkillInfo[]
  surface?: ChatSurface
  /** 选中 Skill：宿主挂 chip（指令则只补全输入框） */
  onPickSkill: (skill: SkillInfo) => void
  /** 补全后把焦点交回 textarea */
  focus?: () => void
}

export interface SlashMenuState {
  open: boolean
  items: SlashMenuItem[]
  activeIndex: number
  setActiveIndex: (index: number) => void
  pick: (item: SlashMenuItem) => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void
}

export function useSlashMenu({ input, setInput, skills, surface, onPickSkill, focus }: UseSlashMenuArgs): SlashMenuState {
  const [activeIndex, setActiveIndex] = useState(0)

  /** 输入为「/ + 无空白词」时返回检索词；`/` 单独 → ''；否则 null（关闭） */
  const query = input.startsWith('/') && !/[\s\n]/.test(input.slice(1))
    ? (input.length > 1 ? input.slice(1) : '')
    : null

  const items = useMemo(
    () => filterSlashItems(buildSlashItems(skills ?? [], [], surface), query ?? ''),
    [skills, query, surface],
  )
  const open = query !== null

  /** 选中：指令补全到输入框（回车执行走既有拦截链）；Skill 挂 chip、清输入继续写正文 */
  const pick = useCallback((item: SlashMenuItem) => {
    if (item.kind === 'command') {
      setInput('/' + item.name + ' ')
      setActiveIndex(0)
      focus?.()
      return
    }
    const skill = (skills ?? []).find((s) => s.registryName === item.name)
    if (skill) {
      onPickSkill(skill)
      setInput('')
      setActiveIndex(0)
      focus?.()
    }
  }, [skills, setInput, onPickSkill, focus])

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || items.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % items.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + items.length) % items.length)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const item = items[activeIndex] ?? items[0]
      if (item) pick(item)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const item = items[activeIndex] ?? items[0]
      if (item) pick(item)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setInput('')
      setActiveIndex(0)
    }
  }, [open, items, activeIndex, pick, setInput])

  return { open, items, activeIndex, setActiveIndex, pick, onKeyDown }
}
