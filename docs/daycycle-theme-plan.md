# 昼夜动态主题（原生）技术方案

> **状态**：方案定稿 + 落码（2026-11-07）；**2026-11-11 升级为「沉浸天空 + 通透」**（用户拍板，已落码）；
> **2026-11-13 修复黄昏灰褐带 + 增加预览时间设置（仅开发版）**（UI 色板 06:00 / 19:00 翻板，天空仍渐变）。
> 来源：v3.19.0 反馈 N-2（顶栏昼夜主题）→ 用户体验 v2 原型后升级为**整窗动态主题**并拍板「作为原生动态主题」。
> 原型（参数与质感基准，全部已定稿）：`tmp/titlebar-daycycle-proto/index.html`（v2）；
> 全窗沉浸原型（2026-11-11 对比稿）：`tmp/daycycle-background-proto/index.html`（v3）。

## 0. 2026-11-11 全窗沉浸升级（已落码）

用户从 v3 原型中拍板：**沉浸天空 + 通透**。原 36px 顶栏天空升级为整窗背景层，面板改为通透玻璃；
专注模式降低特效强度做成设置项（`daycycleFocusDim`，默认开）。

- **整窗背景**：`DaycycleBackdrop` 挂在 App 根部（`PomodoroProvider` 内，fixed inset-0 z=-1），
  天空渐变 / 太阳月亮弧线 / 云 / 星空 / 地平线暖光 / 光柱 / 极光 / 光尘 / 萤火 / 流星全部延伸到窗口。
  顶栏不再自己画天空，只保留时间胶囊；标题栏透明，露出同一张背景。
- **天体弧线**：新增 `celestialAt().alt` 与 `daycycleAt().celAlt`（0=地平线，1=天顶），
  全窗纵向位置 = `0.54 - 0.40 * alt`；顶栏旧弧线仍由 `celY` 保留给 popout / 兼容消费方。
- **通透表面**：`html.theme-daycycle` 覆盖 `.kb-theme-surface` / `.kb-dc-center` / `.kb-dc-side` /
  `.kb-activitybar` / `.kb-pagebar` / `.kb-statusbar` 的底色 alpha；正午 / 深夜主内容区叠出约 69% 不透明，
  侧栏约 70%，让天空与月亮从面板后透出，同时保住正文对比度。
- **晨昏阅读底（2026-11-11 反馈修复）**：新增 `--dc-glass-boost`（0%→40%）。太阳高度越低，
  玻璃面板越实；黄昏 18:15 / 暮色 19:12 内容表面可到约 94~96% 不透明，暖光不再从面板后糊住正文；
  正午 / 深夜回到 0%，保持完整通透观感。更新说明 / 看板两个原本没有模块底色的页面补 `kb-theme-surface`。
- **专注模式**：`daycycleFocusDim`（设置 → 外观 → 昼夜背景）。禅模式（Z1 / Z2）或番茄钟专注阶段时，
  `DaycycleBackdrop` 加 `is-focus`，`--dc-fx-scale` 压到 0.3、wash 压到 0.55；
  天空与太阳 / 月亮保留，只降云 / 星 / 粒子。设置关闭则始终全强度。
- **预览时间（2026-11-13，仅开发版）**：设置 → 外观 → 昼夜背景新增 `daycycleTimeOverride`（默认 -1 = 跟随本机时间）。
  拖动进度条把主题冻结在任意分钟，方便检查黄昏 / 黎明的暖光与文字可读性；引擎 `setDaycycleTimeOverride()`
  立即重算并下发带 `instant` 的 tick，天体跳过 60s 慢移。滑块拖动过程只改引擎，松手 / 失焦才写设置。
  **正式版不出现**：`AppearanceView` 用 `import.meta.env.DEV` 门卫，`SETTINGS` 里 `ui:false` 不进设置搜索，
  `App.tsx` 在正式版强制传 `null`（dev 的 settings.json 被带过去也不会冻住主题）。
- **动效边界**：天体仍只动 `transform`（60s linear 过渡）；云 / 星 / 极光 / 粒子 / 流星全部
  `transform` / `opacity`，`prefers-reduced-motion` 全停。持续动画已登记 `docs/ui-animation-plan.md` §七。
