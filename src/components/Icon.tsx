/**
 * Icon — sela custom SVG icon family v3.
 * ─────────────────────────────────────────────────────────────────
 * 50+ hand-tuned 24×24 line icons, stroke-width 2, round caps.
 * ZERO emojis anywhere in the app (design.md §7).
 *
 * v3 redraws: settings is a real gear (was a sun-like star),
 * bell is cleaner, plus new basket/barcode/moon/sun/clipboard/
 * scale/shapes marks for v3 features.
 *
 * Usage:
 *   <Icon name="cart" size={24} color={colors.accent} />
 */
import React from 'react';
import Svg, {Circle, Ellipse, G, Path, Rect} from 'react-native-svg';

export type IconName =
  | 'home'
  | 'cart'
  | 'basket'
  | 'box'
  | 'chart'
  | 'settings'
  | 'camera'
  | 'bell'
  | 'bellOff'
  | 'printer'
  | 'search'
  | 'plus'
  | 'minus'
  | 'trash'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronDown'
  | 'moreVertical'
  | 'check'
  | 'checkCircle'
  | 'x'
  | 'alert'
  | 'wifiOff'
  | 'bluetooth'
  | 'download'
  | 'edit'
  | 'image'
  | 'imagePlus'
  | 'scan'
  | 'barcode'
  | 'tag'
  | 'calendar'
  | 'clock'
  | 'refresh'
  | 'info'
  | 'calculator'
  | 'percent'
  | 'packageMinus'
  | 'inbox'
  | 'store'
  | 'sparkles'
  | 'wallet'
  | 'filter'
  | 'save'
  | 'send'
  | 'stethoscope'
  | 'cpu'
  | 'flash'
  | 'database'
  | 'list'
  | 'moon'
  | 'sun'
  | 'clipboard'
  | 'scale'
  | 'shapes'
  | 'swap'
  | 'qrFrame'
  | 'key'
  | 'phone'
  | 'shield'
  | 'lock'
  | 'mail';

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

