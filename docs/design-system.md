# Zeta Design System（冻结设计契约 · v1.0）

本文件是 Zeta 前端（`web/`）奖项级视觉重构的**唯一令牌与规范来源**。Stage 2/3/4 的全部实现、Stage 5 评审、Stage 6/7 终验均以本文件为准。任何冲突上报 Mike 裁决，成员不得私下变更。

状态：**FROZEN**。分支：`feat/zeta-award-ui`（单一线性 PR，base `main`）。

---

## 0. 审计结论（Stage 1 只读勘察核实）

核实范围：`web/src` 全部 13 页、`components/*` 6 个组件、`App.tsx`、`index.css`、`lib/translations.ts`（en/zh 双语）、CodeMirror 主题层、`index.html`。

| 现状 | 结论 |
| --- | --- |
| `@theme` 仅 2 个字体变量，颜色全是 Tailwind 默认 zinc/blue | 无 token 层，需整体重建 |
| 品牌 favicon 为 terracotta `#D97757` Zeta 标记，应用内从未使用；logo 为 blue-600 方块 + Database 图标，在 9+ 文件复制粘贴、尺寸不一（`w-7 h-7` 等硬编码） | 品牌断裂，见 §1 裁决 |
| `index.html` 已通过 Google Fonts 加载 Inter 400/500/600/700 与 JetBrains Mono 400/500 | Inter 保留，见 §2 |
| `Profile.tsx:67` QR 硬编码 `#000000/#ffffff`，暗色下刺眼 | 列入 Stage 2 修复 |
| `AdminSettings.tsx:388` 裸 `accent-primary`（未定义类，实际无效果）；`Query.tsx:421` `scrollbar-none`（未定义） | 死类，Stage 2 清理 |
| `RunHistoryDrawer.tsx` / `Query.tsx` 存在 `window.confirm`/`alert`，与 styled modal 混用 | 列入 Stage 4 统一为设计内 Dialog |
| 明暗双主题端到端无闪烁（`theme-init.js`）、a11y 纪律（focus-visible、aria 齐全）、可拖拽分栏/抽屉交互用心 | 保留，不得回归 |
| CodeMirror 明暗两套配色靠 `:root:not(.dark)` 覆写，裸 hex 散布于 `index.css` | Stage 2 全部 token 化 |

---

## 1. Originality 裁决（品牌方向定案）

**裁决：启用 terracotta `#D97757` 为 Zeta 唯一品牌色，替换 blue-600 全套。**

理由：
1. `#D97757` 已是项目自认的品牌资产（favicon.svg 唯一填充色），应用内却 0 使用——「认领既有品牌」比「新造一个」成本最低、一致性收益最大。
2. 工具类产品的奖项级实况参照里，蓝（Linear、Vercel 早期、无数 Tailwind 模板）已是最拥挤的「模板脸」；暖 terracotta 在开发者工具里稀有（对照 Supabase 绿、Turso 黄绿），能立刻脱离 Tailwind 默认观感，直接服务 originality 维度。
3. Zeta 的产品语义是「SQL 编辑器 + Cloudflare D1 + 查询 notebook」——一个**数据工坊**而非仪表盘。陶土色的「工坊/器物」隐喻（编辑器是工作台，notebook 是手账）与冷蓝 SaaS 风形成明确主张差异。

**视觉主张：「The Data Workbench / 数据工坊」**——温暖中性底 + 陶土品牌色 + 高纪律的等宽数字排版。编辑器区保持低饱和、无装饰（工作区让位给内容）；导航、CTA、选中态、焦点环、图表强调色统一走品牌色。

### 基准参照条目

奖项级参照（完成度标杆）：
1. **Linear — Awwwards Site of the Day**（https://linear.app）：工具类产品「克制配色 + 精密字体排印 + 毫秒级微交互」的当代表达；我们对标其中性色阶层次与层级协同方式。
2. **Raycast — Webby Awards (Technical Achievement) 级工具站**（https://www.raycast.com）：暖色品牌色在开发者工具中成立且高级的实证；对标其 brand-color-only-for-actions 纪律。

工具类实况参照：
- **Linear**（https://linear.app）：中性色不是纯灰、层级四要素协同。
- **Vercel**（https://vercel.com/dashboard）：等宽数字/tabular-nums 在结果与状态区的使用密度。

