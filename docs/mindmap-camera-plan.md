# 思维导图相机（viewport / pan / zoom）优化方案

> 状态：**已实现（2026-11-24）** —— 落码在 `src/components/shared/MindMapView.tsx`（常量 / 两个纯函数 / rAF 胶水），
> 契约在 `.AGENT/scripts/ai-teaching/verify-mindmap.mjs` §10（106 条断言）。
> 实做与本文的偏差只有一处：纯函数按同签名内联在 `MindMapView.tsx`（本次改动文件范围限定，未新建 `src/lib/mindmapCamera.ts`）。
>
> 场景：AI 教学右侧查看器里的思维导图页签（窄视口 360–480 为主）。主节点展开很多分支后，用户点它折叠 —— 相机不动，被折叠的节点留在原屏幕位置，右侧/下方出现大片空白，主节点常被推到视野边缘。
>
> 原型：`/home/lousync/Projects/Phrontis/tmp/ai-teach-mindmap-camera/index.html`（单文件、零依赖，`?w=380&v=b&theme=dark&reduce=1`）
> 截图：`/home/lousync/Projects/Phrontis/tmp/ai-teach-mindmap-camera/shots/`（`01-now-380` / `02-a-380` / `03-b-380` / `04-c-380` / `05-b-480` …）
> 探针：`/home/lousync/Projects/Phrontis/tmp/ai-teach-mindmap-camera/probe.mjs`（32/32 通过）

---

## 0. 结论先行

| 方案 | 一句话 | 建议 |
|---|---|---|
| 现状 | 折叠 / 展开只 bump `foldVersion`，相机完全不动 | 缺陷来源，必须改 |
| **A 锚定** | 同帧补 pan，被点节点屏幕位置纹丝不动（jsMind / MindElixir 的做法） | 作为**底座**，但不能单独作为默认 |
| **B 居中** | 折叠 / 展开后把被点节点平滑移到视口 45% 处，scale 不变 | **推荐默认** |
| **C 居中 + 展开适配** | 折叠同 B；展开时若子树放不下且有界缩放能救，才缩（最多缩到 0.75x） | **推荐作为 B 的展开分支**（即 B 与 C 合并成一套，开关控制） |

核心判断：**折叠是「收起信息」，用户的心智锚点是被点的那个节点，不是整张图。** 所以既不该重跑整图 `fit`（视角会大幅跳变、把注意力甩走），也不该完全不动（节点自己会跟着重排跑掉，因为 tidy 布局里它的 `y` 由叶子行号决定）。B 是唯一能同时满足「不跳 scale」和「不跑丢节点」的选择；A 的问题在于它保住了「位置」却没保住「构图」——折叠后节点贴着左边、右边 71% 全是空的。

---

## 1. 现状解剖

### 1.1 坐标模型

`src/components/shared/MindMapView.tsx`

- 容器 `.mm-canvas`（`relative` + `overflow-hidden`），L468
- 舞台 `stageRef`（`absolute left-0 top-0 origin-top-left`），L475
- 相机只有一个 `viewRef = { x, y, s }`，L67；`applyView()` 写成 `translate(v.x,v.y) scale(v.s)`，L184–189

世界 → 屏幕（相对 canvas 左上角）：

```
S.x = v.x + W.x * v.s
S.y = v.y + W.y * v.s
```

节点世界中心 = `(ln.x + NODE_W/2, ln.y + NODE_H/2)`，`NODE_W=176 / NODE_H=40`（L23–27），布局常量 `GAP_X=64 / GAP_Y=22 / PAD=48`。

### 1.2 折叠路径（今天发生了什么）

1. `toggleFold`，L279：`n.collapsed = !n.collapsed; setFoldVersion(v => v + 1)` —— 只做这一件事
2. `layout` 的 `useMemo` 依赖 `[doc, foldVersion]`，L102–106 → 重算 `layoutTree`
3. 重排后：折叠节点的 `y` 从「首末子节点中值」变成「自己的叶子行号」，**它自己的世界坐标就变了**；它后面的所有叶子行号上移 → 整棵树整体上移
4. 相机 `viewRef` 一个字都没改 → 屏幕上呈现的是「树塌了，镜头没跟」

`layoutTree` 的实现（`/home/lousync/Projects/phrontis-core/src/lib/mindmap.ts` L145–186）：`x` 只由 depth 决定，`y` 由后序叶子行号决定。所以：

- 折叠**不影响 x**（不会左右挪）
- 折叠**几乎必然改变 y**（少掉 N 行 = 屏幕位移 `N * 62 * s`）
- 主节点折叠（根 `y` = 全树中值 → `y = PAD`）位移最大

### 1.3 为什么「自动 fit 不救场」也是对的

自动 fit 的触发时机被明确限定在 `[doc, activeView]`，L213–217，注释 L209–212 写得很清楚：不能依赖 `fit`，否则折叠 / 增删 / 改字都会把视角拉成「适应画布」。

