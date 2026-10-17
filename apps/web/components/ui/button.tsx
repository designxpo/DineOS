import { forwardRef } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'xl';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-[var(--brand)] text-white hover:brightness-110 active:brightness-95 shadow-sm',
  secondary: 'bg-stone-100 text-ink hover:bg-stone-200 active:bg-stone-300',
  outline: 'border border-line bg-surface text-ink hover:bg-stone-50 active:bg-stone-100',
  ghost: 'text-ink-soft hover:bg-stone-100 hover:text-ink',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-800',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800',
};

// Every size keeps at least a 44px touch target except `sm`, which is for dense desktop tables.
const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm gap-1.5 rounded-lg',
  md: 'h-11 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-5 text-base gap-2 rounded-xl',
  xl: 'h-14 px-6 text-base gap-2.5 rounded-2xl',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        // The press shows on touch-down, before the click lands.
        'inline-flex cursor-pointer select-none items-center justify-center font-medium whitespace-nowrap transition duration-150 enabled:active:scale-[0.97] enabled:active:duration-75 disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading && <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-grid size-11 cursor-pointer place-items-center rounded-xl text-ink-soft transition hover:bg-stone-100 hover:text-ink enabled:active:scale-90 enabled:active:bg-stone-200 disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
