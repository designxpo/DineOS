import type { TableState } from '@mezmitra/shared/enums';

export const TABLE_STATE: Record<TableState, { label: string; tile: string; dot: string }> = {
  vacant: { label: 'Vacant', tile: 'border-line bg-surface', dot: 'bg-state-vacant' },
  occupied: { label: 'Seated', tile: 'border-sky-300 bg-sky-50', dot: 'bg-state-occupied' },
  ordered: { label: 'Ordered', tile: 'border-amber-300 bg-amber-50', dot: 'bg-state-ordered' },
  served: { label: 'Served', tile: 'border-emerald-300 bg-emerald-50', dot: 'bg-state-served' },
  bill_requested: { label: 'Bill requested', tile: 'border-violet-300 bg-violet-50', dot: 'bg-state-bill' },
  needs_cleaning: { label: 'Needs cleaning', tile: 'border-rose-300 bg-rose-50', dot: 'bg-state-clean' },
};
