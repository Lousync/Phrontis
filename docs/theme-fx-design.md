# 主题氛围特效（四季粒子）技术方案

> **状态**：方案已定稿，**实施等看板模块落地后启动**（用户拍板 2026-09-27：特效需要动内核，先不急，等看板做好再做）。
> 原型：`proto/theme-fx.html`（已四轮迭代定稿，全部参数可直接搬运）。参考原型：`proto/seasonal-themes.html`（四季配色）。

---

## 1. 背景与需求

主题合集插件（`knowbase.themes-collection`）v1.6.0 提供春夏秋冬四套主题。用户要求为四季主题配套**氛围特效**：

| 主题 | 特效 | 视觉描述 |
|---|---|---|
| 春 · 嫩芽 | 樱瓣飘落 | 粉色花瓣，慢摇慢转，18-45px/s |
| 夏 · 骄阳 | 丁达尔光束 | 右上光源投下 5 道平行暖白光束（呼吸+微漂移），金色浮尘在光路中上浮闪烁 |
| 秋 · 金秋 | 落叶飘零 | 五色秋叶（叶身+叶脉+叶柄），30-72px/s，翻滚下落 |
| 冬 · 初雪 | 雪花纷飞 | 双层：近景六角结晶（慢旋转）+ 远景虚化雪点（纵深） |

**用户拍板的交互与归属**：
1. 特效归属**主题合集插件包**（不单独出插件）。
2. 安装插件后，**设置模块**新增「主题特效」开关（boolean）。
3. 开关开启后，新增「粒子密度」设置（select：疏 / 中 / 密）。
4. 特效作用面：**工作台 + 看板**为首发范围；后经用户追加扩到 **设置（2026-09-27）/ 说说 + 书市（2026-09-27 同批）**，共五面 —— 见 §4.2 挂载表。
5. **特效画布必须垫在面内所有控件与内容之下**（z 序最低，粒子只从留白处透出，不遮挡主体）。

## 2. 结论先行：需要动内核，共三处

特效**不能**作为纯声明式插件独立实现，原因：

- declarative 插件贡献只有静态数据，没有运行时——粒子引擎（canvas 渲染循环）必须由内核承载；
- 特效画布要挂进工作台/看板的容器内部且 z 序压到内容之下，这是内核布局职责；
- 用户期望的设置入口在「设置」模块，而现有插件 `settings` 贡献只渲染在**插件管理页**（`plugins/index.tsx:710` PluginSettingsForm），且 `PluginSettingItem`（types/index.ts:588）不支持联动显隐。

**内核改动清单**：

| # | 改动 | 性质 |
|---|---|---|
| 1 | 新组件 `ThemeFxLayer`（canvas 粒子引擎） | 核心，新增文件 |
| 2 | 工作台 + 看板挂载点 | 各 1-2 行 |
| 3 | 设置接线：SETTINGS 加 `themeFxEnabled` / `themeFxDensity` 两项 + AppearanceView 条件显示 | 小改 |

插件侧改动极小（v1.6.0 → v1.7.0）：四季主题 `colors` 各加一个 `--theme-fx` 令牌，**不需要** settings 贡献（设置走内核，见 §4.4）。

## 3. 数据流

```
主题插件 colors 表声明 --theme-fx: petals|beams|leaves|snow
        ↓（既有机制：pluginService 注入 html.theme-plugin-xxx { … }）
ThemeFxLayer 挂载后 getComputedStyle(html).getPropertyValue('--theme-fx')
        ↓（监听 html class 变更（MutationObserver）+ plugins-changed 事件重读）
值为合法枚举且设置开启 → 启动对应粒子系统；空/未知/设置关闭 → 清画布停止
```

- 令牌值已核对可通过渲染层 `sanitizeVars` 白名单（纯小写字母，无 `@{}<>`、无 `url(`、长度 <200）。
- 内核**只认令牌不认插件 id**：未来任何主题插件都能自带特效，无耦合。
- 主题切换走既有 View Transition 交叉淡化，特效随 class 变更自然启停。

## 4. 技术方案