也就是说：**现状是「有意不重跑 fit」，但忘了给一个更小尺度的相机动作。** 这次改动不是推翻那条注释，而是补上它缺的那一半 —— 注释要守的是「结构变、视角静默」，现在要做到「结构变、视角跟着被操作的那个点走，但整体构图不跳」。

### 1.4 实测（原型复刻同一套 layoutTree / fit 参数，380×660 视口）

折叠主节点「接口技术期末复习」（7 分支 / 17 子节点 / 25 个可见节点，fit 后 `s=0.525`）：

| 方案 | 被点节点屏幕位置 | 视口中心偏差 | 距安全区 | 可见包围盒占视口 | 相机 |
|---|---|---|---|---|---|
| 现状 | (63,338) → **(63,70)** | 289 px | 282 px | **0.8%** | 未动 |
| A 锚定 | (63,338) → (63,338) | 126 px | 107 px | 0.8% | 移动 Δ(0,269) |
| B 居中 | → **(170,330)** | 19 px | **0 px** | 0.8% | 移动 Δ(107,260) |
| C 居中+适配 | → (170,330)（折叠与 B 相同） | 19 px | 0 px | 0.8% | 移动 |

`480×660` 时同样成立：现状中心偏差 332 px、A 145 px、B 24 px。**视口越宽，现状的偏差越大**（因为 fit 的 scale 更大，同一段世界位移放大得更多）。

注意「可见包围盒 0.8%」：折叠后整屏只剩一个 92×21 的节点 —— 这就是用户说的「大片空白」的量化版本。

---

## 2. 调研

### 2.1 方法与边界（先说清楚哪些是核验过的）

- 本次运行环境**只有 npm registry 可访问**（`github.com` / 官方文档站被重置），因此**商业产品（XMind / MindNode / MindManager / Miro / Obsidian Canvas / Heptabase）一律未核验**，下表标注「未确认」，只给待核验 URL，不写结论。
- 四个开源实现是**下载源码逐行读**的（`npm pack` tarball，版本号固定），结论可复现：

| 库 | 版本 | 关键文件 |
|---|---|---|
| jsMind | 0.9.1 | `es6/jsmind.js`（压缩但函数名保留） |
| MindElixir | 6.0.3 | `dist/MindElixir.js` |
| simple-mind-map | 0.14.0-fix.3 | `src/core/render/*.js`、`src/core/view/View.js`（未压缩） |
| markmap-view | 0.18.13 | `dist/index.js` |

### 2.2 一手结论（逐条可回溯到函数）

#### jsMind —— **A 锚定**，无动画

`jm.toggle_node / expand_node / collapse_node` 三个入口都是同一套：

```js
toggle_node(e){ … this.view.save_location(e), this.layout.toggle_node(e),
                    this.view.relayout(), this.view.restore_location(e) }
```

- `save_location`：把节点当前屏幕位置存成 `{ x: el.style.left - panel.scrollLeft, y: … }`
- `restore_location`：`scrollLeft = el.left - saved.x` —— 重排后把滚动补回去，**被点节点屏幕上不动**
- 全局缩放用 CSS `zoom`（`zoom.min 0.5 / max 2.1 / step 0.1`），`set_zoom` 拒绝「缩到比容器还小」；**无 transition，全部瞬时**
- 显式聚焦：`view.center_node(node)` + 公开方法 `scroll_node_to_center(node)`（节点不可见时返回 false）

#### MindElixir —— **A 锚定**（同一套思路，用 `getBoundingClientRect` 差值）

`expandNode` 核心 8 行：

```js
let o = e.getBoundingClientRect(), s = {x:o.left, y:o.top}   // 折叠前
… 增删子节点 DOM …
let u = e.getBoundingClientRect(), d = {x:u.left, y:u.top}   // 折叠后
this.move(s.x - d.x, s.y - d.y)                              // 补 pan
```

其余可复用的机制：

| 机制 | 实现 | 对我们的意义 |
|---|---|---|
| 死区 | `scrollIntoView(node, force)`：只有节点落到容器内边 50px 之外才 `move` | 直接印证「±40px 死区」这类设计的合理性 |
| 有界平移 | `move()` 里把 pan 夹住，保证节点包围盒不会整体滑出视口中心 | 可作为「防止用户把图拖丢」的补充护栏（本次不必须） |
| 缩放适配 | `scaleFit()`：`1 / max(1, max(hRatio, wRatio))` —— **只缩不放**，永不放大过 1 | 与产品 `fit()` 的 `scale ≤ 1.15` 同源思路 |
| 动画 | `move(e,t,animate)`：`animate` 时给 `transform` 挂 `transition: transform 0.3s`，300ms 后清掉；若正在动画中则直接 `return false`（丢弃连点） | 我们改用 rAF + log-lerp（见 §3.4），不用 CSS transition |
| 聚焦分支 | `focusNode(node)`：把该节点当根重渲染 + `toCenter()`；`cancelFocus()` 用 Esc 退出 | 「聚焦 / 下钻」是独立操作，不是折叠的副作用 |

