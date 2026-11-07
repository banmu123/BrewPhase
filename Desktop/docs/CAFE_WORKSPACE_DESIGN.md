# BrewPhase Café Workspace — 桌面端设计说明

> A quiet place for coffee, ideas and creation.

本文档是桌面端（`Desktop/`）视觉与工作空间结构的**当前事实**。参考对象是
Sublime Library 的极简与空间秩序，以及 iOS 端 Theme.swift 的品牌色；不照搬
Sublime 的品牌资产，也不复制 iOS 的手机布局。

## 1. 设计方向

三个词：**安静、温暖、内容优先。**

- 打开应用像走进一家安静的精品咖啡馆，找到自己的位置，摊开自己的资料。
- 界面是"桌面"，用户的豆子、记录、画布才是主角；控件低存在感，hover 才出现反馈。
- 高级感来自信息组织与留白，不来自阴影、渐变、玻璃拟态或装饰插画。

## 2. 颜色（Design Tokens）

唯一来源：`src/renderer/src/styles/app.css` 的 `:root`。Konva 通过
`src/shared/tokens.ts` 在运行时读取 CSS 变量——**任何组件与画布 Shape 都不许
写死色值**。

| 层 | 值 | 用途 |
|---|---|---|
| paper | `#faf9f6` | 工作区底：暖白纸面，不是奶油黄也不是冷灰 |
| paper-deep | `#f4f2ed` | 侧边栏，比工作区深半档 |
| card | `#ffffff` | 内容面板、节点卡、输入框 |
| well / well-deep | `#f3f1ec` / `#e9e6df` | 井：hover 面、进度条轨道 |
| hairline | `#e8e4dc` | 唯一的分割线 |
| ink / soft / faint | `#2a211a` / `#6f6862` / `#a29b92` | 文字三级 |
| espresso | `#3b2a1e` | 唯一主操作色、关键选中 |
| roast | `#8a5a34` | 链接与次级强调 |
| latte | `#c9a27a` | 库存条等小标记 |
| cream | `#f2ecdf` | 局部层次：侧栏选中、文字卡内衬、chip 选中 |
| sage | `#6e8a5f` | 状态辅助（peak 即它） |
| 阶段色 | resting/opening/peak/declining/priority | 只做点、细条、文字，不做填充底 |

红线：不大面积深棕、不高饱和橙、所有组件不都是棕色、阴影默认为零
（仅悬浮件 `--shadow-hover/--shadow-lifted`）。

## 3. 结构

```
┌────────────┬──────────────────────────────────────────┐
│ Sidebar    │ page-header（标题 + 计数 + 主操作）        │
│ 208px      ├──────────────────────────────────────────┤
│ BREWPHASE  │ page-body                                 │
│ 空间        │   Coffee/Canvas: 列表 | 主内容 | Inspector │
│  咖啡       │   Records:       收藏网格 | 详情+编辑      │
│  记录       │                                           │
│  画布       │                                           │
│ 系统        │                                           │
│  更多       │                                           │
└────────────┴──────────────────────────────────────────┘
```

- **Sidebar**：品牌（衬线 BREWPHASE）+ 分组（空间/系统）+ 图标行；选中态是
  cream 底 + espresso 文字（轻，不是深色块）。<1150px 收成 64px 图标栏。
- **page-header**：每页自己的标题、计数与主操作（新增豆子/新建画布/搜索）。
  不做全局装饰工具栏。
- **Inspector**：上下文面板——选中的豆子、记录或画布节点；窄窗口优先让位。

## 4. 各空间

### Coffee
私人咖啡档案，不是库存后台。中间 hero 是主角（豆名 24px、一行元信息、
latte 库存条、四段阶段轨），冲煮与品鉴是轻列表；不为指标包卡片。

### Records
Sublime 式收藏网格（`auto-fill minmax(216px, 1fr)`）：图片/链接/视频以封面为
主角，文字以正文摘录（cream 内衬）为主角；hover 轻浮起 1px；选中 = espresso
细描边。详情与编辑在右侧上下文栏。

### Canvas
咖啡馆的大桌子：点阵背景（世界间距自适应、屏幕间距钳 14–40px）、白色 16px
圆角节点卡、选中 espresso 细描边、HUD 悬浮钮是全应用唯一允许阴影的地方。

## 5. 组件质感

- **Button**：primary（espresso 白字）/ 常规（白底细边）/ ghost / danger；
  hover 才有反馈，`white-space: nowrap`。
- **Input**：白底细边，聚焦 roast 描边 + 9% 光圈；搜索框图标内嵌。
- **Chip**：无边框幽灵态，选中 cream+espresso；**Badge（阶段）** 是
  色点 + 文字，中性标签用 `.tag`。
- **空态**：一句安静的话，不放插画不放假数据。

## 6. 微交互

全部 0.12–0.18s 的 ease：hover 背景、卡片 1px 浮起、按压回落、导航切换。
不做弹跳、不做长动画。

## 7. 禁止事项

- 不修改 iOS（SwiftUI / Theme.swift / Schema）。
- 不修改 SQLite Schema、Repository、IPC 契约、库存与阶段算法。
- 不引入 UI 依赖库（图标是内联 SVG）。
- 不为视觉效果虚构业务能力（同步没实现就写"还没实现"）。