### 4.1 内核组件 `ThemeFxLayer`（src/components/shared/ThemeFxLayer.tsx）

- 单 `<canvas>` 覆层：`position:absolute; inset:0; z-index:0; pointer-events:none`，**父容器内容层 z≥1**。
- **sprite 预渲染**：樱瓣×4 / 秋叶×5（叶身渐变+主侧脉+叶柄）/ 雪花结晶×3（六枝+两级侧枝，白芯蓝晕）/ 雪点 / 浮尘 / 光束纹理（destination-in 纵向高斯蒙版柔边），运行时每帧仅 `drawImage`。
- 单 rAF 循环，dt 步进（帧单位，上限 3 防后台追赶）；`document.hidden` → 暂停归零；`visibilitychange` 恢复。
- `ResizeObserver` 跟随容器，dpr ≤ 2。
- `prefers-reduced-motion: reduce` → 不进 rAF，只画一帧静态分布（对齐动效硬约束的降级要求）。
- 密度：基准数 × 档位倍率（low 0.45 / mid 1 / high 1.8）。

### 4.2 挂载点（特效作用面：工作台 + 看板 + 设置）

| 面 | 位置 | 挂法 |
|---|---|---|
| 工作台 | `WorkbenchShell` 外壳根（`data-wb="shell"`） | `<ThemeFxLayer />` 置于三栏之前（z-0），**`!sidesGone` 门控**（整窗模块激活时让位给其自带画布，防双层粒子）。~~desktop 模块根~~ 为死代码（从未被 import），2026-09-27 反馈 9 更正到外壳层。侧栏半透明薄纱（`ResizablePanel translucent` + 左栏 `kb-theme-surface-translucent`）让粒子隐现；中间卡片壳有标签时维持 88% 实感、无标签（总览空态）降为 30% 并去卡片渐变图 |
| 看板 | `src/modules/dashboard` 根容器内 | 根容器 `relative` 包画布 + 内容层 `relative z-[1]` 滚动 |
| 设置 | `src/modules/settings` 根容器内 | 左右两栏各 `relative z-[1]`（2026-09-27 用户追加） |
| 说说 | `src/modules/moments` 根容器内 | 滚动内容层 `relative z-[1]`（灯箱 z-70 在画布之上不受影响）（2026-09-27 用户追加） |
| 书市 | `src/modules/bookmarket` 根容器内 | 模块栏 / 提示条 / 舞台三块各 `relative z-[1]`（2026-09-27 用户追加） |

多处各持独立实例；面不可见时组件卸载/暂停。**不要**挂到 App 根（特效只属于这五个面，别处滚动/切换不受影响）。

### 4.3 设置接线

- `src/lib/settings.ts` 的 `SETTINGS` 新增（唯一真源，前后端共用）：
  - `themeFxEnabled`：boolean，**默认 true**（已确认，2026-09-27 用户拍板「按默认来」）
  - `themeFxDensity`：select，`low|mid|high`，默认 `mid`
- **显示条件**（AppearanceView，已确认采用严格档）：当前激活主题的 colors 含 `--theme-fx` 时才显示这两项（`ensurePluginThemeStyles()` 已返回各插件主题的 colors，现成数据）。深色/浅色或非特效主题下隐藏。
- **密度联动显示的取舍**：`PluginSettingItem` 不支持联动显隐且本方案设置走内核 SETTINGS——「开启后才出现密度」若要严格实现，需给设置表单引入通用 visibleIf 机制（特化，不推荐）。**采用**：两项恒显示（在条件满足时），密度 desc 注明「需主题特效开启后生效」，ThemeFxLayer 在 `themeFxEnabled=false` 时直接不渲染。

### 4.4 插件侧（themes-collection v1.7.0）

- 四季主题 `colors` 各追加：`"--theme-fx": "petals"` / `"beams"` / `"leaves"` / `"snow"`（对应春夏秋冬）。
- 版本 1.6.0 → 1.7.0；描述补「含季节氛围特效」。
- 双通道同步（market-plugins + builtin-plugins），契约脚本 `.AGENT/scripts/themes-collection/verify-themes.mjs` 扩展：校验 `--theme-fx` 值 ∈ 枚举。

