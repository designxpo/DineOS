/** Normalises Indian numbers to +91XXXXXXXXXX; other inputs are returned trimmed with spaces removed. */
export function normalizePhone(input: string): string {
  const compact = input.replace(/[\s\-().]/g, '');
  if (/^\d{10}$/.test(compact)) return `+91${compact}`;
  if (/^0\d{10}$/.test(compact)) return `+91${compact.slice(1)}`;
  if (/^91\d{10}$/.test(compact)) return `+${compact}`;
  return compact;
}

export function looksLikeEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim());
}
