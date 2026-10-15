import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names and lets later Tailwind utilities override earlier ones (w-24 beats w-full). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