## 5. 定稿参数表（从原型直接搬运）

通用：密度倍率 low 0.45 / mid 1 / high 1.8；速度单位 px/帧（60fps 基准）；画布 dpr ≤2。

| 特效 | 基准数 | 粒子规格 | 运动 |
|---|---|---|---|
| petals | 24 | 4 色樱瓣 sprite，14-26px | vy 0.3-0.75；摇摆幅 12-26 @ 0.04-0.09 rad/帧；自转 ±0.018 rad/帧 |
| leaves | 18 | 5 色叶 sprite（渐变+叶脉+叶柄），26-38px | vy 0.5-1.2；摇摆 15-35 @ 0.03-0.07；自转 ±0.025；翻面 fs 0.02-0.06，压扁 0.55+0.45·\|cos\| |
| snow | 64（远景 ~40 + 近景 ~24） | 远：软雪点 6-12px；近：六角结晶 3 变体 34-52px | 远 vy 0.35-0.9；近 vy 0.5-1.0 + 自转 ±0.012；摇摆 8-22 @ 0.03-0.08 |
| beams(夏) | 浮尘 22 + 光束 5 道 | 浮尘金雾 sprite 12-26px；光束纹理 800×220 半分辨率 | 浮尘上浮 0.15-0.35、闪烁 0.05-0.12 rad/帧；光束：源 (0.72w, 0.05h)，基角 2.44rad，off -185..272，宽 180-300，alpha 0.55-0.95，呼吸 0.72+0.28·sin(0.00022t)，漂移 ±0.018 rad |

**丁达尔光束渲染三要素**（v2 定稿的关键，勿回退）：
1. **环境压暗**：以光源为中心的径向渐变 `rgba(58,80,112,0→0.27)` 先铺底——光束靠对比浮出；
2. **加色合成**：光束与浮尘 `globalCompositeOperation='lighter'`；
3. **高亮低饱和暖白** `rgba(255,246,222,…)`,沿光程非线性衰减 + 纵向 destination-in 高斯柔边（无硬边）。

## 6. 性能实测（本机 Chromium / IAB，1440×900）

| 场景 | 每帧开销 | 占 60fps 帧预算 |
|---|---|---|
| 冬雪 中档（64 sprite） | 0.34ms | ~2% |
| 冬雪 密档（115 sprite） | 0.56ms | ~3.4% |
| 夏 光束+浮尘 | 0.34ms + ~0.1ms（5 次 drawImage + 1 渐变填充） | ~3% |

画布不可见 / 标签页隐藏时暂停归零；reduced-motion 静帧零循环。结论：常开无感。

## 7. 验收与契约

- 契约脚本扩展：`verify-themes.mjs` 增加 `--theme-fx` 枚举校验（v1.7.0 起四季主题必含且值合法）。
- 类型门禁：tsc node + web 双绿。
- 行为验证清单（实机）：
  - [ ] 四季主题切换 → 特效自动启停（含 View Transition 不被画布阻塞）
  - [ ] 工作台 / 看板两处粒子均在内容层之下（对照截图：粒子只出现在留白处）
  - [ ] 设置 → 外观：仅激活四季主题时出现两项设置；关闭「主题特效」粒子清空
  - [ ] 密度三档即时生效；切深色/浅色主题无特效且画布清空
  - [ ] 标签页隐藏暂停（CPU 归零）、恢复续播；reduced-motion 下为静帧
  - [ ] 卸载/停用主题插件 → 特效停止、设置项消失、无残留报错

## 8. 实施顺序（等看板落地后）

1. 看板模块容器定稿 → 确认挂载点与 z 序规范
2. `ThemeFxLayer` 组件（sprite 工厂 + 引擎，参数按 §5）+ 类型门禁
3. 工作台接入 + 实机验收
4. 看板接入
5. 插件 v1.7.0（`--theme-fx` 令牌）双通道发布 + 契约脚本扩展
6. 设置接线（SETTINGS 两项 + AppearanceView 条件显示）
