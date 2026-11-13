/**
 * 线性图标集：一颗一份的 SVG，统一 20px 视框、1.6 描边、`currentColor` 取色。
 *
 * 不引第三方图标库——导航栏只需要四个图标，为它们加依赖不值。
 * 图标语言与 iOS 的 SF Symbols 近似：细描边、圆角端点、几何而非拟物。
 */

type IconProps = { size?: number }

function base(size: number) {
  return {
    className: 'icon',
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
}

/** 咖啡豆：椭圆豆形 + 中缝 */
export function BeanIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M10 2.6c2.9 0 6.4 2.6 6.4 7.4s-3.5 7.4-6.4 7.4S3.6 14.8 3.6 10 7.1 2.6 10 2.6Z" />
      <path d="M10 2.6c-2 2.2-2 5.2 0 7.4s2 5.2 0 7.4" />
    </svg>
  )
}

/** 记录：三层叠放的档案 */
export function RecordsIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="3.2" width="14" height="4.2" rx="1.4" />
      <rect x="3" y="9" width="14" height="4.2" rx="1.4" />
      <path d="M3.6 16.2h12.8" />
    </svg>
  )
}

/** 画布：带节点的取景框 */
export function CanvasIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="3.2" width="14" height="13.6" rx="2.4" />
      <rect x="6.4" y="6.4" width="4" height="3.2" rx="1" />
      <rect x="11.4" y="11" width="3.2" height="3.2" rx="1" />
    </svg>
  )
}

/** 应用菜单：三条横线（比 Sliders 更轻，语义是「菜单」而不是「设置」）。 */
export function MenuIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3.4 5.6h11.2M3.4 10h11.2M3.4 14.4h11.2" />
    </svg>
  )
}

/** 更多：三条调节杆 */
export function SlidersIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3.4 6.4h13.2M3.4 13.6h13.2" />
      <circle cx="8" cy="6.4" r="1.8" fill="var(--paper)" />
      <circle cx="12.4" cy="13.6" r="1.8" fill="var(--paper)" />
    </svg>
  )
}

/** 搜索：放大镜 */
export function SearchIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="9" cy="9" r="5.4" />
      <path d="m13.2 13.2 3.4 3.4" />
    </svg>
  )
}

/* ---------- 画布工具：同一套 20px 视框与 1.6 描边 ---------- */

/*
  画布工具图标。与导航一套语言（20px 视框、1.6 描边、圆端点），但轮廓刻意
  避开通用白板那几枚：选择不是箭头而是一只对焦框，平移不是四向箭头而是手掌。
  这样工具栏在缩略图尺度上也能被认出来是 BrewPhase 的东西。
*/

/** 选择：对焦框 + 中心点（不是指针箭头——这里选的是内容，不是鼠标位置） */
export function SelectIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M7.2 3.4H5.4a2 2 0 0 0-2 2v1.8" />
      <path d="M12.8 3.4h1.8a2 2 0 0 1 2 2v1.8" />
      <path d="M7.2 16.6H5.4a2 2 0 0 1-2-2v-1.8" />
      <path d="M12.8 16.6h1.8a2 2 0 0 0 2-2v-1.8" />
      <circle cx="10" cy="10" r="1.5" />
    </svg>
  )
}

/** 移动：手掌（撑住台面挪动视角，比四向箭头更像在搬东西） */
export function PanIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M7.5 10.6V6.8a1.25 1.25 0 0 1 2.5 0v2.9" />
      <path d="M10 9.5V5.5a1.25 1.25 0 0 1 2.5 0v4.4" />
      <path d="M12.5 9.9V7.7a1.25 1.25 0 0 1 2.5 0v5.2a4.6 4.6 0 0 1-4.6 4.6h-.6a3.6 3.6 0 0 1-2.8-1.4l-2.5-3.2a1.3 1.3 0 0 1 1.9-1.7l1.6 1.6" />
    </svg>
  )
}

/** 画笔：笔身 + 笔箍 + 斜切的笔尖 */
export function PenIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M14.3 4.2a1.7 1.7 0 0 1 2.4 2.4l-8.1 8.1-3.4 1 1-3.4Z" />
      <path d="m12.9 5.6 2.3 2.3" />
      <path d="m6.3 12.4 2.2 2.2" />
    </svg>
  )
}

/** 橡皮：斜置块 + 分割线 + 擦过的痕迹 */
export function EraserIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12.4 4.6 16.6 8.8a1.3 1.3 0 0 1 0 1.9l-4.5 4.5a1.3 1.3 0 0 1-1.9 0l-4.2-4.2a1.3 1.3 0 0 1 0-1.9l4.5-4.5a1.3 1.3 0 0 1 1.9 0Z" />
      <path d="m7.3 8.5 5.3 5.3" />
      <path d="M8.2 16.4h7.6" />
    </svg>
  )
}

