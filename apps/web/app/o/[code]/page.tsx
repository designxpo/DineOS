import type { Metadata } from 'next';
import { TrackOrder } from '@/components/public/track-order';

export const metadata: Metadata = { title: 'Your order', robots: { index: false } };

export default async function TrackPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <TrackOrder code={code} />;
}
