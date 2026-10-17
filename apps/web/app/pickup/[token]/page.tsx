import type { Metadata } from 'next';
import { PickupBoard } from '@/components/public/pickup-board';

export const metadata: Metadata = { title: 'Order pickup', robots: { index: false } };

export default async function PickupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PickupBoard token={token} />;
}