#### simple-mind-map —— **单节点折叠：相机完全不动**；只有「批量折叠」才回中

- `src/core/render/node/nodeExpandBtn.js` 的 `click` → `execCommand('SET_NODE_EXPAND')` → `mindMap.render()`，**没有任何 view transform 变更**
- 真正动相机的地方只有两处：
  - `Render.js#unexpandAllNode(isSetRootNodeCenter = true, uid = '')`：渲染完成后 `setRootNodeCenter()` → `moveNodeToCenter(this.root)`（**回中根节点，不是 fit**）
  - `Render.js#goTargetNode(node)`：先 `expandToNodeUid`（展开祖先链）→ 激活 → `moveNodeToCenter(node, resetScale?)`
- `moveNodeToCenter(node, resetScale)`：把节点中心挪到画布中心；`resetScaleOnMoveNodeToCenter: false` 是默认（`defaultOptions.js:231`），即**默认保 scale**
- `View.js#fit(getRbox, enlarge = false, fitPadding = 50)`：内容本来就装得下且 `enlarge=false` 时 `newScale = 1`（不放大）；`Ctrl+I` 绑定；**transform 无过渡，瞬时**
- 结论：**最接近我们现状**（单节点折叠不动相机），但它的「全部折叠」会显式回中根节点 —— 说明「批量操作要有相机交代」是这个圈子里的共识

#### markmap-view —— 默认 `autoFit: false`，折叠不动；但提供了完整的**死区 + 动画 + 安全区**工具

选项默认值（`dist/index.js` 顶部 `const Q`）：

```js
{ autoFit: false, duration: 500, fitRatio: 0.95, maxInitialScale: 2, … }
```

- `toggleNode` → `renderData()`，`renderData` 里只有 `autoFit && this.fit()` —— **默认关，折叠不动相机**
- `fit(maxInitialScale)`：`s = min(w/d*fitRatio, h/p*fitRatio, maxInitialScale)`，然后 `transition(svg).duration(500)`（d3 过渡）
- `ensureVisible(node, padding)`：**死区平移** —— 算出节点四边到视口的距离，只有真出去了才 `zoom.transform`（带动画）
- `centerNode(node, padding)`：显式居中，且 `padding` 支持 `{left,right,top,bottom}` **不对称留白** —— 这正是「安全区 / 构图中心」的现成先例
- `rescale(scale)`：以视口中心为锚点缩放

### 2.3 商业产品（未确认）

> 本次无法联网核验官方文档或客户端行为，下面**只列待核验 URL，不给结论**。若需要写进对用户的说明，请先人工点一遍。

| 产品 | 待核验问题 | URL |
|---|---|---|
| XMind | 折叠分支后画布是否移动？是否有「居中主题」快捷键？ | https://xmind.app |
| MindNode | 是否有 Focus 模式（只留一条分支）？折叠是否回中？ | https://mindnode.com |
| MindManager | 「折叠后节点」相关视图选项 | https://www.mindmanager.com |
| Miro | 是否把「折叠」作为一等对象（大概率没有，白板语义） | https://miro.com |
| Obsidian Canvas | 有无节点折叠（据印象：无，卡片是自由画布） | https://help.obsidian.md/plugins/canvas |
| Heptabase | 卡片折叠 / 聚焦白板的行为 | https://heptabase.com |

### 2.4 归纳

三种流派：

1. **不动**（simple-mind-map 单节点、markmap 默认）—— 依赖「用户自己找到了位置」，窄视口下体验最差，正是我们踩的坑
2. **锚定**（jsMind、MindElixir）—— 保证被点节点不跑，但不管构图，折叠后常常偏在一边
3. **回中 / 适应**（simple-mind-map 批量折叠、markmap `fit` / `centerNode`）—— 构图最好，但整图 fit 会让 scale 跳变

我们要的不是三选一，是**分层**：默认 B（回中、不缩放）；展开大子树时叠加 C 的有界缩放；A 的「同帧补 pan」作为 B/C 动画的起点语义（避免第一帧闪跳）。

---

## 3. 算法

记：

- `W(n) = (ln.x + NODE_W/2, ln.y + NODE_H/2)`：节点世界中心
- `S(n) = (v.x + W.x·v.s, v.y + W.y·v.s)`：节点屏幕中心（canvas 内坐标）
- `cw / ch`：canvas 尺寸；`cx = cw × SAFE_X`，`cy = ch / 2`
- 常量：`SAFE_X = 0.45`、`DEAD_ZONE = 40`、`ANIM_MS = 200`、`FIT_MARGIN = 28`、`MAX_ZOOM_OUT = 0.75`、`S_MIN = 0.35`、`S_MAX = 2.4`

### 3.1 B1 锚定（同帧补 pan，零动画）

```
Δ = S_before(n) - S_after0(n)      // 重排前后同一个节点在屏幕上的差
v' = { x: v.x + Δ.x, y: v.y + Δ.y, s: v.s }
```

