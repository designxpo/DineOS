import type { BrandingDTO } from '@mezmitra/shared/dto';
import { cn } from '@/components/ui/cn';

/**
 * The restaurant's logo when it has its own look. Otherwise: on screens a guest sees (pass `name`),
 * the restaurant's initial, because Mezmitra names the platform, not the restaurant; on staff
 * screens, the Mezmitra app icon.
 */
export function BrandMark({ branding, className, name }: { branding?: BrandingDTO | null; className?: string; name?: string | null }) {
  if (branding?.logo_url) {
    // Logos come in every shape: shown whole on white, never cropped.
    return <img src={branding.logo_url} alt="" className={cn('shrink-0 bg-white object-contain', className)} />;
  }
  if (name !== undefined) {
    return (
      <div className={cn('grid shrink-0 place-items-center bg-[var(--brand)] font-display font-bold text-white', className)} aria-hidden>
        <span className="text-[1.4em] leading-none">{(name ?? '').trim().charAt(0).toUpperCase() || '·'}</span>
      </div>
    );
  }
  return <img src="/icon.svg" alt="" className={cn('shrink-0', className)} />;
}
