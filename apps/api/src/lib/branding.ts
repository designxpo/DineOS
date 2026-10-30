// What look staff and guests get: the restaurant's own (logo, cover, colour, headings) when its plan
// or Mezvaan allows it, otherwise the Mezvaan look (an empty branding).

import type { BrandingDTO } from '@mezmitra/shared/dto';
import { HEADING_STYLES, HEX_COLOR, whiteLabelOn, type HeadingStyle } from '@mezmitra/shared/branding';
import type { Tx } from '../context';

const url = (v: unknown) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : null);

/** Only the fields screens use, and only well-formed values (the column is free JSON). */
export function cleanBranding(raw: unknown): BrandingDTO {
  const b = (raw ?? {}) as Record<string, unknown>;
  return {
    logo_url: url(b.logo_url),
    cover_url: url(b.cover_url),
    primary_color: typeof b.primary_color === 'string' && HEX_COLOR.test(b.primary_color) ? b.primary_color.toLowerCase() : null,
    heading_style: HEADING_STYLES.includes(b.heading_style as HeadingStyle) ? (b.heading_style as HeadingStyle) : null,
  };
}

/** The tenant of `tx`: its name, whether its own look is on, and the branding to show. */
export async function shownBrand(tx: Tx): Promise<{ name: string; slug: string; white_label: boolean; branding: BrandingDTO }> {
  const t = await tx.db
    .selectFrom('tenants')
    .innerJoin('plans', 'plans.code', 'tenants.plan_code')
    .select(['tenants.name', 'tenants.slug', 'tenants.branding', 'tenants.white_label', 'plans.features'])
    .where('tenants.id', '=', tx.tenantId)
    .executeTakeFirstOrThrow();
  const on = whiteLabelOn(t.features, t.white_label);
  return { name: t.name, slug: t.slug, white_label: on, branding: on ? cleanBranding(t.branding) : {} };
}