- `S_before` 在点击那一刻从 DOM 取（`nodeEls.get(id).getBoundingClientRect()` 减 canvas rect），或从「旧 layout + 旧 view」算，两者等价
- `S_after0` 用「新 layout + 旧 view」算
- **必须同帧应用、不做动画**：A 的目标位置就是原位置，若做成 200ms 动画，用户看到的是「先跳走再滑回来」，比不动更糟。jsMind（改 scrollLeft）与 MindElixir（同步改 transform）都是瞬时 —— 这也是它们不用动画的原因
- 在 React 里这一步必须放在 `useLayoutEffect`（DOM 已更新、尚未绘制），否则会闪一帧

### 3.2 B2 居中（默认方案）

```
v' = { x: cx - W'(n).x · s , y: cy - W'(n).y · s , s: v.s }
```

- `W'(n)` 必须是**重排后**的坐标（节点自己也会挪）
- `SAFE_X = 0.45` 而不是 0.5：展开时子节点向右长，留 55% 给右侧；折叠时虽然右侧没内容，但保持 45% 让「折叠 → 再展开」不产生额外位移
- scale 完全不变 —— 这是 B 与「适应画布」的根本区别，也是它不打断用户心智的原因

### 3.3 B3 居中 + 展开适配（C，接在 B 的展开分支上）

只在 `kind === 'expand'` 时进入；折叠永远只做 B2。

```
bb  = 被点节点「可见子树」的世界包围盒（含自身，跳过 collapsed 的子节点）
need = min( (cw - 2m)/bb.w , (ch - 2m)/bb.h , s )          // m = FIT_MARGIN
if (need < s - ε):                                        // 装不下
    s2 = clamp( max(need, s × 0.75), S_MIN, s )           // 有界：单次最多缩到 75%
    x' = (bb.w·s2 <= cw - 2m) ? (cw - bb.w·s2)/2 - bb.x·s2   // 宽度装得下 → 水平居中
                              : m - bb.x·s2                  // 装不下 → 左对齐（保住根/父节点）
    y' = (ch - bb.h·s2)/2 - bb.y·s2
else:
    B2
```

三个设计取舍，都有实测支撑（§5.3）：

| 取舍 | 理由 |
|---|---|
| **只缩不放**（`s2 ≤ s`） | 展开时突然放大 = 视野被抢走；markmap `fit` 用 `maxInitialScale`、simple-mind-map `fit` 用 `enlarge=false` 都守这条 |
| **有界缩放**（`≥ 0.75·s`） | 380px 视口里，25 个节点在 100% 下需要 0.49x 才装得下 —— 一刀砍一半，用户会「失重」。0.75 的下限让「至少能看到什么」，剩下的溢出交给用户自己 pan |
| **装不下就左对齐而不是居中** | 思维导图向右生长，根/父节点是阅读起点；居中会把根切掉一半 |

### 3.4 死区

只对**不改变 scale** 的目标生效（B2 / B1）：

```
if |S_target(n) - S_current(n)| < DEAD_ZONE:  v' = null（不动）
```

`DEAD_ZONE = 40px`。意义：小分支折叠本来就只挪十几像素，镜头跟着动一下反而是干扰。原型里扫到一个真实命中：折叠「中断系统 8259A」时节点距目标只有 19px → 不动（MindElixir 的 `scrollIntoView` 用 50px 边距做同类判断）。窄视口可退化为 `min(40, cw * 0.12)`。

C 的缩放分支**跳过死区**（scale 都变了，没有「差不多」这回事）。

### 3.5 动画

- 时长 **200ms**，`easeOutCubic = 1 - (1-t)^3`（`ease-out` 族）
- 只改 `transform`（`铁律 13`：只动 transform / opacity）
- 用 **rAF 手写补间**，不用 CSS `transition`：wheel / pan / fit 需要随时打断，CSS transition 的中途状态无法接管
- 插值方式（关键，避免「缩放游泳」）：

```
s(t)  = s0 · (s1/s0)^e                     // 对数插值
anchor = 被点节点（新布局）世界中心
S(t)  = lerp(S_after0(anchor), S_target(anchor), e)
v(t)  = { s: s(t), x: S(t).x - anchor.x·s(t), y: S(t).y - anchor.y·s(t) }
```

  即「**被点节点在屏幕上从哪儿滑到哪儿**」+「scale 按对数滑」，而不是分别插值 `x/y/s`（后者在同时缩放 + 平移时节点会走弧线）。
- `prefers-reduced-motion: reduce` → 直接落位（`matchMedia` 只在动画启动时读一次即可）
- 打断：任何新的折叠 / 展开、`fit()`、wheel、`zoomBy`、`pointerdown` 平移、`ResizeObserver` 触发的 fit，都先 `cancelAnimationFrame`

### 3.6 与「适应画布」按钮的关系

- 显式 `fit()` **保持原样**（bbox + `scale ≤ 1.15` + 居中，L191–207）
- 折叠 / 展开**永不**触发整图 fit
- `fit()` 成为所有相机动作的最高优先级：执行前 `stopCamAnim()`

