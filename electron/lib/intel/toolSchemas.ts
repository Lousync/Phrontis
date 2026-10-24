import type { ToolJsonSchema } from '../aiTools'

/**
 * intel.* 三个 AI 工具的入参 schema（v3.12.0，docs/intel-module-plan.md §7.4）。
 *
 * 独立零依赖文件的原因：契约脚本 verify-intel-tools.mjs 要**直接 import 真实现**
 * 断言「schema ≤800 字符」（铁律 16）——builtinTools.ts 本体挂着 electron/业务依赖树，
 * 裸 node 解析不了；schema 抽出来后脚本 strip-types 直跑，断言的是同一份对象而非正则抄写。
 * builtinTools.ts 注册时引用这里的常量，改 schema 改这一处。
 */

export const INTEL_QUERY_SCHEMA: ToolJsonSchema = {
  type: 'object',
  properties: {
    q: { type: 'string', description: '关键词，标题+摘要匹配' },
    source: { type: 'string', description: '源 key：github/hn/arxiv/openalex/weekly/hf/labs/qbitai' },
    kind: { type: 'string', description: '类型：repo/news/paper/weekly/blog' },
    limit: { type: 'number', description: '上限，默认 20' },
  },
}

export const INTEL_SET_REC_SCHEMA: ToolJsonSchema = {
  type: 'object',
  properties: {
    ids: { type: 'array', items: { type: 'string' }, description: '条目 id 集（3~8 条为宜）' },
    query: { type: 'string', description: '用户当时的问句原话' },
    note: { type: 'string', description: '一句话说明（可选）' },
  },
  required: ['ids', 'query'],
}

export const INTEL_SET_FILTER_SCHEMA: ToolJsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', description: "'paper' | 'chinese' | ''（清除）" },
    kw: { type: 'string', description: '关键词（空串 = 清除关键词）' },
  },
}
