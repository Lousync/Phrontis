# 输入框与搜索框画法规范

> 适用：所有单行输入、搜索框、带前缀 / 后缀的组合输入（图标 + 输入 + 清除按钮）。
> 目的：全仓只有**一个**边框，不再出现「框中框」细线；焦点、禁用、错误态画在同一层。
> 出处：2026-11-14 用户报障——知识库左栏搜索框内部多出一道细线框（全局 `input` 自带 1px 边框，
> 外壳又画了一道）。本规范与 `src/styles/index.css` 的 `.kb-field` / `.kb-field-control` 配套。

## 1. 两种形态，只选一种

| 形态 | 何时用 | 谁画边框 | 实现 |
|---|---|---|---|
| **A. 单控件** | 只有一个输入框，没有图标 / 按钮 / 前后缀 | `input` 自己 | 不包外壳；直接用全局 `input` 基础样式 |
| **B. 组合控件** | 图标、前缀、清除按钮、单位、快捷键提示等需要与输入同框 | **外壳** | 外壳 `.kb-field` + 内部控件 `.kb-field-control` |

**判定口诀：一个框里只有输入 → A；框里还有别的东西 → B。**
绝不允许「外壳画一道 + input 再画一道」。

## 2. 全局基础样式（A 形态）

`src/styles/index.css`：

```css
input, textarea, select {
  background: var(--input-bg);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--accent);
}
```

用法：不要在外层再包一个带边框的 `div`；需要圆角 / 高度时直接写在 `input` 的 className 上
（`h-[30px] rounded-md px-2 text-[12.5px]`）。

## 3. 组合控件（B 形态，推荐用它替代手写组合框）

### 3.1 结构

```tsx
<div className="kb-field flex h-[30px] items-center gap-1.5 rounded-lg px-2">
  <Search size={13} className="shrink-0 text-[var(--text-muted)]" />
  <input
    value={q}
    onChange={(e) => setQ(e.target.value)}
    placeholder="搜索笔记"
    className="kb-field-control min-w-0 flex-1 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
  />
  {q && (
    <button type="button" onClick={() => setQ('')} data-tip="清除" aria-label="清除"
      className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
      <X size={12} />
    </button>
  )}
</div>
```

### 3.2 两条工具类

```css
.kb-field {
  border: 1px solid var(--border-color);
  background: var(--input-bg);
  transition: border-color var(--dur-std) var(--ease-kb), box-shadow var(--dur-std) var(--ease-kb);
}
.kb-field:focus-within { border-color: var(--accent); }

.kb-field-control,
.kb-field-control:focus,
.kb-field-control:hover {
  border: 0;
  border-radius: 0;
  background: transparent;
  outline: none;
  box-shadow: none;
}
```

**内部控件必须使用 `.kb-field-control`** —— 它的职责只有一个：把全局 `input` 的
边框 / 背景 / 圆角 / 焦点框全部归零，让外壳成为唯一的「框」。

### 3.3 焦点态

- 焦点**只画在外壳**（`:focus-within` → `border-color: var(--accent)`）；
- 内部控件不允许 `focus:border-*` / `focus:ring-*` / `outline`；
- 需要更醒目的焦点时，在外壳加一层 `box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent)`，不要给 input 加。

### 3.4 错误 / 禁用态

| 状态 | 画法 |
|---|---|
| 错误 | 外壳边框 `border-[var(--danger)]`（可加 `bg-[var(--danger)]/5`）；不要只改 input |
| 禁用 | 外壳 `opacity-50` + 内部 `disabled`；不要给 input 单独换背景 |
| 只读 | 外壳 `bg-[var(--bg-tertiary)]`；内部 `readOnly` |

## 4. 尺寸与间距（沿用现有视觉，不另造）

| 场景 | 高度 | 圆角 | 字号 | 左右内边距 |
|---|---|---|---|---|
| 左栏 / 紧凑工具条 | 28–30px | 6–8px | 12–12.5px | 8px |
| 常规表单 / 设置项 | 32–36px | 8px | 13px | 10px |
| 大号搜索（书市等） | 44–50px | 10–13px | 14–15px | 12–14px |

- 图标 13–15px，颜色 `var(--text-muted)`，`shrink-0`；
- 图标与输入间距 6–8px；输入与清除按钮间距 4–6px；
- 清除 / 后缀按钮 20–24px 点击区，`rounded`，悬停 `bg-[var(--bg-hover)]`；
- 占位符 `var(--text-disabled)`；输入文字 `var(--text-primary)`。

## 5. 无障碍

- 每个输入都要有可读名称：关联 `<label htmlFor>` 或 `aria-label`；
- **占位符不是标签**，只作示例；
- 图标按钮（清除、显示密码等）必须有 `aria-label` / `data-tip`；
- `Enter` 提交、`Escape` 清空 / 关闭下拉，行为与所在面板一致。

## 6. 反例（本次报障的形态）

```tsx
// ❌ 外层画框 + input 仍带全局 border → 框中框
<div className="border border-[var(--border-color)] rounded-lg bg-[var(--input-bg)] px-2">
  <input className="bg-transparent outline-none" />
</div>

// ✅ 外层 .kb-field + 内部 .kb-field-control
<div className="kb-field rounded-lg px-2">
  <input className="kb-field-control" />
</div>
```

同一错误也会出现在 `<textarea>` 与 `<select>` 上（全局规则同样带边框），处理方式一致。

## 7. 现存组合框盘点（2026-11-14）

| 位置 | 状态 |
|---|---|
| 知识库左栏搜索（`src/modules/knowledge/index.tsx`） | ✅ `.kb-field` + `.kb-field-control` |
| 日程「添加任务」两处（`TodayView` / `TaskListView`） | ✅ 内部控件已用 `.kb-field-control` |
| AI 助手范围面板（`ScopePane`） | ✅ 内部控件已用 `.kb-field-control` |
| 书市搜索（`DiscoverView`） | ✅ 文本输入已用 `.kb-field-control`；右侧书源 `<select>` 是独立控件，保留自己的边框 |
| 设置数值输入（`NumberField`） | ✅ 内部控件已用 `.kb-field-control` |
| 番茄钟主题输入（`PomodoroPanel`） | ✅ 已内联 `border: 0`（历史写法，等价） |
| 设置搜索（`SettingsSearchBox`） | ✅ 内部 input 显式 `border-transparent`（背景层画框，等价） |
| AI 学习输入（`AiLearn`） | ✅ textarea 已显式 `border-0 bg-transparent` |

新写组合框时**直接用第 3 节的代码**，不要复制旧的内联写法。

## 8. 自检清单（提交前）

- [ ] 框里只有一个输入？→ 用 A 形态，别包外壳。
- [ ] 框里有图标 / 按钮？→ 外壳 `.kb-field`，内部 `.kb-field-control`。
- [ ] 内部控件没有 `border` / `outline` / `ring` / 自己的背景。
- [ ] 焦点态只在外壳上，且键盘 Tab 能看到。
- [ ] 清除按钮有 `aria-label`，`Escape` 能清空。
- [ ] 亮 / 暗 / 昼夜主题下边框与占位符都可读。
