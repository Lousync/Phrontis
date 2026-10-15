import type { LlmProviderType } from '../types'

/**
 * 供应商预设（2026-10-13，按原型 tmp/ai-settings-proto 的 PRESETS 落地）。
 *
 * 预设**不只是省打字**：它携带 5 样东西，后三样恰恰是"用户不可能知道的东西"——
 *   1. 名称与品牌色；
 *   2. 接口地址；
 *   3. **协议类型**（端点的默认档；同一端点内逐模型的差异仍由「逐模型协议」覆盖）；
 *   4. **必需的请求头**（opencode 网关要 `x-opencode-session`，不带会拿不到应有的路由与缓存）；
 *   5. **模型怎么录入的指路**（火山方舟这类平台没有可下拉的清单，得粘接入点 ID `ep-…`，
 *      给一个空输入框等于把人扔在原地）。
 *
 * ★ 地址核实状态（老实标注，不假装核过）——
 *   · opencode：`https://opencode.ai/inference/go/v1` 取自官方文档 console/go 的 **Go 端点表**，
 *     已核实（同一页还要求客户端带稳定的每对话会话 ID 与自定义 UA）；
 *   · DeepSeek / 通义千问 / Kimi / 智谱 GLM：按原型与公开记忆填入，**本次没能联网复核**
 *     （本机 web_search 坏、shell 无出网），界面不因此标红，但改地址前建议先点「测试连接」；
 *   · 豆包·火山方舟：`unverified`（仓库里 `volces / ark.cn / doubao` 零命中，等于从未支持过）。
 */
export interface LlmPreset {
  id: string
  name: string
  /** 卡片副标题（品牌归属之类） */
  sub: string
  base: string
  type: LlmProviderType
  /** 卡片上的品牌色圆点 */
  color: string
  /** 这家没有可下拉的模型清单：模型那一栏要填接入点 ID（ep-…） */
  modelInput?: 'endpoint'
  /** 预设替你带上的请求头。value 是**常量占位**，真实调用会按对话覆盖成当前会话 ID */
  header?: Record<string, string>
  /** 地址未能在线核实 —— 界面上要显式写出来 */
  unverified?: boolean
  /** 说明取自官方文档，值得展示出处 */
  srcConfig?: boolean
  /** 模型那一栏怎么填的指路（modelInput==='endpoint' 时必填） */
  modelHint?: string
}

export const LLM_PRESETS: LlmPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', sub: '官方 API', base: 'https://api.deepseek.com/v1', type: 'openai-compatible', color: '#4d6bfe' },
  { id: 'qwen', name: '通义千问', sub: '阿里云 DashScope', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', type: 'openai-compatible', color: '#615ced' },
  {
    id: 'doubao', name: '豆包 · 火山方舟', sub: '字节跳动', base: 'https://ark.cn-beijing.volces.com/api/v3',
    type: 'openai-compatible', color: '#1664ff', modelInput: 'endpoint', unverified: true,
    modelHint: '该平台没有可下拉的模型清单，「模型」一栏需填写接入点 ID（以 ep- 开头）：请在火山方舟控制台 →「在线推理」中复制接入点 ID。较新的接入点也接受模型名（如 doubao-seed-1-6-…）。',
  },
  { id: 'kimi', name: 'Kimi', sub: '月之暗面', base: 'https://api.moonshot.cn/v1', type: 'openai-compatible', color: '#0b0b0b' },
  { id: 'glm', name: '智谱 GLM', sub: 'bigmodel.cn', base: 'https://open.bigmodel.cn/api/paas/v4', type: 'openai-compatible', color: '#3859ff' },
  {
    id: 'opencode', name: 'opencode', sub: 'opencode.ai 网关',
    // 官方文档现在写的就是这条（旧路径 /zen/go/v1 还活着但模型清单不一样）
    base: 'https://opencode.ai/inference/go/v1', type: 'openai-compatible', color: '#9a9a9a',
    // 官方要求「每个对话一个稳定的会话 ID，用于优化路由与 prompt 缓存」。
    // 这里只是**声明**这个头存在（withSessionHeaders 据此把真实会话 ID 填进去）；
    // 常量值仅在"没有对话上下文"的调用里兜底。
    header: { 'x-opencode-session': 'phrontis' },
    srcConfig: true,
    modelHint: '该端点同时提供三种协议（chat / messages / responses），协议属于模型自身的属性：添加后可通过「按官方端点表标记」批量预填，或逐条手动指定。',
  },
  { id: 'ollama', name: 'Ollama 本地', sub: '本机运行，无需 API Key', base: 'http://localhost:11434', type: 'ollama', color: '#8a8a8a' },
  { id: 'custom', name: '自定义 / 网关', sub: '任意兼容端点', base: '', type: 'openai-compatible', color: '#6a6a6a' },
]

export function presetById(id: string): LlmPreset | undefined {
  return LLM_PRESETS.find(p => p.id === id)
}

/** 添加表单右上角那句话：先说清"还差哪一步"，别让人以为漏填了 */
export function presetAddChip(p: LlmPreset): string {
  if (p.type === 'ollama') return '本地服务，无需 API Key'
  if (p.modelInput === 'endpoint') return '需填写 API Key 与接入点 ID'
  return '仅需填写 API Key'
}
