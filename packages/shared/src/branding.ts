// A restaurant's own look (white label for its staff and guests, not for resale): its logo, cover
// photo, colour and heading style on the staff portal, the QR menu, order tracking and the pickup
// screen. Whether it shows depends on the plan, unless Mezvaan sets it for one restaurant.

export const HEADING_STYLES = ['serif', 'sans'] as const;
export type HeadingStyle = (typeof HEADING_STYLES)[number];

/** Mezvaan's own brand colour (Spice & Ink). */
export const DEFAULT_BRAND_COLOR = '#b9381e';
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** The plan feature that turns a restaurant's own look on. */
export const WHITE_LABEL_FEATURE = 'white_label';

/** Whether a restaurant's own look shows: its plan includes it, unless Mezvaan set it for this restaurant. */
export function whiteLabelOn(planFeatures: unknown, override: boolean | null | undefined): boolean {
  if (override === true || override === false) return override;
  return (planFeatures as Record<string, unknown> | null)?.[WHITE_LABEL_FEATURE] === true;
}

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

/** `a` moved `share` of the way towards `b`. */
function mix(a: string, b: string, share: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * share) as Rgb);
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export type BrandShade = '50' | '100' | '200' | '500' | '600' | '700' | '900';

/**
 * Every brand shade the screens use, from one colour. White text sits on the main shade (buttons)
 * and the main shade is used as text on white, so a light colour is darkened until both read at
 * 4.5:1; the pale tints keep the colour as chosen.
 */
export function brandShades(color: string): { shades: Record<BrandShade, string>; main: string; adjusted: boolean } {
  const chosen = HEX_COLOR.test(color) ? color.toLowerCase() : DEFAULT_BRAND_COLOR;
  let main = chosen;
  for (let i = 0; i < 40 && contrast(main, '#ffffff') < 4.5; i++) main = mix(main, '#000000', 0.06);
  return {
    main,
    adjusted: main !== chosen,
    shades: {
      '50': mix(chosen, '#ffffff', 0.92),
      '100': mix(chosen, '#ffffff', 0.84),
      '200': mix(chosen, '#ffffff', 0.64),
      '500': mix(main, '#ffffff', 0.12),
      '600': main,
      '700': mix(main, '#000000', 0.18),
      '900': mix(main, '#000000', 0.6),
    },
  };
}