- **性能取舍**：主内容面通透但不加 `backdrop-filter`（大窗口下开销高）；只有左右侧栏 / 活动栏
  加 14~16px 轻模糊。粒子用固定 seed 生成一次，分钟 tick 只改 CSS 变量。

---

## 1. 结论先行

做成**内置主题 `daycycle`**（「昼夜动态」），接入既有主题体系，不另起炉灶：

- 选择状态 = 既有 `SETTINGS.theme`（`src/lib/settings.ts:114`），`THEME_OPTIONS` 加第三项；
- 应用机制 = 既有 `html.theme-<id>` class（`applyThemeClass`，View Transition 自动获得）；
- 动态部分 = **分钟级插值引擎**把整套语义变量写 `documentElement.style`（内核已有先例：`editorTheme.ts:86` 写 `--zen-paper`、`PluginFrame.tsx:105` 白名单循环 setProperty）；
- 整窗背景 = `DaycycleBackdrop`（App 根部 fixed 层，纯 CSS 变量消费者），太阳白热核心 + 连续 bloom，月亮实体球，云/星/眩光/粒子随令牌启停；顶栏只保留时间胶囊（`TitleBarDaycycle`）。

**默认主题 dark → daycycle**（用户 2026-11-07 拍板「默认开启」；settings.json 无显式 theme 的存量用户会随本次升级切到昼夜主题）。

## 2. 关键帧与配色（从 v2 原型搬运）

12 关键帧（t=0..1440，首尾同色闭合），每帧 = 天空 4 色 + 云/星参数 + 整窗语义令牌组：

| t | 段落 | 主题形态 |
|---|---|---|
| 0 / 1440 | 深夜 | dark（深蓝黑） |
| 270 | 凌晨 | dark（微回暖） |
| 330 | 黎明 | **中间主题**（暖紫暮调，浅色文字） |
| 390 | 日出 | light（暖调） |
| 480 | 清晨 | light（经典纸感） |
| 660 / 750 | 上午 / 正午 | light（最亮最脆） |
| 930 | 午后 | light（回暖） |
| 1095 | 黄金时刻 | light（金调） |
| 1155 | 暮色 | **中间主题**（plum 暮调，浅色文字） |
| 1260 | 夜晚 | dark |

深浅切换：**天空**保留 12 分钟渐变（黎明 / 暮色仍是自成体系的暖调），但 **UI 色板不做跨极性插值**。
奶油色 ↔ 深紫黑线性插值必然路过灰褐；文字极性切换的那几分钟，面板与文字会一起落在中间灰
（2026-11-13 用户报 19:05~19:07「蒙了一层雾」，实测正文对比度 2.84、弱文字 1.07）。
现在跨极性段按太阳是否在地平线上直接取**整侧** UI（白天侧 / 夜晚侧），面板在 06:00 / 19:00 翻板。
太阳 = 白热核心 + 单条连续 bloom 渐变（8 档非线性衰减，指数曲线，**不用 box-shadow 圆环**——那是贴纸感的来源，参考 Apple Weather / SF Symbols 画法）+ 极淡水平眩光；月亮 = 实体球 + 月面阴影。两弧线 06:00 / 19:00 交接位置连续。

## 3. 文件清单