### 3.7 边界清单

| 情况 | 处理 |
|---|---|
| 被点节点在新 `layout.nodes` 里找不到（点了祖先的批量折叠 / 节点被删） | 取最近的**可见祖先**做锚点；连祖先都没有 → 不动 |
| 根节点折叠 | 布局只剩 1 个节点；B 正常居中；C 的 `need` 必然 ≥ s（bb 很小）→ 落在 B2 分支，不会误缩放 |
| 点的是叶子节点 | `toggleFold` 本来就不会被调用（`onNodeClick` L283 已判 `children.length`） |
| `s` 已在 0.35 | C 的 `s2` clamp 到 0.35，可能仍装不下 → 保持 0.35 并居中（不报错、不抖） |
| `s` 已在 2.4 | C 只缩不放，不会撞上限 |
| 容器 < 2px（隐藏 / 页签切换中） | 跳过相机动作（与 `fit()` 的 `cw < 2` 判断一致） |
| 快速连点 | 每次 `toggle` 先 `stopCamAnim()`；新一轮从当前 `view` 起算（MindElixir 是直接丢弃连点，我们用「从当前状态继续」更顺） |
| 动画中用户拖拽 / 滚轮 | 立即接管（`stopCamAnim` 后由 wheel / pointer 逻辑写 `viewRef`） |
| 动画中窗口 resize | `ResizeObserver` → `fit()` → 先 `stopCamAnim()` |
| 折叠一个「只有一个叶子子节点」的分支 | 位移通常 < 死区 → 相机不动（预期行为） |

---

## 4. 落码点

### 4.1 建议拆成「纯函数 + 胶水」两层

纯数学放进新文件 **`/home/lousync/Projects/Phrontis/src/lib/mindmapCamera.ts`**（零依赖、不 import React），理由与 `electron/lib/releaseNotes/judge.ts` 相同：契约脚本可以用 `--experimental-strip-types` 直接 import 它，不必跑 Electron。

> **实做（2026-11-24）**：因本次改动文件范围限定在 `MindMapView.tsx` / `FilePane.tsx` / `styles/index.css` / 契约脚本，
> 两个纯函数（`visibleSubtreeRect` / `resolveCameraTarget`）按同签名内联在 `MindMapView.tsx` 组件外，
> 契约改为源码静态断言（`verify-mindmap.mjs` §10）。若后续其他视图也要复用相机，再按本文抽出此文件。

```ts
// src/lib/mindmapCamera.ts —— 纯函数，零依赖
export interface CamView { x: number; y: number; s: number }
export interface WorldRect { x: number; y: number; w: number; h: number }

export const CAM = {
  SAFE_X: 0.45, DEAD_ZONE: 40, ANIM_MS: 200,
  FIT_MARGIN: 28, MAX_ZOOM_OUT: 0.75, MIN_S: 0.35, MAX_S: 2.4,
} as const

/** 可见子树世界包围盒（跳过 collapsed 的后代；rootId 不在节点表里 → null） */
export function visibleSubtreeRect(
  nodes: { id: string; x: number; y: number; depth: number }[],
  rootId: string,
  subtreeIds: string[],       // 由调用方用 node 树算好（含自身）
  nodeW: number, nodeH: number,
): WorldRect | null

/** 相机目标：返回 null = 不动 */
export function resolveCameraTarget(opts: {
  kind: 'fold' | 'expand'
  view: CamView
  viewport: { w: number; h: number }
  clickedWorld: { x: number; y: number }
  screenBefore: { x: number; y: number }   // 仅 anchor 用
  subtree: WorldRect | null
  allowFit?: boolean                        // C 开关，默认 true
}): { view: CamView | null; reason: string }
```

`resolveCameraTarget` 主体（伪码，可直接翻成 TS）：

```ts
const { view, viewport: { w: cw, h: ch }, clickedWorld: nw } = opts
const cur = { x: view.x + nw.x * view.s, y: view.y + nw.y * view.s }

if (opts.mode === 'anchor') {
  const d = { x: opts.screenBefore.x - cur.x, y: opts.screenBefore.y - cur.y }
  return { view: { x: view.x + d.x, y: view.y + d.y, s: view.s }, reason: 'anchor' }
}

const center = () => ({
  view: { s: view.s, x: cw * CAM.SAFE_X - nw.x * view.s, y: ch / 2 - nw.y * view.s },
})

if (opts.kind === 'expand' && opts.allowFit && opts.subtree) {
  const bb = opts.subtree
  const need = Math.min((cw - 2 * CAM.FIT_MARGIN) / bb.w, (ch - 2 * CAM.FIT_MARGIN) / bb.h, view.s)
  if (need < view.s - 1e-3) {
    const s2 = Math.max(Math.min(need, view.s), view.s * CAM.MAX_ZOOM_OUT)
    const fitsX = bb.w * s2 <= cw - 2 * CAM.FIT_MARGIN
    return { view: {
      s: s2,
      x: fitsX ? (cw - bb.w * s2) / 2 - bb.x * s2 : CAM.FIT_MARGIN - bb.x * s2,
      y: (ch - bb.h * s2) / 2 - bb.y * s2,
    }, reason: 'fit-subtree' }
  }
}

const t = center().view
const dx = (t.x + nw.x * t.s) - cur.x, dy = (t.y + nw.y * t.s) - cur.y
if (Math.hypot(dx, dy) < CAM.DEAD_ZONE) return { view: null, reason: 'dead-zone' }
return { view: t, reason: 'center' }
```