/** 便签：带折角的纸片 */
export function NoteIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4.6 3.8h7.2l3.6 3.6v8.8a1.4 1.4 0 0 1-1.4 1.4H4.6a1.4 1.4 0 0 1-1.4-1.4V5.2a1.4 1.4 0 0 1 1.4-1.4Z" />
      <path d="M11.6 3.9v3.7h3.7M6.4 11h5.2M6.4 13.8h3.4" />
    </svg>
  )
}

/** 新建便签：折角纸片 + 右上角加号。与便签工具区分——那是「点画布放」，这是「马上来一张」 */
export function NoteAddIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4.6 3.8h7.2l3.6 3.6v8.8a1.4 1.4 0 0 1-1.4 1.4H4.6a1.4 1.4 0 0 1-1.4-1.4V5.2a1.4 1.4 0 0 1 1.4-1.4Z" />
      <path d="M11.6 3.9v3.7h3.7M6.4 11h5.2M6.4 13.8h3.4" />
      <path d="M16.9 2.8v3M15.4 4.3h3" />
    </svg>
  )
}

/** 图片：相框 + 山脊线 + 一点光（导入图片） */
export function ImageIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3.4" y="4.6" width="13.2" height="10.8" rx="2" />
      <circle cx="7.4" cy="8.4" r="1.1" />
      <path d="m4.3 13.9 3.5-3.5 2.5 2.5 2.1-2.1 3.5 3.5" />
    </svg>
  )
}

/** 记录：两张错开的卡片 + 加号（从记录里取一张放到台面上） */
export function RecordIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3.4" y="6.2" width="9.6" height="10.2" rx="1.8" />
      <path d="M6.9 4.2h6.6a2 2 0 0 1 2 2v6.5" />
      <path d="M15.9 14.1v4.3M13.8 16.3h4.3" />
    </svg>
  )
}

/* ---------- 内置浏览器：同为 20px 视框、1.6 描边 ---------- */

/** 浏览器：经线 + 纬线的球体 */
export function GlobeIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="10" cy="10" r="6.4" />
      <path d="M3.6 10h12.8" />
      <path d="M10 3.6c1.9 2 2.9 4.2 2.9 6.4s-1 4.4-2.9 6.4c-1.9-2-2.9-4.2-2.9-6.4S8.1 5.6 10 3.6Z" />
    </svg>
  )
}

/** 后退：左箭头 */
export function ArrowLeftIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M15.4 10H4.8M9.4 4.6 4 10l5.4 5.4" />
    </svg>
  )
}

/** 前进：右箭头 */
export function ArrowRightIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4.6 10h10.6M10.6 4.6 16 10l-5.4 5.4" />
    </svg>
  )
}

/** 刷新：带缺口的环 + 箭头 */
export function ReloadIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M16.2 10a6.2 6.2 0 1 1-1.9-4.4" />
      <path d="M16.4 3.6v3.6h-3.6" />
    </svg>
  )
}

/** 停止：圆内一只方块 */
export function StopIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="10" cy="10" r="6.4" />
      <rect x="7.9" y="7.9" width="4.2" height="4.2" rx="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 外部打开：从方框右上角射出的箭头 */
export function ExternalIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M11.4 3.8h4.8v4.8" />
      <path d="M16.2 3.8 9.6 10.4" />
      <path d="M13.6 12.2v3.4a1.2 1.2 0 0 1-1.2 1.2H4.6a1.2 1.2 0 0 1-1.2-1.2V7.8a1.2 1.2 0 0 1 1.2-1.2h3.4" />
    </svg>
  )
}

/** 起始页：一栋房子的轮廓 */
export function HomeIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3.6 9.4 10 3.6l6.4 5.8" />
      <path d="M5.2 8.6v7.2a.8.8 0 0 0 .8.8h2.6v-4.4h2.8v4.4H14a.8.8 0 0 0 .8-.8V8.6" />
    </svg>
  )
}

/** 缩小：一条水平线 */
export function MinusIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4.6 10h10.8" />
    </svg>
  )
}

/** 放大：水平线 + 垂直线 */
export function PlusIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4.6 10h10.8" />
      <path d="M10 4.6v10.8" />
    </svg>
  )
}

/** 适配全部内容：四角取景框 */
export function FitIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M7.4 3.8H4.6a.8.8 0 0 0-.8.8v2.8" />
      <path d="M12.6 3.8h2.8a.8.8 0 0 1 .8.8v2.8" />
      <path d="M7.4 16.2H4.6a.8.8 0 0 1-.8-.8v-2.8" />
      <path d="M12.6 16.2h2.8a.8.8 0 0 0 .8-.8v-2.8" />
    </svg>
  )
}
