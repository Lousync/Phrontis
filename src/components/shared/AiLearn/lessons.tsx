import type { ReactNode } from 'react'
import type { TabName } from '../../../types'

/**
 * AI 学堂 · 上手路径教程数据
 *
 * 定位：这里是 UI 资产，主进程不需要知道内容。用户在「第几步」通过
 * AgentContextInfo 传给主进程（见 docs/ai-learn-center-design.md §6）。
 *
 * 内容原则（§7.6）：可判定、可执行、覆盖误用、可互链。
 * P3 阶段会把这批文案与 resources/help/ 下的《快速上手》收敛为同一份真相源。
 */

/** 「动手做」：点了先收起学堂再跳目标模块（避免浮层压住目标） */
export interface LessonAction {
  label: string
  /** 目标模块；缺省 = 不跳转（该步的动作用户就在学堂里完成，如「问 AI」） */
  goto?: TabName
}

export interface Lesson {
  /** 步骤序号，从 1 起 */
  n: number
  title: string
  /** 展示用时长，如 '2 分钟' */
  minutes: string
  /** 这一步做完应该达到什么 —— 同时会作为提问上下文注入 AI */
  goal: string
  /** 关联的 help 文档 id（P2 接通手册检索后生效） */
  docId?: string
  body: ReactNode
  action?: LessonAction
  /** 右栏快捷提问 chips */
  ask?: string[]
}

/** 讲义里的关键提醒块（对应原型里的蓝色左边框 callout） */
function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="my-3 rounded-r-lg border-l-[3px] border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_9%,transparent)] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
      {title && <b className="text-[var(--text-primary)]">{title}</b>}
      {children}
    </div>
  )
}

const P = ({ children }: { children: ReactNode }) => (
  <p className="my-2.5 text-[13px] leading-[1.85] text-[var(--text-secondary)]">{children}</p>
)

const B = ({ children }: { children: ReactNode }) => (
  <b className="font-medium text-[var(--text-primary)]">{children}</b>
)

const C = ({ children }: { children: ReactNode }) => (
  <code className="rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1 font-mono text-[12px]">{children}</code>
)