### 4.2 `MindMapView.tsx` 的改动点（按现有行号）

| 位置 | 改动 |
|---|---|
| L67–76 附近 refs | 新增 `camAnimRef: useRef<number \| null>(null)`、`pendingFocusRef: useRef<{id; sx; sy; kind} \| null>(null)`、`layoutRef` |
| L184 `applyView` | 不动（只写 transform，正好复用） |
| L191 `fit` | 开头加 `stopCamAnim()` |
| L213–217 自动 fit effect | 不动（**不要**把 `foldVersion` 加进依赖） |
| L220–228 `ResizeObserver` | 不动（`fit` 里已会 stop） |
| L233 wheel / L247 `zoomBy` / L257 `onCanvasPointerDown` | 各加一行 `stopCamAnim()` |
| **L279 `toggleFold`** | 折叠前记录被点节点屏幕位置 + 方向，写进 `pendingFocusRef` |
| **新增 `useLayoutEffect(..., [layout])`** | 若 `pendingFocusRef` 有值 → 算目标 → A/减少动效直接落位，B/C 起 rAF 动画 → 清空 |
| L280 `setAll` + L412/L416 两个批量按钮 | 批量操作不逐节点聚焦：`全部折叠` → 对根做 B2（同 simple-mind-map 的 `setRootNodeCenter`）；`全部展开` → 对根做 C（可能缩到 0.75x 容纳） |
| L562「重置 100%」按钮 | 加 `stopCamAnim()`（顺手，语义一致） |

`toggleFold` 改写（L279 现状是一行）：

```ts
const toggleFold = useCallback((n: MindMapNode) => {
  const id = n._id as string
  const el = nodeElsRef.current.get(id)
  const canvas = canvasRef.current
  if (el && canvas) {
    const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect()
    pendingFocusRef.current = {
      id,
      sx: r.left + r.width / 2 - c.left,
      sy: r.top + r.height / 2 - c.top,
      kind: n.collapsed ? 'expand' : 'fold',
    }
  }
  n.collapsed = !n.collapsed
  setFoldVersion(v => v + 1)
}, [])
```

新增的挂载效应（**依赖 `layout`，但只在有 pendingFocus 时动作**，所以不会重演「折叠就 fit」的老问题）：

```ts
useLayoutEffect(() => {
  const p = pendingFocusRef.current
  pendingFocusRef.current = null
  if (!p || !layout) return
  const ln = layout.nodes.find(x => x.node._id === p.id)
  if (!ln) return                      // 节点已不可见（批量折叠）→ 不动
  const canvas = canvasRef.current
  const cw = canvas?.clientWidth ?? 0, ch = canvas?.clientHeight ?? 0
  if (cw < 2 || ch < 2) return
  const world = { x: ln.x + NODE_W / 2, y: ln.y + NODE_H / 2 }
  const res = resolveCameraTarget({ … , screenBefore: { x: p.sx, y: p.sy }, subtree })
  if (!res.view) return
  if (mode === 'anchor' || reduceMotion()) { viewRef.current = res.view; applyView(); return }  // A：同帧补 pan，不做动画
  startCamAnim(res.view, world)
}, [layout])
```

### 4.3 打断与 rAF（组件内胶水）

```ts
const stopCamAnim = useCallback(() => {
  if (camAnimRef.current !== null) { cancelAnimationFrame(camAnimRef.current); camAnimRef.current = null }
}, [])

const startCamAnim = useCallback((to: CamView, anchor: { x: number; y: number }) => {
  stopCamAnim()
  const from = viewRef.current
  if (from.s === to.s && Math.abs(from.x - to.x) < 0.5 && Math.abs(from.y - to.y) < 0.5) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    viewRef.current = to; applyView(); return
  }
  const s0 = from.s, s1 = to.s
  const a0 = { x: from.x + anchor.x * s0, y: from.y + anchor.y * s0 }   // 动画起点 = 当前屏幕位置
  const a1 = { x: to.x + anchor.x * s1, y: to.y + anchor.y * s1 }
  const t0 = performance.now()
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / CAM.ANIM_MS)
    const e = 1 - Math.pow(1 - p, 3)
    const s = s0 * Math.pow(s1 / s0, e)
    const sx = a0.x + (a1.x - a0.x) * e
    const sy = a0.y + (a1.y - a0.y) * e
    viewRef.current = { s, x: sx - anchor.x * s, y: sy - anchor.y * s }
    applyView()
    camAnimRef.current = p < 1 ? requestAnimationFrame(step) : null
  }
  camAnimRef.current = requestAnimationFrame(step)
}, [applyView, stopCamAnim])
```