const P: Record<IconName, React.ReactNode> = {
  home: (
    <G>
      <Path d="M4 11.2 12 4l8 7.2" />
      <Path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" />
      <Path d="M10 20v-5h4v5" />
    </G>
  ),
  cart: (
    <G>
      <Circle cx={9.5} cy={19.5} r={1.6} />
      <Circle cx={17.5} cy={19.5} r={1.6} />
      <Path d="M3 4h2.2l2.1 10.4a1.4 1.4 0 0 0 1.4 1.1h8.5a1.4 1.4 0 0 0 1.4-1.1L20.5 8H6" />
    </G>
  ),
  /** Shopping basket — the sela brand mark. */
  basket: (
    <G>
      <Path d="M3.5 9.5 5.6 19a1.6 1.6 0 0 0 1.6 1.3h9.6a1.6 1.6 0 0 0 1.6-1.3l2.1-9.5" />
      <Path d="M2.8 9.5h18.4" />
      <Path d="M8.5 9.5 12 3.7l3.5 5.8" />
      <Path d="M8.6 13v4M12 13v4M15.4 13v4" />
    </G>
  ),
  /** Activation key. */
  key: (
    <G>
      <Circle cx={8} cy={8.5} r={4.2} />
      <Path d="M11 11.5 20 20.5" />
      <Path d="M16.5 17 14.5 19" />
      <Path d="M19 14.5 17 16.5" />
    </G>
  ),
  /** Phone handset. */
  phone: (
    <G>
      <Path d="M5 4h3.5l1.5 4-2 1.5a12 12 0 0 0 6.5 6.5l1.5-2 4 1.5V19a1.6 1.6 0 0 1-1.8 1.6C10.8 19.7 4.3 13.2 3.4 5.8A1.6 1.6 0 0 1 5 4Z" />
    </G>
  ),
  /** Anti-tamper shield. */
  shield: (
    <G>
      <Path d="M12 3.2 4.8 6v5.4c0 4.5 3 8.2 7.2 9.4 4.2-1.2 7.2-4.9 7.2-9.4V6L12 3.2Z" />
      <Path d="M9 12l2.1 2.1L15.4 10" />
    </G>
  ),
  /** Closed padlock. */
  lock: (
    <G>
      <Rect x={5} y={10.5} width={14} height={9.5} rx={2.2} />
      <Path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </G>
  ),
  /** Envelope. */
  mail: (
    <G>
      <Rect x={3.5} y={5.5} width={17} height={13} rx={2} />
      <Path d="M4 7l8 6 8-6" />
    </G>
  ),
  box: (
    <G>
      <Path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z" />
      <Path d="M3.5 7.5 12 12l8.5-4.5" />
      <Path d="M12 12v9" />
    </G>
  ),
  chart: (
    <G>
      <Path d="M4 4v15a1 1 0 0 0 1 1h15" />
      <Path d="M8 16v-5" />
      <Path d="M12.5 16V7" />
      <Path d="M17 16v-3" />
    </G>
  ),
  /** Real gear — replaced the old sun-like star. */
  settings: (
    <G>
      <Path d="M10.3 3.4a1.3 1.3 0 0 1 2.5-.6l.2.9a1.3 1.3 0 0 0 1.8.9l.8-.4a1.3 1.3 0 0 1 1.7 1.7l-.4.8a1.3 1.3 0 0 0 .7 1.8l.9.3a1.3 1.3 0 0 1 0 2.4l-.9.3a1.3 1.3 0 0 0-.7 1.8l.4.8a1.3 1.3 0 0 1-1.7 1.7l-.8-.4a1.3 1.3 0 0 0-1.8.7l-.3.9a1.3 1.3 0 0 1-2.4 0l-.3-.9a1.3 1.3 0 0 0-1.8-.7l-.8.4a1.3 1.3 0 0 1-1.7-1.7l.4-.8a1.3 1.3 0 0 0-.7-1.8l-.9-.3a1.3 1.3 0 0 1 0-2.4l.9-.3a1.3 1.3 0 0 0 .7-1.8l-.4-.8a1.3 1.3 0 0 1 1.7-1.7l.8.4a1.3 1.3 0 0 0 1.8-.7l.2-.9Z" />
      <Circle cx={11.2} cy={11.9} r={2.6} />
    </G>
  ),
  camera: (
    <G>
      <Path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2L9 4.8h6L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z" />
      <Circle cx={12} cy={13} r={3.4} />
    </G>
  ),
  bell: (
    <G>
      <Path d="M12 3.6a5.6 5.6 0 0 0-5.6 5.6c0 4.4-1.1 5.9-1.7 6.6-.3.4 0 1 .5 1h13.6c.5 0 .8-.6.5-1-.6-.7-1.7-2.2-1.7-6.6A5.6 5.6 0 0 0 12 3.6Z" />
      <Path d="M9.8 20.5a2.4 2.4 0 0 0 4.4 0" />
    </G>
  ),
  bellOff: (
    <G>
      <Path d="M6.5 9.2A5.6 5.6 0 0 1 12 3.6a5.6 5.6 0 0 1 5.5 4.6c.1 4.4 1.2 6.5 1.8 7.2.3.4 0 1-.5 1H8.4" />
      <Path d="M6.4 8v.7c0 4.4-1.1 5.9-1.7 6.6-.3.4 0 1 .5 1h1.4" />
      <Path d="M9.8 20.5a2.4 2.4 0 0 0 4.4 0" />
      <Path d="M4 4l16 16" />
    </G>
  ),
  printer: (
    <G>
      <Path d="M7 9V4h10v5" />
      <Rect x={4} y={9} width={16} height={7} rx={1.4} />
      <Path d="M7 14h10v6H7v-6Z" />
    </G>
  ),
  search: (
    <G>
      <Circle cx={11} cy={11} r={6.5} />
      <Path d="m20 20-4.4-4.4" />
    </G>
  ),
  plus: (
    <G>
      <Path d="M12 5v14M5 12h14" />
    </G>
  ),
  minus: <Path d="M5 12h14" />,
  trash: (
    <G>
      <Path d="M4.5 6.5h15M9.5 6.5V4.8a.8.8 0 0 1 .8-.8h3.4a.8.8 0 0 1 .8.8v1.7" />
      <Path d="M6.5 6.5 7.3 19a1.2 1.2 0 0 0 1.2 1.1h7a1.2 1.2 0 0 0 1.2-1.1l.8-12.5" />
      <Path d="M10.2 10.5v6M13.8 10.5v6" />
    </G>
  ),
  chevronLeft: <Path d="m14.5 5.5-6.5 6.5 6.5 6.5" />,
  chevronRight: <Path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  chevronDown: <Path d="m5.5 9.5 6.5 6.5 6.5-6.5" />,
  /** v8.2: three-dot overflow menu (Inventory quick actions). */
  moreVertical: <Path d="M12 5.5v.01M12 12v.01M12 18.5v.01" strokeWidth={3} />,
  check: <Path d="m5 12.8 4.6 4.6L19 6.8" />,
  checkCircle: (
    <G>
      <Circle cx={12} cy={12} r={8.5} />
      <Path d="m8.3 12.4 2.6 2.6 4.9-5.4" />
    </G>
  ),
  x: <Path d="M6 6l12 12M18 6 6 18" />,
  alert: (
    <G>
      <Path d="M12 4.5 21 19.5H3L12 4.5Z" />
      <Path d="M12 10.2v3.6" />
      <Circle cx={12} cy={16.4} r={0.4} />
    </G>
  ),
  wifiOff: (
    <G>
      <Path d="M4 4l16 16" />
      <Path d="M8.1 12.6a5.6 5.6 0 0 1 3-1.5M4.5 9a11 11 0 0 1 3.2-2M15.6 11a5.6 5.6 0 0 1 1.8 1.6M12.6 8a11 11 0 0 1 3 1.1" />
      <Circle cx={12} cy={16.5} r={0.5} />
    </G>
  ),
  bluetooth: (
    <G>
      <Path d="M7.5 7.2 16 16.8 12 20V4l4 3.2-8.5 9.6" />
    </G>
  ),
  download: (
    <G>
      <Path d="M12 4v11" />
      <Path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <Path d="M4.5 19.5h15" />
    </G>
  ),
  edit: (
    <G>
      <Path d="M14.5 5.5 18.5 9.5" />
      <Path d="M5 19.5l1-4.2 9.7-9.7a1.6 1.6 0 0 1 2.3 0l1.4 1.4a1.6 1.6 0 0 1 0 2.3l-9.7 9.7-4.7 1.5Z" />
    </G>
  ),
  image: (
    <G>
      <Rect x={4} y={5} width={16} height={14} rx={1.6} />
      <Circle cx={9} cy={10} r={1.5} />
      <Path d="m5 17.5 4.4-4a1.5 1.5 0 0 1 2 0l5.8 5" />
    </G>
  ),
  imagePlus: (
    <G>
      <Rect x={3.5} y={5} width={14} height={13} rx={1.6} />
      <Path d="m4.5 15.5 3.9-3.6a1.5 1.5 0 0 1 2 0l5.1 4.6" />
      <Circle cx={8.5} cy={9} r={1.3} />
      <Path d="M18 4.5v6M15 7.5h6" />
    </G>
  ),
  scan: (
    <G>
      <Path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <Path d="M4 12h16" />
    </G>
  ),
  /** Barcode scan mark. */
  barcode: (
    <G>
      <Path d="M3.5 19V7.5a1.5 1.5 0 0 1 1.5-1.5h14a1.5 1.5 0 0 1 1.5 1.5V19" />
      <Path d="M3.5 21h17" />
      <Path d="M7.5 9.5v6M10.5 9.5v6M13.5 9.5v6M16.5 9.5v4" />
    </G>
  ),
  tag: (
    <G>
      <Path d="M11.2 3.8H19a1.2 1.2 0 0 1 1.2 1.2v7.8L11.6 21a1.4 1.4 0 0 1-2 0l-6.4-6.4a1.4 1.4 0 0 1 0-2l8-8.8Z" />
      <Circle cx={16} cy={8} r={1.3} />
    </G>
  ),
  calendar: (
    <G>
      <Rect x={4} y={5.5} width={16} height={14.5} rx={1.6} />
      <Path d="M8 3.5v4M16 3.5v4M4 10.5h16" />
    </G>
  ),
  clock: (
    <G>
      <Circle cx={12} cy={12} r={8.5} />
      <Path d="M12 7.5V12l3 2" />
    </G>
  ),
  refresh: (
    <G>
      <Path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1" />
      <Path d="M17 3.5v3.4h-3.4M7 20.5v-3.4h3.4" />
    </G>
  ),
  info: (
    <G>
      <Circle cx={12} cy={12} r={8.5} />
      <Path d="M12 11v5" />
      <Circle cx={12} cy={7.8} r={0.4} />
    </G>
  ),
  calculator: (
    <G>
      <Rect x={5.5} y={3.5} width={13} height={17} rx={1.6} />
      <Path d="M8.5 7.5h7" />
      <Path d="M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 15.5h.01M12 15.5h.01M15.5 15.5h.01" />
    </G>
  ),
  percent: (
    <G>
      <Path d="M5.5 18.5 18.5 5.5" />
      <Circle cx={7.5} cy={7.5} r={2.2} />
      <Circle cx={16.5} cy={16.5} r={2.2} />
    </G>
  ),
  packageMinus: (
    <G>
      <Path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z" />
      <Path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
      <Path d="M9 15.5h6" />
    </G>
  ),
  inbox: (
    <G>
      <Path d="M4 13.5 6 5.5a1.2 1.2 0 0 1 1.2-1h9.6A1.2 1.2 0 0 1 18 5.5l2 8" />
      <Path d="M4 13.5h4.5l1 2.5h5l1-2.5H20v4.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18v-4.5Z" />
    </G>
  ),
  store: (
    <G>
      <Path d="M4 9.5V19a1.2 1.2 0 0 0 1.2 1.2h13.6A1.2 1.2 0 0 0 20 19V9.5" />
      <Path d="M3.5 9.5 5 4.5h14l1.5 5" />
      <Path d="M9.5 20v-5.5h5V20" />
      <Path d="M3.5 9.5a2.6 2.6 0 0 0 5.2 0 2.6 2.6 0 0 0 5.2 0 2.6 2.6 0 0 0 5.2 0" />
    </G>
  ),
  sparkles: (
    <G>
      <Path d="M12 4.5 13.4 9l4.6 1.4-4.6 1.4L12 16.4l-1.4-4.6L6 10.4 10.6 9 12 4.5Z" />
      <Path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" />
    </G>
  ),
  wallet: (
    <G>
      <Path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-9Z" />
      <Path d="M15 12h5.5" />
      <Circle cx={15.8} cy={12} r={0.9} />
    </G>
  ),
  filter: (
    <G>
      <Path d="M4 6h16M7 12h10M10.5 18h3" />
    </G>
  ),
  send: (
    <G>
      <Path d="M20 4.5 4.5 11l5.5 2.5L12.5 19 20 4.5Z" />
      <Path d="m10 13.5 4.5-4.5" />
    </G>
  ),
  save: (
    <G>
      <Path d="M5 5.5A1.5 1.5 0 0 1 6.5 4h9L20 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 5 18.5v-13Z" />
      <Path d="M8 4v5h7" />
      <Path d="M8 14h8v6H8v-6Z" />
    </G>
  ),
  stethoscope: (
    <G>
      <Path d="M6 4v5a4 4 0 0 0 8 0V4" />
      <Path d="M6 4H4.5M14 4h1.5M10 13v2.5a4.5 4.5 0 0 0 9 0v-2" />
      <Circle cx={19} cy={10.5} r={2} />
    </G>
  ),
  cpu: (
    <G>
      <Rect x={7} y={7} width={10} height={10} rx={1.4} />
      <Rect x={4} y={4} width={16} height={16} rx={2} />
      <Path d="M9.5 2v2M14.5 2v2M9.5 20v2M14.5 20v2M2 9.5h2M2 14.5h2M20 9.5h2M20 14.5h2" />
    </G>
  ),
  flash: (
    <G>
      <Path d="M13 3 5.5 13.5H11L10.5 21 18.5 10.5H13L13 3Z" />
    </G>
  ),
  database: (
    <G>
      <Ellipse cx={12} cy={5.5} rx={7.5} ry={2.8} />
      <Path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" />
      <Path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </G>
  ),
  list: (
    <G>
      <Path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H20" />
      <Circle cx={4.6} cy={6.5} r={1} />
      <Circle cx={4.6} cy={12} r={1} />
      <Circle cx={4.6} cy={17.5} r={1} />
    </G>
  ),
  /** Dark mode crescent. */
  moon: (
    <G>
      <Path d="M20 13.6A8.4 8.4 0 0 1 10.4 4 8.4 8.4 0 1 0 20 13.6Z" />
    </G>
  ),
  /** Light mode sun. */
  sun: (
    <G>
      <Circle cx={12} cy={12} r={4} />
      <Path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
    </G>
  ),
  /** Stocktake clipboard with check. */
  clipboard: (
    <G>
      <Path d="M9 4.5H7.5A1.5 1.5 0 0 0 6 6v13a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V6a1.5 1.5 0 0 0-1.5-1.5H15" />
      <Rect x={9} y={3} width={6} height={3.5} rx={1.2} />
      <Path d="m9.2 12.6 1.9 1.9 3.7-4" />
    </G>
  ),
  /** Weighing scale — units. */
  scale: (
    <G>
      <Path d="M12 3.5a8.5 8.5 0 0 0-8.4 9.9l1.6-1.1a2 2 0 0 1 2.7.5l1 1.4a2 2 0 0 1-.5 2.8l-.8.6a8.5 8.5 0 0 0 8.8 0l-.8-.6a2 2 0 0 1-.5-2.8l1-1.4a2 2 0 0 1 2.7-.5l1.6 1.1A8.5 8.5 0 0 0 12 3.5Z" />
      <Path d="M12 3.5v4" />
      <Path d="M10 7.5h4l1.8 3.4a1 1 0 0 1-.9 1.5h-5.8a1 1 0 0 1-.9-1.5L10 7.5Z" />
    </G>
  ),
  /** Categories — shapes. */
  shapes: (
    <G>
      <Rect x={3.5} y={13} width={7.5} height={7.5} rx={1.4} />
      <Circle cx={16.8} cy={16.8} r={3.8} />
      <Path d="M12 3.2l4.2 7.3H7.8L12 3.2Z" />
    </G>
  ),
  /** Swap / convert (unit conversions). */
  swap: (
    <G>
      <Path d="M4 8.5h13l-3.2-3.2M20 15.5H7l3.2 3.2" />
    </G>
  ),
  /** Frame with dot — logo mark placeholder. */
  qrFrame: (
    <G>
      <Path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <Circle cx={12} cy={12} r={2.2} />
    </G>
  ),
};

export function Icon({
  name,
  size = 24,
  color = '#F4F4F5',
  strokeWidth = 2,
}: IconProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <G
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round">
        {P[name]}
      </G>
    </Svg>
  );
}

/** Circular icon chip used in headers, notification rows and empty states. */
export function IconChip({
  name,
  size = 22,
  chipSize = 44,
  bg,
  color,
}: {
  name: IconName;
  size?: number;
  chipSize?: number;
  bg: string;
  color: string;
}): React.JSX.Element {
  const iconOffset = (chipSize - size) / 2;
  return (
    <Svg
      width={chipSize}
      height={chipSize}
      viewBox={`0 0 ${chipSize} ${chipSize}`}>
      <Circle cx={chipSize / 2} cy={chipSize / 2} r={chipSize / 2} fill={bg} />
      <G
        transform={`translate(${iconOffset}, ${iconOffset})`}
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round">
        {P[name]}
      </G>
    </Svg>
  );
}
