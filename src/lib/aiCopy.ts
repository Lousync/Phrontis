/**
 * AI 面共用文案（单一真源）。
 *
 * 为什么单独一层：同一句提示散落在 AI 教学 / AI 助手 / AI 学堂 / 设置四套界面里，
 * 任何一次口径调整都要改 4–6 处且必然漏一处（2026-11-24 文案审计结论）。
 * 这里只放**字符串常量**，不放组件、不依赖 React / Electron，任何层都能 import。
 *
 * 文案口径：只收不删 —— 关键语义（视觉模型名、不消耗 token、已完成轮次保留）保留在常量里，
 * 只是不再在多个入口各写一遍。
 */

/** 当前模型不支持图片：短标题（行内横条 / 弹层正文） */
export const IMAGE_MODEL_TITLE = '当前模型不支持图片输入'

/** 视觉模型选型指引（关键语义，不能删；横条与 toast 共用同一句） */
export const IMAGE_MODEL_HINT = '请在模型菜单切换到视觉模型（名称含 vision / vl / 4o / glm-4v 等）'

/** 行内警告条的一整句（标题 + 指引） */
export const IMAGE_MODEL_WARN = `${IMAGE_MODEL_TITLE}。${IMAGE_MODEL_HINT}。`

/** 发送钮 tooltip 的短版 */
export const IMAGE_MODEL_SHORT = '当前模型不支持图片'

/** 感知模式说明（设置条目 / 设置页 ⓘ / 两处开关 tooltip 共用；不消耗 token 与降级规则必须保留） */
export const PERCEPTION_DESC = '发送前自动检索知识库，将最相关的笔记内容注入本轮上下文；检索在本地完成（至多一次向量化调用，不消耗对话 token）。未配置向量模型时自动降级为关键词匹配'

/** 压缩进行中的行内占位（去掉「可能数十秒 / 期间暂不能发送」的括号解释；按钮 disabled 已表达限制） */
export const COMPRESSING_INLINE = '正在压缩对话历史…'

/** 压缩进行中的 tooltip（发送键 / 旁问等短提示） */
export const COMPRESSING_TIP = '正在压缩对话历史，请稍候'

/** 用户真的点了发送时的 toast（解释为什么这次不能发） */
export const COMPRESSING_TOAST = '正在压缩对话历史，请稍候再发送'

/** 停止生成按钮的 tooltip / aria-label（四个宿主共用） */
export const STOP_RUN_TIP = '停止生成（已完成的轮次保留）'