注意 `a0` 用「当前 `viewRef` + 锚点世界坐标」现算，而不是把 `S_after0` 传进来 —— 两者数值相同，但这样连点时永远从**最新**状态起算。

### 4.4 契约脚本

建议 `.AGENT/scripts/ai-teaching/verify-mindmap-camera.mjs`（用 `--experimental-strip-types` import `src/lib/mindmapCamera.ts`），用例：

1. `anchor`：世界坐标平移任意值 → 目标 `view` 下节点屏幕位置与 `screenBefore` 相等（±1e-6）
2. `center`：目标下 `S(n) == (cw*0.45, ch/2)`；`s` 不变
3. `dead-zone`：把 `view` 预置成「节点已在目标 ±39px」→ 返回 `null`；±41px → 返回目标
4. `fit-subtree`：构造 25 节点树，`s=1`、视口 380×660 → `s2 ∈ [0.75, 1)`，且 `bb` 左边界 = `FIT_MARGIN`
5. 折叠分支永不改变 `s`（对随机树跑 100 次断言）
6. `s` 已在 0.35 → 结果 `s2 ∈ [0.35, 0.35]` 且不 NaN
7. 找不到节点 → `null`

### 4.5 动效合规（铁律 13）

- 相机动画只写 `stage.style.transform`，不碰 layout 属性 → 合「只动 transform」
- 不用 `transition-all` / 不自造 CSS 过渡类；`prefers-reduced-motion` 直接落位
- 节点本身的入场仍是既有 `.kb-item-in`，不新增关键帧

---

## 5. 原型

### 5.1 位置与用法

```
/home/lousync/Projects/Phrontis/tmp/ai-teach-mindmap-camera/index.html
```

- 单文件、零外部依赖、离线可开；`tmp/` 不进 git
- query：`?w=380&v=b&theme=dark&reduce=1`（`w` ∈ 360/380/480/640/960，`v` ∈ now/a/b/c）
- 顶部：方案切换（默认 B）、宽度、深浅色、减少动效、重置适应画布、100%（看展开适配）、折叠/展开主节点
- 画布：点阵底、主节点「接口技术期末复习」+ 7 分支（17 个子节点，25 个可见节点）、可拖拽平移、滚轮缩放（0.35–2.4）
- 叠层：视口中心十字 + 安全区 45% 虚线、折叠前位置虚线框、空白徽标（口径：该侧内容留白 > 半屏**且**被点节点不在中央 35%–65% 带）
- 读数：被点节点屏幕位置（前 → 后）、中心偏差 / 距安全区、相机是否移动 + Δ、子树在视口内比例、可见包围盒占比、策略说明
- `window.__mm` 暴露 `state() / toggle() / fit() / zoomTo() / dryFold()` 供探针调用

### 5.2 探针

```
node tmp/ai-teach-mindmap-camera/probe.mjs
```

无头 Chromium + CDP，跑 4 方案 × 5 宽度矩阵 + 死区扫描 + 打断 + 连点 + 减少动效 + 缩放极限，输出 `metrics.json` 与 `shots/*.png`。**32/32 通过，无运行时错误。**

截图（`shots/`，另有 `*-viewport.png` 裁切版）：

| 文件 | 内容 |
|---|---|
| `01-now-380` | 现状 380（缺陷对照） |
| `02-a-380` | A 锚定 380 |
| `03-b-380` | B 居中 380（推荐） |
| `04-c-380` | C 380 |
| `05-b-480` / `07-now-480` / `06-c-480` / `08-a-480` | 480 全方案 |
| `09-b-360` `10-b-640` `11-b-960` | 宽度扫描 |
| `12-b-380-light` | 浅色 |
| `13-b-380-reduce` | 减少动效 |
| `14-b-100-expand-380` / `14-c-100-expand-380` | **100% 缩放下展开**（C 的价值证明） |

### 5.3 实测数据（380×660 / 480×660，折叠主节点）

| 方案 | 380 折叠后位置 | 380 中心偏差 | 480 中心偏差 | 相机 | 构图 |
|---|---|---|---|---|---|
| 现状 | (63,70) | 289 px | 332 px | 不动 | 节点贴顶，右侧空白 71%、下方 88% |
| A | (63,338) | 126 px | 145 px | Δ(0,269) | 位置保住，**右侧空白 71%** |
| B | (170,330) | 19 px | 24 px | Δ(107,260) | 节点压安全区，无空白徽标 |
| C | (170,330) | 19 px | 24 px | 同 B | 折叠与 B 完全一致 |

展开侧（先在 380 折叠主节点，再点开）：

| 方案 | 展开后 | scale | 说明 |
|---|---|---|---|
| 现状 | (63,338)，距安全区 107 px | 0.525 → 0.525 | 树回到原构图，主节点偏离中心 |
| B | (170,330)，距安全区 0 px | 不变 | 主节点重新压安全区 |
| C | (71,338)，距安全区 99 px | 0.525 → **0.491（0.93x）** | 子树略超视口 → 有界缩到 93% 并居中包围盒 |