| # | 文件 | 性质 | 内容 |
|---|---|---|---|
| 1 | `src/lib/daycycleTheme.ts` | 新增，**纯函数零依赖**（`--experimental-strip-types` 可直接被脚本 import，先例 judge.ts） | 12 关键帧 KEYS + `daycycleAt(minute)` → `{ vars, sky, phase, isNight, celX, celY, celAlt }`；变量插值、亮度推导 `--tb-fg`、`sunBloom()`、`celestialAt()` 弧线 |
| 2 | `src/lib/daycycleEngine.ts` | 新增，运行时单例 | `startDaycycleEngine()` / `stopDaycycleEngine()`：分钟对齐 setTimeout 链（无 rAF）→ 写根变量（36 支）→ `window` 广播 `kb-daycycle-tick`；`document.visibilitychange` 回前台立即对齐；**stop 按记录清单精确清除**所写变量（内联变量优先级高于一切 theme-* class，不清会污染后续主题） |
| 3 | `src/components/shared/TitleBarDaycycle.tsx` | 新增（2026-11-07）→ 2026-11-11 收窄 | 顶栏右侧时间胶囊（`HH:MM · 阶段` + 日/月图标，no-drag）；监听 `kb-daycycle-tick`。天空已迁 `DaycycleBackdrop` |
| 4 | `src/components/shared/DaycycleBackdrop.tsx` | 新增（2026-11-11） | 整窗背景层：天空渐变 + 天体弧线 + 云 + 星空 + 地平线暖光 + 光柱 + 极光 / 光尘 / 萤火 / 流星；`ResizeObserver` 量窗口，天体 `transform` 带 60s linear 过渡；`memo` 隔离番茄钟秒级刷新 |
| 5 | `src/components/shared/TitleBar.tsx` | 修改 | 根加 `kb-titlebar` 类钩子；`settings.theme === 'daycycle'` 时挂 `<TitleBarDaycycle />`（只挂胶囊；背景由 App 根部 DaycycleBackdrop 接管） |
| 6 | `src/App.tsx` | 修改 | 引擎 start/stop 接线 + `PomodoroProvider` 内挂 `<DaycycleBackdropHost zenLevel={zenLevel} />`；根加 `kb-app-root`、中心卡加 `kb-dc-center` |
| 7 | `src/styles/index.css` | 修改 | ① `html.theme-daycycle` **静态兜底块**（正午令牌 + 天空变量）；② `.kb-dc-bd-*` 整窗场景样式；③ 通透玻璃表面覆盖；④ 专注模式 `--dc-fx-scale`；⑤ keyframes + `prefers-reduced-motion` 全量降级 |
| 8 | `src/lib/settings.ts` + `src/modules/settings/views/AppearanceView.tsx` | 修改 | `daycycleFocusDim`（专注模式降低特效，默认开）+ 外观页条件区块 |
| 9 | `.AGENT/scripts/daycycle/verify-daycycle.mjs` | 修改契约 | 见 §6 |
| 10 | `docs/ui-animation-plan.md` | 修改 | 补「持续环境动画」段（铁律 13：新动效先补基建再落码） |

## 4. 变量映射（原型令牌 → 应用语义变量）

引擎下发 **36 支**：内容 23 + 天空 9 + 派生令牌 4（含晨昏玻璃增益 `--dc-glass-boost`）。

| 原型 | 应用变量 | 说明 |
|---|---|---|
| bg | `--bg-primary` | |
| bg2 | `--bg-secondary` `--sidebar-bg` | |
| bg3 | `--bg-tertiary` `--input-bg` | |
| card | `--card-bg` | |
| hover / selected | `--bg-hover` `--bg-selected` | |
| border(hex8) | `--border-color` | alpha 随昼夜变（暗色主题边框更透） |
| t1/t2/t3 | `--text-primary` `--text-secondary` `--text-muted` `--text-disabled` | disabled = t3 向 bg 再混 18% |
| accent | `--accent` `--drop-border` | accent-hover 按亮度向黑/白混 14%，`--drop-bg` = accent 向 bg 混 78% |
| ok/warn/bad | `--success` `--warning` `--danger` | |
| — | `--warning-bg` | warn 向 bg 混 82% |
| edge(hex8) | `--glass-edge` | 卡片顶缘高光，白天强夜晚弱 |
| sky.top/mid/low | `--sky-top` `--sky-mid` `--sky-melt` | melt = low 向 bg 混 30%（天空向内容区「融化」，整窗一体的关键） |
| sky.glow | `--sky-glow` `--sun-bloom` | bloom 由 `sunBloom()` 生成 8 档渐变 |
| 亮度推导 | `--tb-fg` | sky.mid/low 亮度 > 145 → 深字，否则浅字 |
| clouds/stars | `--cloud-o` `--cloud-c` `--star-o` | |

**不覆盖** `--bg-gradient`（无渐变图，纯令牌插值）、`--kbd-*`（引用 text-primary 自动跟随）、`--zen-paper`（editorTheme 按亮度判定，自动跟随昼夜）。

## 5. 边界与取舍

