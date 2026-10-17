import { ChefHat } from 'lucide-react';
import type { BrandingDTO } from '@dineos/shared/dto';
import { cn } from '@/components/ui/cn';

/** The restaurant's logo when it has its own look; the DineOS mark otherwise. */
export function BrandMark({ branding, className, iconClassName }: { branding?: BrandingDTO | null; className?: string; iconClassName?: string }) {
  if (branding?.logo_url) {
    // Logos come in every shape: shown whole on white, never cropped.
    return <img src={branding.logo_url} alt="" className={cn('shrink-0 bg-white object-contain', className)} />;
  }
  return (
    <div className={cn('grid shrink-0 place-items-center bg-[var(--brand)] text-white', className)}>
      <ChefHat className={cn('size-1/2', iconClassName)} />
    </div>
  );
}
