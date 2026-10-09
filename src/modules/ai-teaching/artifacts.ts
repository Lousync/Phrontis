/** 工件栏页签模型（docs/ai-teaching-artifacts-pane-design.md §1.4/§2）：
 *  md=讲义/提取稿/报告（原 docView）；html=visual.html 示意图产物（含「生成中」占位）；pptx=逐页阅读（原 reader）；
 *  mindmap=思维导图 JSON（会话产物，共享 MindMapView 渲染） */
export interface ArtTab {
  /** 稳定 id：常规=rel；生成中占位=gen:<slug> */
  id: string
  kind: 'md' | 'html' | 'pptx' | 'mindmap'
  /** 仓库相对路径（生成中占位为空串） */
  rel: string
  /** 页签/工件卡展示名 */
  name: string
  /** 生成中占位页签：禁止关闭，无内容 */
  generating?: boolean
  /** visual.html 参数 slug（占位↔正式页签原地替换的匹配键） */
  slug?: string
  /** visual.html 标题 */
  title?: string
  /** 产物行数（工件卡/工具条展示） */
  lines?: number
  /** md 页签：文件全文 */
  content?: string
  /** pptx 页签：逐页文本 + 当前页 */
  pages?: Array<{ n: number; text: string }>
  cur?: number
}