- **popout（日程侧边栏独立窗口）v1 不挂引擎**：该窗口拿静态兜底块（定格正午）；待 N-1 / 多窗口议题一并拍板（反馈文档 §5 问题 7 已挂起）。
- **与四季特效互斥自然成立**：`ThemeFxLayer` 只认主题令牌 `--theme-fx`，daycycle 不声明 → 无粒子；用户选四季主题时无天空引擎，两套互不干扰。
- **整窗光与通透表面（2026-11-11 已做）**：`DaycycleBackdrop` 的 `.kb-dc-bd-light` 负责整窗光；内容区通过
  `.kb-theme-surface` / `.kb-dc-center` / `.kb-dc-side` 的 alpha 叠出通透玻璃。**不做**逐模块独立氛围光画布
  （编辑器等使用 Monaco 自身不透明表面的区域保持原样，避免双层光源）。
- **切换频率**：每分钟 1 次 36 支 setProperty + 1 次纯函数计算，无 rAF 循环、无 canvas；天空色相邻分钟差 < 3 RGB，无跳感；太阳移动由 60s linear transform 平滑。
- **View Transition**：只在主题切换时触发（既有机制）；分钟 tick 不开。

## 6. 契约脚本（.AGENT/scripts/daycycle/verify-daycycle.mjs）

`node --experimental-strip-types` 直接 import 纯函数，跑四类断言：

1. **关键帧完整性**：t 严格递增、首帧 t=0 末帧 t=1440、0:00 与 24:00 色板一致（闭合）、每帧必含全部令牌字段；
2. **全时段扫描**（每 10 分钟采样 144 点）：`daycycleAt` 36 支变量齐全非空；WCAG 对比度——text-primary/bg-primary ≥ 4.0、text-muted/bg-primary ≥ 2.0、`--tb-fg`/sky.mid ≥ 2.2；通透表面 composite（69% 不透明 + sky.mid 近似）正文 ≥ 3.5；**面板底色全天不落 0.15~0.34 中间灰带**；06:00 / 19:00 跨极性翻板与 19:05 正文对比度 ≥ 4.0；phase 边界单调；
3. **接线断言**（grep）：TitleBar 含 `TitleBarDaycycle` 与 `no-drag` 胶囊；`DaycycleBackdrop` 含 `kb-dc-backdrop` 与 tick 监听；App.tsx 引擎 start/stop + `<DaycycleBackdropHost>` 接线；index.css 含 `html.theme-daycycle` 兜底块、整窗层 `pointer-events:none`、通透表面覆盖与 reduced-motion 降级；
4. **设置断言**：THEME_OPTIONS 含 daycycle、默认值为 daycycle；`daycycleFocusDim` 与外观页锚点存在；`daycycleTimeOverride` 默认 -1、外观页进度条、引擎 override 与 App 接线存在，且**仅开发版**（DEV 门卫 + `ui:false`）。

## 7. 验收清单（实机）

- [ ] 设置 → 外观：主题列表出现「昼夜动态」，选中即整窗天空 + 通透面板 + 时间胶囊
- [ ] 拖到不同时段（改系统时间或等分钟 tick）颜色连续变化，无跳变
- [ ] 太阳 / 月亮 06:00 / 19:00 交接位置连续；太阳为白热核心 + 柔和泛光，无贴纸感
- [ ] 夜晚星星 / 月亮能从通透面板后透出；白天云 / 太阳光晕可见但不压正文
- [ ] 时间胶囊所有时段可读（半透明底 + 亮度推导前景色）
- [ ] 切回深色 / 浅色 / 插件主题：整窗场景消失、引擎变量全部清除、无残留（对照其它主题色不被内联变量污染）
- [ ] 禅模式（Z1 / Z2） / 番茄钟运行：`daycycleFocusDim` 开启时云 / 星 / 粒子明显降低，天空与天体保留；关闭后恢复
- [ ] 最大化：顶栏拖拽恢复 / 双击还原仍可用（背景层 pointer-events:none）；胶囊可点击
- [ ] `prefers-reduced-motion`：云 / 星 / 极光 / 粒子 / 流星动效停止，颜色仍随分钟更新
- [ ] 类型门禁：tsc node + web 双绿；契约脚本全绿
