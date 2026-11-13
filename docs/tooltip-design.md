# 悬停提示（Tooltip）设计口径

> 2026-11-13 定稿。形状 = 方案 B「浮起一档 + 9px 微箭头」，先在同一原型
> `tmp/tooltip-proto/index.html` 里对比过原生 `title` / 线性描边 / 强调微光 / 毛玻璃 / 胶囊。
> 本文只写「改哪里、守什么」，组件实现见 `src/components/shared/TooltipHost.tsx`。

## 1. 两套入口，一套皮肤

| 入口 | 适用 | 实现 |
|---|---|---|
| 通用悬停提示 | 图标按钮、页签、树节点、数据点、截断文本 | 元素挂 `data-tip` / `data-keys`，全局 `TooltipHost` 事件委托 |
| `HelpHint`（ⓘ） | 设置行 / 表单字段的行级说明，需要 `aria-describedby` 与受控开合 | `src/components/shared/HelpHint.tsx`，复用 `.kb-tip-surface` 皮肤 |

两者**共用** `--tip-*` 令牌与进场动画，不许各写一份配色。

## 2. 样式令牌（主题包只覆写这些）

| 令牌 | 默认 | 说明 |
|---|---|---|
| `--tip-bg` | `var(--bg-tertiary)` | 底色，只比面板提一档，禁止品牌色整块铺 |
| `--tip-fg` | `var(--text-secondary)` | 文案色 |
| `--tip-border-color` | 边框色 72% + 正文色 28% | 发丝描边 |
| `--tip-radius` | `7px` | 圆角 |
| `--tip-pad-y` / `--tip-pad-x` | `5px` / `9px` | 内边距 |
| `--tip-max-width` | `320px` | 超过换行 |
| `--tip-shadow` | 深色一组 / 浅色主题单独收轻 | 浮起阴影 |
| `--tip-arrow` | `9px` | 箭头边长 |
| `--tip-pattern` | `none` | 背景图案（只允许渐变，见 §5） |
| `--tip-pattern-size` | `auto` | 图案尺寸 |

插件主题只需在 `colors` 里写这些变量，或改用声明式 `tooltip` 字段（§5），**不改组件**。

## 3. 交互口径

- 悬停 **120ms** 浮出；离开立即收起（扫过一列图标不连闪）。
- 键盘 `Tab` 聚焦零延迟显示；`:focus-visible` 闸门 —— 鼠标点出来的焦点不弹，避免「点完按钮气泡赖着不走」。
- 滚动 / 改窗口 / 切换窗口 / `pointerdown` / `Esc` 一律直接关，不做追位。
- 气泡 `pointer-events: none`，永远不抢点击。
- 上方放不下自动翻到下方；水平越界夹回视口，**箭头仍然指回锚点中心**。
- 只动 `transform` / `opacity`；`prefers-reduced-motion` 由 `index.css` 统一兜底。

## 4. 迁移口径（把 `title=` 换掉）

```tsx
// 之前
<button title="打开命令面板（Ctrl + Shift + P）">

// 之后：文案与键位分开，键帽由气泡渲染
<button data-tip="打开命令面板" data-keys="Ctrl,Shift,P" aria-label="打开命令面板">
```

三条硬要求：

1. **图标按钮必须补 `aria-label`** —— 以前无障碍名是 `title` 兼任的，换掉就丢了。
2. 键位用 `data-keys`（逗号分隔，最多 4 枚），不要拼进文案括号串。
3. 组件 props 叫 `title` 的（如 `ConfirmDialog`、`FileMetaCard`）不是悬停提示，别误改。

纯函数助手：`src/lib/tooltip.ts` 的 `tipAttrs(label, keys)`。

> 完成度（2026-11-13）：全仓 DOM 元素已无原生 `title=`（约 830 处 `data-tip`）。剩下的 `title=` 只允许出现在组件标题 prop（`ConfirmDialog` / `SettingsGroup` / `SectionHead` 等）与 `iframe` 的无障碍标题上。契约脚本 §4 会持续拦截。

## 5. 插件图案（声明式，只允许渐变）

主题贡献可以多一个 `tooltip` 对象：

```json
{
  "name": "樱花",
  "colors": { "--bg-primary": "#fdf7f8", "...": "..." },
  "tooltip": {
    "pattern": "radial-gradient(circle at 100% 0, rgba(255,168,196,.45), transparent 44%)",
    "patternSize": "auto"
  }
}
```

渲染层会把它拼成同名主题规则里的两行变量：

```css
html.theme-<id> {
  --tip-pattern: <pattern>;
  --tip-pattern-size: <size>;
}
```

**校验规则**（`src/lib/tooltipPattern.ts`，纯函数，契约脚本逐条覆盖）：

- 只接受 `linear-gradient` / `radial-gradient` / `conic-gradient` 及 `repeating-*` 形态，或 `none`；
- 字符集白名单（不含 `;` `{}` `<>` `@` 引号与反斜杠）⇒ 无法做规则注入；
- 黑名单挡掉 `url()` / `image-set()` / `element()` / `paint()` / `expression` 等；
- 括号必须配平，长度 ≤ 400；
- `patternSize` 只认 `auto` 或一组 `数字+px/rem/em/%`（如 `9px 9px`）。

**不支持图片纹理**是有意为之：主题颜色经 `sanitizeVars` 注入时 `url()` 本来就被禁；要让插件带自己的 PNG / SVG，等于把主题包变成可执行攻击面。点阵、扫描线、角饰用渐变都能表达。

## 6. 验收

```bash
node --experimental-strip-types --no-warnings .AGENT/scripts/tooltip/verify-tooltip.mjs
```

覆盖：定位纯函数用例表（翻面 / 钳制 / 箭头 / 键位）、组件与样式契约（委托 / role / aria / 指针事件 / reduced-motion / 令牌）、插件图案校验、迁移负向锁（试点文件不许再有原生 `title=`）。
