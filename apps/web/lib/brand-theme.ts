'use client';

// A restaurant's own look on a whole page: every brand shade, the heading font, the browser's bar
// colour, the tab icon and the tab title. Set on the document root so sheets and dialogs (which
// render outside the page's own tree) carry it too. An empty branding leaves the Mezvaan look.

import { useEffect } from 'react';
import { brandShades } from '@mezmitra/shared/branding';
import type { BrandingDTO } from '@mezmitra/shared/dto';

// Mezvaan's own headings are sans (Manrope); a restaurant can choose classic serif ones.
const SERIF = 'var(--font-fraunces), Georgia, serif';

/** The CSS variables for a branding: brand shades and the heading font. Empty for the Mezvaan look. */
export function brandVars(b: BrandingDTO | null | undefined): Record<string, string> {
  const vars: Record<string, string> = {};
  if (b?.primary_color) {
    const { shades, main } = brandShades(b.primary_color);
    for (const [k, v] of Object.entries(shades)) vars[`--color-brand-${k}`] = v;
    vars['--brand'] = main;
  }
  if (b?.heading_style === 'serif') vars['--font-display'] = SERIF;
  return vars;
}

/** The same variables as an inline style, for a preview of a look not saved yet. */
export const brandStyle = (b: BrandingDTO | null | undefined) => brandVars(b) as React.CSSProperties;

/** Applies a restaurant's look to the page while mounted. `name` replaces "Mezvaan" in the tab title. */
export function useBrandTheme(branding: BrandingDTO | null | undefined, name?: string | null): void {
  const color = branding?.primary_color ?? null;
  const heading = branding?.heading_style ?? null;
  const logo = branding?.logo_url ?? null;
  const own = Boolean(color || heading || logo);

  useEffect(() => {
    if (!own) return;
    const root = document.documentElement;
    const vars = brandVars({ primary_color: color, heading_style: heading });
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);

    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const metaBefore = meta?.content;
    if (meta && vars['--brand']) meta.content = vars['--brand'];

    let icon: HTMLLinkElement | null = null;
    if (logo) {
      icon = document.createElement('link');
      icon.rel = 'icon';
      icon.href = logo;
      icon.dataset.brand = '1';
      document.head.appendChild(icon);
    }

    // Page titles are "Orders · Mezvaan": the restaurant's name instead.
    let observer: MutationObserver | null = null;
    if (name) {
      const rename = () => {
        if (document.title.includes('Mezvaan')) document.title = document.title.replaceAll('Mezvaan', name);
      };
      rename();
      observer = new MutationObserver(rename);
      observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    }

    return () => {
      for (const k of Object.keys(vars)) root.style.removeProperty(k);
      if (meta && metaBefore !== undefined) meta.content = metaBefore;
      icon?.remove();
      observer?.disconnect();
    };
  }, [own, color, heading, logo, name]);
}