我们凭什么达到：上述参照的完成度本质是**纪律**（单一令牌来源、状态色不与品牌色混用、动效时长成体系），而非装饰堆料。本契约把纪律全部写成可机查的 token，Stage 2 落地后差距收敛为逐页执行精度。

---

## 2. 令牌规格（唯一来源：`web/src/index.css` `@theme`）

命名约定：Tailwind v4 `@theme` 变量。颜色用 `--color-*`，字号用 `--text-*`，阴影 `--shadow-*`，缓动 `--ease-*`，时长 `--duration-*`。暗色通过既有 `.dark` custom variant 维护同名 token（CSS 变量覆写），组件里**禁止出现裸 hex / 裸 hsl()**。

### 2.1 品牌色（唯一）

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--color-brand-50` | `#FBF3EF` | `#2A1A14` | hover 底色 / 选中底色 |
| `--color-brand-100` | `#F6E4DB` | `#3A241B` | 弱强调底 |
| `--color-brand-200` | `#EFC9B8` | `#57352A` | 边框强调 |
| `--color-brand-300` | `#E5A98F` | `#7A4A38` | 图标/次级强调 |
| `--color-brand-400` | `#DD8A6C` | `#C9714F` | 暗色主操作（提亮保证对比） |
| `--color-brand-500` | `#D97757` | `#D97757` | **品牌基准色** |
| `--color-brand-600` | `#C25E3F` | `#E08A68` | light 主操作 / hover |
| `--color-brand-700` | `#A34B30` | `#EBA183` | active / 深色强调文字 |
| `--color-brand-800` | `#7E3A25` | `#F3BCA4` | — |
| `--color-brand-900` | `#5C2B1C` | `#FAD7C5` | — |

规则：品牌色只用于 logo、主 CTA、链接/选中态、焦点环、结果强调。`brand-500` 与 `brand-600` 上白色文字对比度 ≥ 4.5:1（AA）；暗色主操作统一用 `brand-400`，禁止直接用 500 压白字。

### 2.2 中性色阶（非纯灰，暖调）

以「陶土工坊」的暖灰为基底（色相 ≈ 25°，饱和度 4–10%，明度成阶），明暗两套：

| Token | Light | Dark | 典型用途 |
| --- | --- | --- | --- |
| `--color-ink-950` | `#1C1815` | `#F5F2EF` | 主文本 |
| `--color-ink-900` | `#2E2824` | `#E8E3DE` | 标题 |
| `--color-ink-700` | `#4A423C` | `#C4BBB3` | 次级文本 |
| `--color-ink-500` | `#7A706A` | `#948A82` | 说明/占位 |
| `--color-ink-400` | `#A29A93` | `#6E655E` | 禁用/最弱文本（仅作辅助，不作正文） |
| `--color-ink-300` | `#D3CCC5` | `#4A433D` | 分隔线（强） |
| `--color-ink-200` | `#E6E1DC` | `#37322D` | 分隔线 / 边框 |
| `--color-ink-100` | `#F0ECE8` | `#2A2622` | 次级底色 / hover 底 |
| `--color-ink-50`  | `#F7F5F2` | `#211D1A` | 页面底 |
| `--color-ink-0`   | `#FFFFFF` | `#191512` | 卡片底 |

对比度承诺：ink-950 正文 on ink-0/ink-50 ≥ 12:1；ink-700 次级 on 卡片底 ≥ 4.6:1；暗色镜像成立。UI 边框/组件对比 ≥ 3:1。状态不只靠颜色区分（配合图标/文字）。

### 2.3 功能 / 状态 / 危险色

| 语义 | Light（text on 10% 底） | Dark（text on 底） | Token 前缀 |
| --- | --- | --- | --- |
| 成功 | `#0F7B4D` / 底 `#E4F4EC` | `#4EC98E` / 底 `#122B20` | `--color-success-*`（50–700 同品牌色阶结构） |
| 警告 | `#96650A` / 底 `#FAF0DB` | `#E3B341` / 底 `#2E2410` | `--color-warning-*` |
| 危险/错误 | `#B3261E` / 底 `#FAE8E7` | `#F0877F` / 底 `#331514` | `--color-danger-*` |
| 信息 | `#3D5A99` / 底 `#EAEFFC` | `#8FA8E8` / 底 `#171E33` | `--color-info-*` |

