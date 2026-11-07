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
