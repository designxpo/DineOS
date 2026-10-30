import { describe, expect, it } from 'vitest';
import { brandShades, contrast, DEFAULT_BRAND_COLOR, whiteLabelOn } from './branding';

describe('brand shades', () => {
  it('keeps a dark enough colour as chosen', () => {
    const { main, adjusted, shades } = brandShades('#1d4ed8');
    expect(main).toBe('#1d4ed8');
    expect(adjusted).toBe(false);
    expect(shades['600']).toBe('#1d4ed8');
  });

  it('darkens a light colour until white text on it is readable, keeping its tints', () => {
    const { main, adjusted, shades } = brandShades('#f5c518');
    expect(adjusted).toBe(true);
    expect(contrast(main, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    // The pale tint is still recognisably the chosen yellow, not the darkened one.
    expect(contrast(shades['50'], '#ffffff')).toBeLessThan(1.1);
    expect(contrast(shades['700'], shades['50'])).toBeGreaterThanOrEqual(4.5);
  });

  it('falls back to the Mezvaan colour for anything that is not a colour', () => {
    expect(brandShades('red').main).toBe(DEFAULT_BRAND_COLOR);
  });
});

describe('white label', () => {
  it('follows the plan unless set for the restaurant', () => {
    expect(whiteLabelOn({ white_label: true }, null)).toBe(true);
    expect(whiteLabelOn({ white_label: false }, null)).toBe(false);
    expect(whiteLabelOn({}, undefined)).toBe(false);
    expect(whiteLabelOn({ white_label: false }, true)).toBe(true);
    expect(whiteLabelOn({ white_label: true }, false)).toBe(false);
  });
});