每族含 `50/100/200/500/600/700` 六阶（结构同 §2.1）。**信息色用低饱和靛蓝，严禁与品牌橙撞车；品牌色不承担任何状态语义。**

### 2.4 字体族

**裁决：保留 Inter + JetBrains Mono**（已加载，换字体无识别度增量且有加载/CLS 成本；奖项级参照 Linear/Vercel 均用 Inter 家族，识别度靠 terracotta + 排印纪律承担）。增强方式：启用 `font-feature-settings` 与 `tabular-nums`。

| Token | 值 |
| --- | --- |
| `--font-sans` | `"Inter", ui-sans-serif, system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif` |
| `--font-mono` | `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace` |

规则：
- 数字密集型内容（耗时、行数、行号、字节数、日期时间）一律 `font-mono` + `font-feature-settings: "tnum"`（`.tnum` 工具类），禁止跳动。
- CJK 混排：中文落入 PingFang/YaHei 栈；基线对齐由 Inter 与系统 CJK 的默认度量保证，行高统一用下方阶梯；中文段落 `line-height` 取比英文同阶 +0.05 档（由 `.text-*` 工具内联处理，见 Stage 2 实现）。
- 正文 `text-rendering: optimizeLegibility`；标题不做 letter-spacing 收紧超过 `-0.02em`（CJK 安全）。

### 2.5 字号 / 行高 / 字重 / 字距阶梯

| Token | px | line-height | 字重 | letter-spacing | 用途 |
| --- | --- | --- | --- | --- | --- |
| `--text-display` | 32 | 1.15 | 700 | `-0.02em` | 页面主标题（admin 页头、空态大标题） |
| `--text-title` | 24 | 1.2 | 650 | `-0.015em` | 区块标题 |
| `--text-heading` | 18 | 1.3 | 600 | `-0.01em` | 卡片/面板标题 |
| `--text-body` | 14 | 1.55 | 400 | `0` | 正文（默认） |
| `--text-body-strong` | 14 | 1.55 | 500 | `0` | 正文强调 / 按钮 |
| `--text-label` | 13 | 1.4 | 500 | `0.01em` | 表单标签、表头 |
| `--text-caption` | 12 | 1.4 | 400 | `0.01em` | 说明、辅助 |
| `--text-micro` | 11 | 1.3 | 500 | `0.04em` | badge、状态标签（可 uppercase 仅限拉丁） |

字重仅允许 400/500/600/700（650 若 Inter 可变不可用则回落 600——Stage 2 实测确认并在此注释）。层级靠「字号 + 字重 + ink 色阶 + 留白」四者协同，不允许只靠字号拉层级。

### 2.6 间距 / 圆角 / 阴影 / 缓动 / 时长

**间距**：4px 基准阶梯，直接使用 Tailwind 默认 `spacing` 比例（`p-1`…`p-16`），**禁止任意值 `p-[13px]`**；节奏规则：
- 卡片内边距：紧凑 `p-4` / 标准 `p-5` / 旗舰页（Query）面板 `p-6`；页面容器 `px-6 py-8`（桌面）/ `px-4 py-6`（移动）。
- 区块节奏差：同组元素 `gap-2/3`，卡片间 `gap-4`，页面区块间 `gap-8`，不允许全页同一个 gap。

**圆角**（`--radius-*`）：`sm 6px`（badge/chip）、`md 8px`（按钮/输入）、`lg 12px`（卡片/面板）、`xl 16px`（modal/drawer）、`full`（pill/avatar）。logo 标记 `rounded-lg`。

**阴影**（`--shadow-*`，暗色加深投影并辅以 1px ink-200 描边）：
- `--shadow-xs`：`0 1px 2px rgb(28 24 21 / 0.05)` — 按钮静止态
- `--shadow-sm`：`0 1px 3px rgb(28 24 21 / 0.07), 0 1px 2px rgb(28 24 21 / 0.04)` — 卡片
- `--shadow-md`：`0 4px 12px -2px rgb(28 24 21 / 0.10), 0 2px 6px -2px rgb(28 24 21 / 0.06)` — 浮层/dropdown
- `--shadow-lg`：`0 12px 32px -8px rgb(28 24 21 / 0.16), 0 4px 12px -4px rgb(28 24 21 / 0.08)` — modal/drawer
- 暗色同阶透明度 ×1.8。禁止彩色大投影。

