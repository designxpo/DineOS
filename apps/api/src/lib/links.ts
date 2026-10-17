import type { Config } from '../config';
import { signPickupToken, type PickupClaims } from './tokens';

/** The web app's address, taken from the table QR link template ("https://site/t/{token}"). */
export function webOrigin(config: Pick<Config, 'GUEST_URL_TEMPLATE'>): string | null {
  try {
    return new URL(config.GUEST_URL_TEMPLATE.replace('{slug}', 'x').replace('{token}', 'x')).origin;
  } catch {
    return null;
  }
}

/** The pickup screen for the TV by the counter. */
export function pickupUrl(config: Pick<Config, 'GUEST_URL_TEMPLATE' | 'TOKEN_SECRET'>, claims: PickupClaims): string {
  return `${webOrigin(config) ?? ''}/pickup/${signPickupToken(config.TOKEN_SECRET, claims)}`;
}
