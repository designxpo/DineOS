import type { Metadata } from 'next';
import { GuestApp } from '@/components/guest/guest-app';

export const metadata: Metadata = { title: 'Menu', robots: { index: false } };

export default async function GuestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <GuestApp qr={token} />;
}