**缓动**（`--ease-*`）：
- `--ease-standard`：`cubic-bezier(0.2, 0, 0, 1)` — 常规状态切换
- `--ease-enter`：`cubic-bezier(0, 0, 0, 1)` — 进场
- `--ease-exit`：`cubic-bezier(0.4, 0, 1, 1)` — 退场

**时长**（`--duration-*`）：`fast 100ms`（hover/press）、`base 150ms`（颜色/透明切换）、`slow 250ms`（位移/尺寸）、`slower 400ms`（modal/drawer 进场上限）。**任何 transition 不得 > 400ms**；`prefers-reduced-motion: reduce` 下位移类动效降为仅 opacity 交叉淡入（`@media` 全局兜底写入 index.css）。

### 2.7 断点与容器 / 布局规范

| 档 | 宽度 | 规则 |
| --- | --- | --- |
| 移动 | ≤640px | 单列；底部安全区 `env(safe-area-inset-bottom)`；抽屉全宽；表格降级为卡片列表（ResultTable 提供 stacked 模式） |
| 平板 | 641–1023px | Query 页分栏允许折叠为竖排；侧导航可折叠为图标栏 |
| 桌面 | ≥1024px | 完整布局；内容最大宽度：表单/设置页 `max-w-2xl`，admin 数据页 `max-w-5xl`，Query 页不限宽（编辑器占满） |

全局：无横向滚动；导航不遮挡内容（fixed 元素计安全区）；弹层 `z-index` 阶梯：`dropdown 30` / `sticky-bar 40` / `drawer 50` / `modal 60` / `toast 70`（`--z-*` token）。

---

## 3. 8 维度逐项落地路线图

### 3.0 逐维度参照基准（作品名 + 链接；奖项级条目均为 Awwwards / Webby / FWA 获奖或当届公认标杆作品）

| 维度 | 奖项级基准（达标口径） | 工具类校准参照 |
| --- | --- | --- |
| typography | **Raycast**（https://www.raycast.com，Awwwards Site of the Day）：无衬线家族内仅靠字重/字号/字距/色阶建立完整层级 | **Vercel Dashboard**（https://vercel.com/dashboard）：等宽数字 / tabular-nums 在数据区的密度与稳定性 |
| whitespace | **Linear**（https://linear.app，Awwwards Site of the Day）：同组紧、区块松的节奏差；容器内边距与内容密度成比例 | **Arc**（https://arc.net）：工具界面留白的「呼吸感」边界（紧凑但不拥挤） |
| visual_hierarchy | **Stripe Press**（https://press.stripe.com，Awwwards Site of the Day 级排印驱动页面）：一屏内主/次/辅三级一眼可分，层级四要素（字号+字重+色阶+留白）协同 | **Linear**（https://linear.app）：单一主 CTA 纪律，次级操作一律弱化为 secondary/ghost |
| color | **Raycast**（https://www.raycast.com，Awwwards Site of the Day）：暖色品牌色在开发者工具中高级成立的实证；品牌色只给 action/选中/焦点 | **Supabase**（https://supabase.com/dashboard）：品牌色与状态色零冲突的功能色体系 |
| motion | **Lusion**（https://lusion.co，FWA of the Day）：动效时长/缓动成体系、每处动效有信息职责、不阻碍操作 | **Linear**（https://linear.app）：100–250ms 的毫秒级反馈式微动效上限纪律 |
| micro_interaction | **Active Theory**（https://activetheory.net，多届 Awwwards/FWA 获奖工作室站）：hover/press/focus 反馈精确到帧的一致性 | **Raycast**（https://www.raycast.com）：键盘全路径可达 + focus 环始终清晰的工具类标杆 |
| responsive | **Webby Awards 获奖响应式作品的通行口径**（三档无横向滚动/无截断/触控目标 ≥ 44px；参照 https://www.webbyawards.com 获奖画廊中工具类条目） | **Vercel Dashboard**（https://vercel.com/dashboard）：数据密集界面窄屏降级策略（表格→卡片、侧栏→抽屉） |
| originality | 见 §1 裁决（Linear / Raycast 两条奖项级条目 +  terracotta 品牌色论证） | **Supabase**（绿）/ **Turso**（https://turso.tech，黄绿）：开发者工具「非模板脸」品牌色成立的相邻案例 |