export const LESSONS: Lesson[] = [
  {
    n: 1,
    title: '认准三块地方',
    minutes: '30 秒',
    goal: '分清「图标条 / 左栏 / 中间内容区」各自负责什么',
    docId: '快速上手',
    action: { label: '去笔记区看看', goto: 'knowledge' },
    ask: ['图标条和左栏怎么分工？', '我可以只用笔记吗？'],
    body: (
      <>
        <P><B>图标条</B>（最左侧一列图标，设置里叫「活动栏」）决定你进哪个整窗模块（AI 教学 / 回收站 / 插件 / 动态 / 书市），点顶部「工作台」按钮随时回来。</P>
        <P><B>左栏</B>是书签与文件树：点书签在工作台内换内容（看板 / 笔记 / 日程 / 书架 / 博客总结 / 记账 / 终端），点左栏头的树按钮就换成整个仓库的文件树。</P>
        <P><B>中间内容区</B>是唯一能写正文的地方：笔记正文在这里编辑、自动保存，不用 <C>Ctrl S</C>；知识库是笔记模块的左栏形态，负责阅读与组织（双链、标签、知识图谱、全文搜索）。</P>
        <Note title="一句话心智：">左栏找文件，中间写内容。后面 90% 的「为什么找不到」都源于这一句没记住。</Note>
      </>
    ),
  },
  {
    n: 2,
    title: '写下第一页',
    minutes: '2 分钟',
    goal: '真的在仓库目录里落下一个 .md 文件',
    docId: '快速上手',
    action: { label: '新建第一篇笔记', goto: 'knowledge' },
    ask: ['新建文件有哪几种方式？', '文件默认存在哪个目录？'],
    body: (
      <>
        <P>在笔记区左栏的文件树点 <C>+</C> 新建文件，或直接按 <C>Ctrl N</C>。名字随意，例如 <C>我的第一篇笔记.md</C>。</P>
        <P>写点什么，停手一秒 —— 笔记区右下角会闪一下「已保存」。这个文件真实落在你选的仓库文件夹里，可以用资源管理器打开确认。</P>
        <Note title="常问：文件存哪了？">存在你自己选的那个仓库文件夹里。它就是一个普通 <C>.md</C> 文件，用 VS Code、Typora 也能直接打开。</Note>
      </>
    ),
  },
  {
    n: 3,
    title: '为什么知识库里看不到我的文件',
    minutes: '3 分钟',
    goal: '知道 .md 都会进知识库，看不到时该查什么',
    docId: '读写分工与草稿机制',
    action: { label: '去笔记区看看', goto: 'knowledge' },
    ask: ['一定要写 frontmatter 吗？', '文件被隐藏了怎么找回来？'],
    body: (
      <>
        <P>在仓库里新建一个 <C>.md</C>，它<B>一定会进知识库</B> —— 不需要你手写 frontmatter。没有 <C>id</C> 的文件会先拿一个临时身份（<C>auto:路径</C>）入列，你第一次保存时软件自动补上真 id。</P>
        <P>所以「看不到」通常只有三个原因：文件不在当前仓库文件夹里、被 <C>.ignore</C> 规则命中、或者界面还没刷新（约 1 秒）。</P>
        <Note title="不想收录就走 .ignore">在仓库根写一行目录名或路径，命中的目录与文件都不参与知识库、知识图谱与全文搜索；删掉那一行即恢复收录。</Note>
      </>
    ),
  },
  {
    n: 4,
    title: '建立第一条连接',
    minutes: '3 分钟',
    goal: '让两篇笔记之间出现一条线',
    docId: '笔记 · 双链与关联网络',
    action: { label: '给笔记加个标签', goto: 'knowledge' },
    ask: ['标签和双链该用哪个？', '双链写错了会怎样？'],
    body: (
      <>
        <P><B>标签</B> <C>#考研408</C> 用来分类，知识库里可以按标签筛选。</P>
        <P><B>双链</B> <C>[[虚拟存储器]]</C> 指向另一篇页面；被指向的那篇，编辑器右栏「<B>关联网络</B>」的「被引用」一节会列出本页，点一下直接跳到引用处并高亮。</P>
        <P>想看全局关系，切到「<B>知识图谱</B>」，你会看到节点与连线 —— 这就是你的知识地图。</P>
        <Note title="双链写错了会怎样">标题写错时<B>不会自动建页</B>，点它会提示「未找到『X』」，去「新建知识页」建这一页即可。</Note>
      </>
    ),
  },
  {
    n: 5,
    title: '让 AI 帮你干活',
    minutes: '3 分钟',
    goal: '知道 AI 能做什么、不能做什么',
    docId: 'AI 权限与工具边界',
    action: { label: '就在这里问一句' },
    ask: ['AI 能直接改我的文件吗？', '权限在哪里设置？'],
    body: (
      <>
        <P><C>Ctrl J</C> 唤起 AI 侧栏；选中任意文字还会浮出「问 AI」。侧栏头部右上角的 <B>⤢ 按钮</B>就是本模块的主角 —— 点它，侧栏原地扩成整个工作区。</P>
        <P>AI 不只是聊天：它能调用工具读你的文件、写文件、整理笔记。每条回复下方可以展开<B>调用轨迹</B>，写完还会列出<B>本次已改动 N 项</B>，可点开对应文件。</P>
        <P>权限按模块控制：设置 → AI 工具 → 权限。某个模块设为「禁止」，AI 就完全看不到它。</P>
        <Note title="写盘后会自动广播刷新。">界面立刻更新。如果没更新，说明这次其实没写成功 —— 别急着信「已完成」。</Note>
      </>
    ),
  },
  {
    n: 6,
    title: '备份与找回',
    minutes: '2 分钟',
    goal: '知道数据存在哪，出事了能救回来',
    docId: '常见问题',
    action: { label: '导出一次备份', goto: 'toolbox' },
    ask: ['备份包含附件吗？', '误删的文件去哪找？'],
    body: (
      <>
        <P>数据全部在本机，没有云端。仓库本身就是一个文件夹，直接复制即备份。</P>
        <P>「工具箱 → 导出」可以打一个 ZIP 包；把包拖回窗口就是恢复。</P>
        <P>删掉的文件进系统回收站，软件内的「回收站」模块也能找回。</P>
      </>
    ),
  },
]

/** 总步数（多处展示用） */
export const LESSON_TOTAL = LESSONS.length

export function getLesson(n: number): Lesson {
  return LESSONS.find(l => l.n === n) ?? LESSONS[0]
}
