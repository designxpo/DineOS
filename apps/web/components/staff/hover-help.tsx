'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { installHoverHelp } from '@/lib/hover-help';

export function HoverHelp() {
  const { lang } = useI18n();
  const { outletId } = useStaff();
  const pathname = usePathname();
  useEffect(() => installHoverHelp(lang === 'hi'), [lang, pathname, outletId]);
  return null;
}