说明：以上条目作为 Stage 5/6 评审与终验的对照锚点；「达到基准」的判定口径是**纪律层面逐项对齐**（令牌单一来源、状态色不混、时长成体系、层级四要素协同），而非视觉风格的表面模仿。

### 3.1 落地路线

| 维度 | 契约落点 | Stage 2（令牌与基础组件层） | Stage 3（页面级重构） | Stage 4（动效/微交互/响应式） |
| --- | --- | --- | --- | --- |
| typography | §2.4 §2.5 | `@theme` 字号/行高/字距 token + `.tnum` 工具类；全站组件类改用 token | 逐页替换散落的 `text-sm/text-2xl` 裸用；CJK 行高复核；数字区全量 `tabular-nums` | 路由切换/加载态的文本防跳动（骨架屏等宽占位） |
| whitespace | §2.6 间距节奏规则 | 组件类（btn/input/card）内边距 token 化 | 逐页落实节奏差（同组 gap-2、区块 gap-8）；容器内边距与卡片比例 | 抽屉/分栏拖拽时的间距过渡 |
| visual_hierarchy | §2.1–2.5 四要素协同 | 标题/正文/标签/状态样式族成套（`.h-display` 等语义类） | 每页审一屏层级：主 CTA 唯一品牌色填充，次级一律 secondary/ghost | hover/focus/disabled/loading 五态一致性 |
| color | §2.1–2.3 全部色 token | 锌灰/蓝全量替换为 ink/brand；对比度逐对实测记录；状态色与品牌色零冲突 | 逐页核对链接色统一、状态不只靠颜色 | 暗色 hover/active 阶的观感校准 |
| motion | §2.6 缓动/时长 | 全局 `prefers-reduced-motion` 兜底；`.transition-*` 工具类绑定 token | 页面/区块进场序列（stagger ≤ 3 层，每项 ≤ 250ms） | 抽屉、modal、toast、分栏拖拽的动效统一语言 |
| micro_interaction | §2.6 时长 + 组件五态 | btn/input/toggle/badge 五态（hover/active/focus/disabled/loading）重定义；focus 环统一 `ring-2 ring-brand-500 ring-offset-2` | `window.confirm/alert` 全量替换为设计内 Dialog；空态/加载态/骨架屏逐页补齐 | 五态实测；键盘操作全路径可走 |
| responsive | §2.7 | 工具类不挡断点（组件本身流式） | 逐页三档走查；ResultTable stacked 降级；安全区 | 移动导航与抽屉手势/遮挡复核 |
| originality | §1 裁决 | Logo 组件化（`favicon.svg` 提取为单一 `<Logo/>`，替换 9+ 处 blue-600 方块，尺寸成 token）；QR 码暗色适配（底色用 ink-0、码色用 ink-950，不再硬编码黑白） | 「数据工坊」表达：Query 旗舰页编辑器低饱和无装饰 + notebook 手账式历史条目；About 页讲述主张 | 品牌时刻动效（执行成功的一次性克制度强调，≤ 400ms，reduced-motion 下静默） |

死类清理（`accent-primary`、`scrollbar-none`）与 `index.css` 裸 hex（CodeMirror 覆写、toggle 阴影）一并归入 Stage 2。

---

## 4. 守约条款（与父单冻结契约对齐）

1. 技术栈不换、不引入新依赖；动效仅 CSS transition/animation + 必要 Web Animations API。
2. `index.css` `@theme` 为唯一令牌来源；组件内禁裸 hex / 裸 `hsl()`。
3. 组件 props 与导出名不变；视觉经 variant/className 扩展。
4. 路由、API、CodeMirror 功能行为不变（仅视觉层）。
5. 不回归：暗色、CodeMirror 明暗高亮、PWA、移动端、WebAuthn/2FA。
6. 质量门：`pnpm build`、`pnpm typecheck`（web/worker）、`pnpm lint`（biome）全绿；不改 `biome.json` 绕过。
