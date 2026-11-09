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

/** 选择：指针箭头 */
export function SelectIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6 3.6v11l2.9-2.6 1.9 3.9 2.1-1-1.9-3.8h3.8L6 3.6Z" />
    </svg>
  )
}

/** 平移：四向箭头（抓手工具的替代——比手势 emoji 更稳定、也更贴线性图标语言） */
export function PanIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M10 3.4v13.2M3.4 10h13.2" />
      <path d="m7.4 6 2.6-2.6L12.6 6M7.4 14l2.6 2.6L12.6 14M6 7.4 3.4 10 6 12.6M14 7.4 16.6 10 14 12.6" />
    </svg>
  )
}

/** 画笔：铅笔 */
export function PenIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3.8 16.2 4.9 12l8-8a1.7 1.7 0 0 1 2.4 0l.7.7a1.7 1.7 0 0 1 0 2.4l-8 8-4.2 1.1Z" />
      <path d="m11.6 5.3 3.1 3.1" />
    </svg>
  )
}

/** 橡皮：斜置的橡皮块 + 擦拭线 */
export function EraserIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4.6 11.4 9.9 6a1.6 1.6 0 0 1 2.3 0l2.6 2.6a1.6 1.6 0 0 1 0 2.3l-3.6 3.6H7.1L4.6 13.7a1.6 1.6 0 0 1 0-2.3Z" />
      <path d="M8.4 7.5 12.9 12M9.4 16.2h6.9" />
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
