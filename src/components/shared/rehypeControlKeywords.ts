/**
 * rehype 后处理：给 highlight.js 的 `hljs-keyword` 补 `hljs-control`。
 *
 * 必须排在 rehypeHighlight **之后** —— 先有 hljs 的 span，才能按文本判断控制流关键字。
 * 不引 unist-util-visit：这里只需要一次深度优先遍历，手写十行即可，少一个直接依赖。
 */
import { isControlKeyword } from '../../lib/controlKeywords'

type HastNode = {
  type?: string
  tagName?: string
  value?: string
  properties?: { className?: string[] | string }
  children?: HastNode[]
}

function visit(node: HastNode | undefined): void {
  if (!node || typeof node !== 'object') return

  if (node.type === 'element' && node.tagName === 'span') {
    const props = (node.properties ??= {})
    const raw = props.className
    const classes = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? raw.split(/\s+/).filter(Boolean)
        : []
    if (classes.includes('hljs-keyword') && !classes.includes('hljs-control')) {
      const text = (node.children ?? [])
        .filter(child => child.type === 'text')
        .map(child => child.value ?? '')
        .join('')
      if (isControlKeyword(text)) {
        classes.push('hljs-control')
        props.className = classes
      }
    }
  }

  for (const child of node.children ?? []) visit(child)
}

export default function rehypeControlKeywords() {
  return (tree: HastNode): void => { visit(tree) }
}