**100% 缩放下展开**（先折叠 → 放大到 100% → 再展开，即「用户正看细节、突然展开一大坨」）：

| 方案 | 子树尺寸 | 视口内可见 | 溢出 |
|---|---|---|---|
| B | 656×1032 px | **29%** | x360 / y372 |
| C | 492×774 px | **61%** | x142 / y114 |

这一组是 C 唯一明显优于 B 的场景：**注意 C 没有缩到「刚好装下」（那需要 0.49x），而是被 0.75x 下限拦住** —— 换来的是「还能看见六成 + 用户自己 pan」而不是「一刀砍半」。

### 5.4 边界用例（探针已覆盖）

| 用例 | 结果 |
|---|---|
| 死区命中 | 折叠「中断系统 8259A」距目标 19 px → 镜头不动 |
| 动画中滚轮 | 立即接管（`s` 从 0.525 继续走，不被动画目标覆盖） |
| 动画中「适应画布」 | 立即接管，落到 `s=1.15`（fit 上限） |
| 快速连点 3 次 | `collapsed` 最终一致、节点数正确、无异常 |
| 减少动效 | 40ms 内即落位（`devSafe = 0`），无中间态 |
| 缩放极限 | 0.35 / 2.4 严格夹住 |
| 根节点折叠后 | 仍在布局里（可见节点 = 1），且对准安全区 |
| 运行时错误 | 无 |

---

## 6. 需要拍板的点

1. **默认方案**：B 居中（本文推荐）vs 保持 A 锚定 + 手动「适应画布」。
   我的判断：B。理由是折叠动作的信息量在「我收起了哪一支」，把这一支放回视野中心才能接着操作；A 只保证不跑丢，不保证能继续用。
2. **安全区取值**：`45%`（给右侧留空间，展开更顺）vs **折叠时 50% / 展开时 45%**（折叠后视觉最"正"，代价是折叠↔展开有 5% 的额外位移）。
   我倾向先统一 45%，少一个变量；这条要不要拆，取决于你看原型时是否觉得折叠后"偏左"。
3. **C 的缩放幅度**：`0.75x` 下限（本文默认，稳健）vs 「一次装下」（`0.49x`，构图最完整但跳变明显）vs **C 干脆不做**（永远只居中，溢出交给用户）。
   如果 C 不做，100% 展开时 71% 的子树在视口外 —— 需要用户自己缩，但至少不会「失重」。
4. **要不要顺手补「聚焦节点」**：MindElixir 的 `focusNode` / simple-mind-map 的 `goTargetNode` 都是「双击 / 快捷键 → 把某节点当根」。我们双击已被「改字」占用，若要做，建议放在右键菜单或 `Ctrl+Enter`。本次不做，只登记。

---

## 7. 证据清单

**可复现（本次已下载源码核验）**

- jsMind 0.9.1 · `es6/jsmind.js`：`toggle_node` / `expand_node` / `collapse_node` → `view.save_location` → `layout.*` → `view.relayout` → `view.restore_location`；`center_node` / `scroll_node_to_center`
- MindElixir 6.0.3 · `dist/MindElixir.js`：`expandNode`（rect 差值 + `move`）、`move`（`transition: transform 0.3s`，动画中丢弃连点）、`scrollIntoView`（50px 死区）、`scaleFit`（只缩不放）、`toCenter`、`focusNode` / `cancelFocus`
- simple-mind-map 0.14.0-fix.3 · `src/core/render/node/nodeExpandBtn.js`（折叠只 `render()`）、`src/core/render/Render.js#setNodeExpand` / `#unexpandAllNode(isSetRootNodeCenter=true)` / `#moveNodeToCenter` / `#goTargetNode`、`src/core/view/View.js#fit(getRbox, enlarge=false, fitPadding=50)`、`src/constants/defaultOptions.js:118,231`
- markmap-view 0.18.13 · `dist/index.js`：`{autoFit:false, duration:500, fitRatio:.95, maxInitialScale:2}`、`renderData`（`autoFit && fit()`）、`toggleNode`、`fit`、`ensureVisible`（死区）、`centerNode`（padding 支持四边不对称）、`rescale`

**未核验（环境只有 npm registry 可达）**

- XMind <https://xmind.app> · MindNode <https://mindnode.com> · MindManager <https://www.mindmanager.com> · Miro <https://miro.com> · Obsidian Canvas <https://help.obsidian.md/plugins/canvas> · Heptabase <https://heptabase.com>

**本仓**

- `src/components/shared/MindMapView.tsx`（相机 L67/184–189/191–207/209–228/233–255/257–276；折叠 L279）
- `/home/lousync/Projects/phrontis-core/src/lib/mindmap.ts`（`layoutTree` L145–186）
- `AGENTS.md` 铁律 13（动效只动 transform / `prefers-reduced-motion`）
