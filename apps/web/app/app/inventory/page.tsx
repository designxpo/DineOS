'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ClipboardCheck, Package, Plus, Search, Trash2, Truck, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { INGREDIENT_UNITS, type IngredientDTO, type IngredientUnit, type MenuItemDTO, type RecipeLineDTO, type RecipesDTO, type StockMovementDTO, type StockMovementType } from '@mezmitra/shared/dto';
import { errorMessage } from '@/lib/api';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { dateTime, formatPaise, todayIst } from '@/lib/format';
import { useStaffMenu } from '@/lib/menu-cache';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { Badge, Card, EmptyState, Field, Input, Segmented, Select, Spinner, Stat, Switch } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { Forbidden, PageHeader } from '@/components/staff/shell';

type Tab = 'stock' | 'recipes' | 'history' | 'usage';
type EntryType = 'purchase' | 'wastage' | 'count' | 'adjust';

/** Grams and millilitres are priced per kilo and litre, the way suppliers quote them. */
const PRICE_UNIT: Record<IngredientUnit, { label: string; factor: number }> = {
  g: { label: 'kg', factor: 1000 },
  kg: { label: 'kg', factor: 1 },
  ml: { label: 'l', factor: 1000 },
  l: { label: 'l', factor: 1 },
  pcs: { label: 'pc', factor: 1 },
};
const qtyFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });
const qty = (n: number, unit: string) => `${qtyFmt.format(n)} ${unit}`;
const unitPrice = (paisePerUnit: number, unit: IngredientUnit) => `${formatPaise(Math.round(paisePerUnit * PRICE_UNIT[unit].factor))}/${PRICE_UNIT[unit].label}`;
const TYPE_LABEL: Record<StockMovementType, I18nKey> = {
  purchase: 'inv.type_purchase',
  sale: 'inv.type_sale',
  return: 'inv.type_return',
  wastage: 'inv.type_wastage',
  adjust: 'inv.type_adjust',
  count: 'inv.type_count',
};
const TYPE_TONE: Record<StockMovementType, 'green' | 'neutral' | 'blue' | 'rose' | 'amber' | 'violet'> = { purchase: 'green', sale: 'neutral', return: 'blue', wastage: 'rose', adjust: 'amber', count: 'violet' };

function useIngredients() {
  const { api, outletId } = useStaff();
  return useQuery({ queryKey: ['inventory', outletId, 'ingredients'], queryFn: () => api<IngredientDTO[]>(`/inventory/ingredients?outlet_id=${outletId}`) });
}

export default function InventoryPage() {
  const { can } = useStaff();
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('stock');
  if (!can('inventory.record')) return <Forbidden />;
  return (
    <div className="pb-12">
      <PageHeader title={t('inv.title')} subtitle={t('inv.subtitle')} />
      <div className="px-4 pb-4 lg:px-8">
        <Segmented
          value={tab}
          onChange={setTab}
          className="max-w-full overflow-x-auto"
          options={[
            { value: 'stock', label: t('inv.tab_stock') },
            { value: 'recipes', label: t('inv.tab_recipes') },
            { value: 'history', label: t('inv.tab_history') },
            ...(can('report.view') ? [{ value: 'usage' as Tab, label: t('inv.tab_usage') }] : []),
          ]}
        />
      </div>
      <div className="px-4 lg:px-8">
        {tab === 'stock' && <StockTab />}
        {tab === 'recipes' && <RecipesTab />}
        {tab === 'history' && <HistoryTab />}
        {tab === 'usage' && <UsageTab />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- stock

function StockTab() {
  const { can } = useStaff();
  const { t } = useI18n();
  const { data, isLoading } = useIngredients();
  const [entry, setEntry] = useState<EntryType | null>(null);
  const [editing, setEditing] = useState<IngredientDTO | 'new' | null>(null);
  const low = (data ?? []).filter((i) => i.low);
  const manage = can('inventory.manage');

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        {manage && (
          <Button onClick={() => setEntry('purchase')}>
            <Truck className="size-4" /> {t('inv.receive')}
          </Button>
        )}
        <Button variant="outline" onClick={() => setEntry('wastage')}>
          <Trash2 className="size-4" /> {t('inv.wastage')}
        </Button>
        <Button variant="outline" onClick={() => setEntry('count')}>
          <ClipboardCheck className="size-4" /> {t('inv.count')}
        </Button>
        {manage && (
          <Button variant="ghost" className="sm:ml-auto" onClick={() => setEditing('new')}>
            <Plus className="size-4" /> {t('inv.new_ingredient')}
          </Button>
        )}
      </div>
      {low.length > 0 && (
        <p className="mb-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold">{t('inv.reorder_soon')}</span> {low.map((i) => i.name).join(', ')}
          </span>
        </p>
      )}
      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : !data?.length ? (
          <EmptyState
            icon={<Package className="size-5" />}
            title={t('inv.empty')}
            hint={t('inv.empty_hint')}
            action={manage && <Button onClick={() => setEditing('new')}>{t('inv.add_first')}</Button>}
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-stone-50 text-left text-xs tracking-wide text-ink-faint uppercase">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t('inv.col_ingredient')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('inv.col_stock')}</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">{t('inv.col_reorder')}</th>
                <th className="hidden px-4 py-2.5 text-right font-medium md:table-cell">{t('inv.col_cost')}</th>
                <th className="hidden px-4 py-2.5 text-right font-medium md:table-cell">{t('inv.col_value')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.map((i) => (
                <tr key={i.id} onClick={() => setEditing(i)} className="cursor-pointer hover:bg-stone-50">
                  <td className="px-4 py-3">
                    <p className="flex items-center gap-2 font-medium">
                      {i.name}
                      {i.stock_qty <= 0 ? <Badge tone="rose">{t('inv.out')}</Badge> : i.low && <Badge tone="amber">{t('inv.low')}</Badge>}
                    </p>
                    <p className="text-xs text-ink-faint">{i.used_by ? (i.used_by === 1 ? t('inv.in_recipes_one') : t('inv.in_recipes', { n: i.used_by })) : t('inv.no_recipe')}</p>
                  </td>
                  <td className={cn('px-4 py-3 text-right font-semibold tabular', i.stock_qty <= 0 ? 'text-rose-700' : i.low && 'text-amber-800')}>{qty(i.stock_qty, i.unit)}</td>
                  <td className="hidden px-4 py-3 text-right text-ink-faint tabular sm:table-cell">{qty(i.reorder_level, i.unit)}</td>
                  <td className="hidden px-4 py-3 text-right text-ink-soft tabular md:table-cell">{unitPrice(i.cost_per_unit_paise, i.unit)}</td>
                  <td className="hidden px-4 py-3 text-right tabular md:table-cell">{formatPaise(Math.round(Math.max(i.stock_qty, 0) * i.cost_per_unit_paise))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {entry && data && <EntrySheet type={entry} ingredients={data} onClose={() => setEntry(null)} />}
      {editing && <IngredientSheet ingredient={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

interface EntryLine {
  key: number;
  ingredient_id: string;
  qty: string;
  price: string;
}

function EntrySheet({ type, ingredients, onClose }: { type: EntryType; ingredients: IngredientDTO[]; onClose: () => void }) {
  const { api, outletId } = useStaff();
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<EntryLine[]>([{ key: 0, ingredient_id: '', qty: '', price: '' }]);
  // A count lists every ingredient; only the ones typed in are sent.
  const [counts, setCounts] = useState<Record<string, string>>({});
  const byId = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);
  const title = t(({ purchase: 'inv.receive', wastage: 'inv.wastage', count: 'inv.count', adjust: 'inv.correct' } as const)[type]);

  const payload = () => {
    if (type === 'count') {
      return Object.entries(counts)
        .filter(([, v]) => v.trim() !== '' && Number.isFinite(Number(v)))
        .map(([ingredient_id, v]) => ({ ingredient_id, qty: Number(v) }));
    }
    return lines
      .filter((l) => l.ingredient_id && Number(l.qty))
      .map((l) => {
        const ing = byId.get(l.ingredient_id)!;
        const price = Number(l.price);
        return {
          ingredient_id: l.ingredient_id,
          qty: Number(l.qty),
          ...(type === 'purchase' && l.price.trim() && price >= 0 ? { unit_cost_paise: (price * 100) / PRICE_UNIT[ing.unit].factor } : {}),
        };
      });
  };
  const ready = payload().length > 0 && (type !== 'adjust' || note.trim().length > 2);

  const save = async () => {
    setBusy(true);
    try {
      await api('/inventory/movements', { method: 'POST', body: { outlet_id: outletId, type, supplier: supplier.trim() || null, note: note.trim() || null, lines: payload() } });
      await qc.invalidateQueries({ queryKey: ['inventory'] });
      toast(type === 'purchase' ? t('inv.received') : type === 'count' ? t('inv.count_saved') : t('inv.saved'));
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const used = new Set(lines.map((l) => l.ingredient_id));
  return (
    <Sheet open onClose={onClose} title={title} wide footer={<Button block onClick={save} loading={busy} disabled={!ready}>{t('inv.save')}</Button>}>
      {type === 'count' ? (
        <div className="space-y-1">
          <p className="mb-3 text-sm text-ink-soft">{t('inv.count_hint')}</p>
          {ingredients.map((i) => (
            <div key={i.id} className="flex items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-stone-50">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{i.name}</span>
              <span className="w-24 text-right text-xs text-ink-faint tabular">{t('inv.now', { qty: qty(i.stock_qty, i.unit) })}</span>
              <Input
                value={counts[i.id] ?? ''}
                onChange={(e) => setCounts({ ...counts, [i.id]: e.target.value })}
                inputMode="decimal"
                className="h-9 w-28 text-right"
                aria-label={t('inv.counted_aria', { name: i.name, unit: i.unit })}
                placeholder={i.unit}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {type === 'purchase' && <Field label={t('inv.supplier')}>{(id) => <Input id={id} value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder={t('inv.supplier_hint')} />}</Field>}
          <div className="space-y-2">
            {lines.map((l, idx) => {
              const ing = byId.get(l.ingredient_id);
              return (
                <div key={l.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-2 sm:flex-nowrap">
                  <Select
                    value={l.ingredient_id}
                    onChange={(e) => setLines(lines.map((x, j) => (j === idx ? { ...x, ingredient_id: e.target.value } : x)))}
                    className="h-10 min-w-0 flex-1 basis-[calc(100%-3.25rem)] sm:basis-auto"
                    aria-label={t('inv.col_ingredient')}
                  >
                    <option value="">{t('inv.pick')}</option>
                    {ingredients.map((i) => (
                      <option key={i.id} value={i.id} disabled={used.has(i.id) && i.id !== l.ingredient_id}>
                        {i.name} ({i.unit})
                      </option>
                    ))}
                  </Select>
                  <div className="order-2 flex items-center gap-1 sm:order-none">
                    <Input
                      value={l.qty}
                      onChange={(e) => setLines(lines.map((x, j) => (j === idx ? { ...x, qty: e.target.value } : x)))}
                      inputMode="decimal"
                      className="h-10 w-24 text-right"
                      aria-label={t('inv.quantity')}
                      placeholder={type === 'adjust' ? '±' : t('inv.qty')}
                    />
                    <span className="w-8 text-xs text-ink-faint">{ing?.unit}</span>
                  </div>
                  {type === 'purchase' && (
                    <div className="order-2 flex items-center gap-1 sm:order-none">
                      <span className="text-xs text-ink-faint">₹</span>
                      <Input
                        value={l.price}
                        onChange={(e) => setLines(lines.map((x, j) => (j === idx ? { ...x, price: e.target.value } : x)))}
                        inputMode="decimal"
                        className="h-10 w-24 text-right"
                        aria-label={t('inv.price')}
                        placeholder={t('inv.price')}
                      />
                      <span className="w-8 text-xs text-ink-faint">{ing ? `/${PRICE_UNIT[ing.unit].label}` : ''}</span>
                    </div>
                  )}
                  <IconButton label={t('inv.remove_line')} className="order-1 sm:order-none" onClick={() => setLines(lines.filter((_, j) => j !== idx))} disabled={lines.length === 1}>
                    <X className="size-4" />
                  </IconButton>
                </div>
              );
            })}
            <Button variant="ghost" size="sm" onClick={() => setLines([...lines, { key: Date.now(), ingredient_id: '', qty: '', price: '' }])}>
              <Plus className="size-4" /> {t('inv.add_line')}
            </Button>
          </div>
          <Field label={type === 'adjust' ? t('inv.reason_required') : type === 'wastage' ? t('inv.reason') : t('inv.note')} hint={type === 'wastage' ? t('inv.wastage_hint') : undefined}>
            {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          {type === 'purchase' && <p className="text-xs text-ink-faint">{t('inv.avg_cost_hint')}</p>}
        </div>
      )}
    </Sheet>
  );
}

function IngredientSheet({ ingredient, onClose }: { ingredient: IngredientDTO | null; onClose: () => void }) {
  const { api, outletId, can } = useStaff();
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const manage = can('inventory.manage');
  const [name, setName] = useState(ingredient?.name ?? '');
  const [unit, setUnit] = useState<IngredientUnit>(ingredient?.unit ?? 'kg');
  const [reorder, setReorder] = useState(ingredient ? String(ingredient.reorder_level) : '');
  const [price, setPrice] = useState(ingredient ? String(Math.round(ingredient.cost_per_unit_paise * PRICE_UNIT[ingredient.unit].factor) / 100) : '');
  const [opening, setOpening] = useState('');
  const [active, setActive] = useState(ingredient?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const history = useQuery({
    queryKey: ['inventory', outletId, 'movements', ingredient?.id],
    enabled: !!ingredient,
    queryFn: () => api<StockMovementDTO[]>(`/inventory/movements?outlet_id=${outletId}&ingredient_id=${ingredient!.id}&limit=30`),
  });
  const unitLocked = !!ingredient && (ingredient.used_by > 0 || ingredient.stock_qty !== 0);

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        unit,
        reorder_level: Number(reorder) || 0,
        cost_per_unit_paise: ((Number(price) || 0) * 100) / PRICE_UNIT[unit].factor,
      };
      if (ingredient) await api(`/inventory/ingredients/${ingredient.id}`, { method: 'PATCH', body: { ...body, is_active: active } });
      else await api('/inventory/ingredients', { method: 'POST', body: { outlet_id: outletId, ...body, ...(Number(opening) > 0 ? { opening_qty: Number(opening) } : {}) } });
      await qc.invalidateQueries({ queryKey: ['inventory'] });
      toast(ingredient ? t('inv.saved') : t('inv.added', { name: body.name }));
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={ingredient ? ingredient.name : t('inv.new_ingredient')}
      wide={!!ingredient}
      footer={manage ? <Button block onClick={save} loading={busy} disabled={!name.trim()}>{t('inv.save')}</Button> : undefined}
    >
      <fieldset disabled={!manage} className="space-y-4">
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label={t('inv.name')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus={!ingredient} />}</Field>
          <Field label={t('inv.unit')}>
            {(id) => (
              <Select id={id} value={unit} onChange={(e) => setUnit(e.target.value as IngredientUnit)} disabled={unitLocked}>
                {INGREDIENT_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('inv.reorder_label', { unit })} hint={t('inv.reorder_hint')}>
            {(id) => <Input id={id} value={reorder} onChange={(e) => setReorder(e.target.value)} inputMode="decimal" />}
          </Field>
          <Field label={t('inv.price_label', { unit: PRICE_UNIT[unit].label })} hint={t('inv.price_hint')}>
            {(id) => <Input id={id} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />}
          </Field>
          {!ingredient && (
            <Field label={t('inv.opening', { unit })}>{(id) => <Input id={id} value={opening} onChange={(e) => setOpening(e.target.value)} inputMode="decimal" />}</Field>
          )}
        </div>
        {unitLocked && <p className="text-xs text-ink-faint">{t('inv.unit_locked')}</p>}
        {ingredient && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">{t('inv.active')}</span>
            <Switch checked={active} onChange={setActive} label={t('inv.active')} disabled={!manage} />
          </div>
        )}
      </fieldset>
      {ingredient && (
        <div className="mt-5">
          <p className="mb-2 text-xs font-medium tracking-wide text-ink-faint uppercase">{t('inv.recent')}</p>
          <MovementList rows={history.data} loading={history.isLoading} compact />
        </div>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- recipes

function RecipesTab() {
  const { api, outletId, can } = useStaff();
  const menu = useStaffMenu();
  const ingredients = useIngredients();
  const recipes = useQuery({ queryKey: ['inventory', outletId, 'recipes'], queryFn: () => api<RecipesDTO>(`/inventory/recipes?outlet_id=${outletId}`) });
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<MenuItemDTO | null>(null);
  const byId = useMemo(() => new Map((ingredients.data ?? []).map((i) => [i.id, i])), [ingredients.data]);
  const cost = (lines: RecipeLineDTO[] = []) => lines.reduce((a, l) => a + l.qty * (byId.get(l.ingredient_id)?.cost_per_unit_paise ?? 0), 0);

  if (menu.isLoading || ingredients.isLoading || recipes.isLoading) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  }
  if (!ingredients.data?.length) return <EmptyState icon={<Package className="size-5" />} title="Add ingredients first" hint="Recipes say how much of each ingredient one portion uses." />;

  const term = q.trim().toLowerCase();
  const items = (menu.data?.items ?? []).filter((i) => !term || i.name.toLowerCase().includes(term));
  const withRecipe = (menu.data?.items ?? []).filter((i) => recipes.data?.items[i.id]?.length).length;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a dish" className="pl-10" aria-label="Find a dish" />
        </div>
        <p className="text-sm text-ink-faint">
          {withRecipe} of {menu.data?.items.length ?? 0} dishes have a recipe
        </p>
      </div>
      <Card className="overflow-hidden">
        {(menu.data?.categories ?? []).map((cat) => {
          const list = items.filter((i) => i.category_id === cat.id);
          if (!list.length) return null;
          return (
            <section key={cat.id}>
              <h3 className="border-y border-line bg-stone-50 px-4 py-2 text-xs font-semibold tracking-wide text-ink-faint uppercase first:border-t-0">{cat.name}</h3>
              <ul className="divide-y divide-line">
                {list.map((item) => {
                  const lines = recipes.data?.items[item.id] ?? [];
                  const c = cost(lines);
                  const pct = item.price_paise ? (c / item.price_paise) * 100 : 0;
                  return (
                    <li key={item.id}>
                      <button className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-stone-50" onClick={() => setOpen(item)} disabled={!can('inventory.manage') && !lines.length}>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{item.name}</p>
                          <p className="truncate text-xs text-ink-faint">
                            {lines.length ? lines.map((l) => `${byId.get(l.ingredient_id)?.name ?? '?'} ${qty(l.qty, byId.get(l.ingredient_id)?.unit ?? '')}`).join(' · ') : 'No recipe: sales do not use stock'}
                          </p>
                        </div>
                        {lines.length > 0 && (
                          <div className="text-right">
                            <p className="text-sm tabular">{formatPaise(Math.round(c))}</p>
                            <p className={cn('text-xs font-medium tabular', pct > 40 ? 'text-rose-700' : pct > 30 ? 'text-amber-700' : 'text-emerald-700')}>{pct.toFixed(0)}% of price</p>
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </Card>
      {open && recipes.data && menu.data && (
        <RecipeSheet
          item={open}
          ingredients={ingredients.data}
          recipes={recipes.data}
          groups={menu.data.modifier_groups.filter((g) => open.modifier_group_ids.includes(g.id))}
          readOnly={!can('inventory.manage')}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function RecipeLines({ lines, onChange, ingredients, readOnly }: { lines: RecipeLineDTO[]; onChange: (l: RecipeLineDTO[]) => void; ingredients: IngredientDTO[]; readOnly: boolean }) {
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const used = new Set(lines.map((l) => l.ingredient_id));
  return (
    <div className="space-y-2">
      {lines.map((l, idx) => (
        <div key={`${l.ingredient_id}-${idx}`} className="flex items-center gap-2">
          <Select
            value={l.ingredient_id}
            disabled={readOnly}
            onChange={(e) => onChange(lines.map((x, j) => (j === idx ? { ...x, ingredient_id: e.target.value } : x)))}
            className="h-10 min-w-0 flex-1"
            aria-label="Ingredient"
          >
            <option value="">Pick ingredient…</option>
            {ingredients.map((i) => (
              <option key={i.id} value={i.id} disabled={used.has(i.id) && i.id !== l.ingredient_id}>
                {i.name}
              </option>
            ))}
          </Select>
          <Input
            value={Number.isNaN(l.qty) ? '' : String(l.qty)}
            disabled={readOnly}
            onChange={(e) => onChange(lines.map((x, j) => (j === idx ? { ...x, qty: e.target.value === '' ? Number.NaN : Number(e.target.value) } : x)))}
            inputMode="decimal"
            className="h-10 w-24 text-right"
            aria-label="Quantity per portion"
          />
          <span className="w-8 text-xs text-ink-faint">{byId.get(l.ingredient_id)?.unit}</span>
          {!readOnly && (
            <IconButton label="Remove ingredient" onClick={() => onChange(lines.filter((_, j) => j !== idx))}>
              <X className="size-4" />
            </IconButton>
          )}
        </div>
      ))}
      {!readOnly && (
        <Button variant="ghost" size="sm" onClick={() => onChange([...lines, { ingredient_id: '', qty: Number.NaN }])}>
          <Plus className="size-4" /> Ingredient
        </Button>
      )}
    </div>
  );
}

function RecipeSheet({
  item,
  ingredients,
  recipes,
  groups,
  readOnly,
  onClose,
}: {
  item: MenuItemDTO;
  ingredients: IngredientDTO[];
  recipes: RecipesDTO;
  groups: { id: string; name: string; modifiers: { id: string; name: string }[] }[];
  readOnly: boolean;
  onClose: () => void;
}) {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [lines, setLines] = useState<RecipeLineDTO[]>(recipes.items[item.id] ?? []);
  const [mods, setMods] = useState<Record<string, RecipeLineDTO[]>>(() => Object.fromEntries(groups.flatMap((g) => g.modifiers.map((m) => [m.id, recipes.modifiers[m.id] ?? []]))));
  const [busy, setBusy] = useState(false);
  const clean = (l: RecipeLineDTO[]) => l.filter((x) => x.ingredient_id && x.qty > 0);
  const valid = (l: RecipeLineDTO[]) => l.every((x) => !x.ingredient_id || (Number.isFinite(x.qty) && x.qty > 0));
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const c = clean(lines).reduce((a, l) => a + l.qty * (byId.get(l.ingredient_id)?.cost_per_unit_paise ?? 0), 0);

  const save = async () => {
    setBusy(true);
    try {
      await api(`/inventory/recipes/items/${item.id}`, { method: 'PUT', body: { lines: clean(lines) } });
      for (const [id, l] of Object.entries(mods)) {
        if (JSON.stringify(clean(l)) !== JSON.stringify(recipes.modifiers[id] ?? [])) {
          await api(`/inventory/recipes/modifiers/${id}`, { method: 'PUT', body: { lines: clean(l) } });
        }
      }
      await qc.invalidateQueries({ queryKey: ['inventory', outletId] });
      toast('Recipe saved');
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={item.name}
      wide
      footer={!readOnly && <Button block onClick={save} loading={busy} disabled={!valid(lines) || !Object.values(mods).every(valid)}>Save recipe</Button>}
    >
      <div className="space-y-5">
        <div>
          <p className="mb-1 text-sm font-medium">One portion uses</p>
          <p className="mb-3 text-xs text-ink-faint">
            Costs {formatPaise(Math.round(c))} to make at today&apos;s prices, {item.price_paise ? ((c / item.price_paise) * 100).toFixed(0) : 0}% of the {formatPaise(item.price_paise)} price.
          </p>
          <RecipeLines lines={lines} onChange={setLines} ingredients={ingredients} readOnly={readOnly} />
        </div>
        {groups.map((g) => (
          <div key={g.id} className="rounded-xl border border-line p-3">
            <p className="mb-2 text-sm font-medium">{g.name}</p>
            <p className="mb-3 text-xs text-ink-faint">Extra stock used when a guest picks an option. Shared by every dish with this choice.</p>
            <div className="space-y-3">
              {g.modifiers.map((m) => (
                <div key={m.id}>
                  <p className="mb-1.5 text-xs font-semibold text-ink-soft">{m.name}</p>
                  <RecipeLines lines={mods[m.id] ?? []} onChange={(l) => setMods({ ...mods, [m.id]: l })} ingredients={ingredients} readOnly={readOnly} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- history

function MovementList({ rows, loading, compact }: { rows: StockMovementDTO[] | undefined; loading: boolean; compact?: boolean }) {
  const { t } = useI18n();
  if (loading) {
    return (
      <div className="grid place-items-center py-10">
        <Spinner />
      </div>
    );
  }
  if (!rows?.length) return <p className="py-8 text-center text-sm text-ink-faint">{t('inv.nothing')}</p>;
  return (
    <ul className={cn('divide-y divide-line', compact && 'rounded-xl border border-line')}>
      {rows.map((m) => (
        <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2">
              {!compact && <span className="font-medium">{m.ingredient_name}</span>}
              <Badge tone={TYPE_TONE[m.type]}>{t(TYPE_LABEL[m.type])}</Badge>
            </p>
            <p className="truncate text-xs text-ink-faint">{[dateTime(m.created_at), m.created_by_name, m.supplier, m.note].filter(Boolean).join(' · ')}</p>
          </div>
          <div className="text-right">
            <p className={cn('font-semibold tabular', m.qty > 0 ? 'text-emerald-700' : m.qty < 0 ? 'text-ink' : 'text-ink-faint')}>
              {m.qty > 0 ? '+' : ''}
              {qty(m.qty, m.unit)}
            </p>
            {m.stock_after != null && <p className="text-xs text-ink-faint tabular">→ {qty(m.stock_after, m.unit)}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function HistoryTab() {
  const { api, outletId } = useStaff();
  const { t } = useI18n();
  const [type, setType] = useState<'all' | StockMovementType>('all');
  const { data, isLoading } = useQuery({
    queryKey: ['inventory', outletId, 'movements', 'all', type],
    queryFn: () => api<StockMovementDTO[]>(`/inventory/movements?outlet_id=${outletId}&limit=200${type === 'all' ? '' : `&type=${type}`}`),
  });
  return (
    <>
      <Segmented
        size="sm"
        className="mb-3 max-w-full overflow-x-auto"
        value={type}
        onChange={setType}
        options={[{ value: 'all' as const, label: t('inv.all') }, ...(['purchase', 'sale', 'wastage', 'count', 'adjust', 'return'] as const).map((ty) => ({ value: ty, label: t(TYPE_LABEL[ty]) }))]}
      />
      <Card className="overflow-hidden">
        <MovementList rows={data} loading={isLoading} />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- usage report

interface UsageReport {
  totals: { purchased_paise: number; cost_of_sales_paise: number; wastage_paise: number; stock_value_paise: number; net_sales_paise: number; food_cost_bp: number | null; low_count: number };
  ingredients: { ingredient_id: string; name: string; unit: string; purchased_qty: number; used_qty: number; used_paise: number; wasted_qty: number; wasted_paise: number; stock_qty: number; low: boolean }[];
  dishes: { item_id: string; name: string; price_paise: number; cost_paise: number; cost_bp: number | null }[];
}

const shift = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
};

function UsageTab() {
  const { api, outletId } = useStaff();
  const [days, setDays] = useState<'1' | '7' | '30'>('7');
  const to = todayIst();
  const from = shift(to, 1 - Number(days));
  const { data, isLoading } = useQuery({
    queryKey: ['inventory', outletId, 'report', from, to],
    queryFn: () => api<UsageReport>(`/reports/inventory?outlet_id=${outletId}&from=${from}&to=${to}`),
  });
  return (
    <div className="space-y-4">
      <Segmented
        value={days}
        onChange={setDays}
        options={[
          { value: '1', label: 'Today' },
          { value: '7', label: '7 days' },
          { value: '30', label: '30 days' },
        ]}
      />
      {isLoading || !data ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Food cost" value={data.totals.food_cost_bp == null ? '-' : `${(data.totals.food_cost_bp / 100).toFixed(1)}%`} sub={`${formatPaise(data.totals.cost_of_sales_paise)} on ${formatPaise(data.totals.net_sales_paise)} sales`} />
            <Stat label="Wasted" value={formatPaise(data.totals.wastage_paise)} />
            <Stat label="Received" value={formatPaise(data.totals.purchased_paise)} />
            <Stat label="Stock value now" value={formatPaise(data.totals.stock_value_paise)} sub={data.totals.low_count ? `${data.totals.low_count} to reorder` : undefined} />
          </div>
          <p className="text-xs text-ink-faint">Food cost counts only dishes that have a recipe. Usage is valued at the average price paid when it was used.</p>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b border-line bg-stone-50 text-left text-xs tracking-wide text-ink-faint uppercase">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Ingredient</th>
                  <th className="px-4 py-2.5 text-right font-medium">Received</th>
                  <th className="px-4 py-2.5 text-right font-medium">Used</th>
                  <th className="px-4 py-2.5 text-right font-medium">Wasted</th>
                  <th className="px-4 py-2.5 text-right font-medium">In stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.ingredients.map((i) => (
                  <tr key={i.ingredient_id}>
                    <td className="px-4 py-2.5 font-medium">{i.name}</td>
                    <td className="px-4 py-2.5 text-right tabular">{i.purchased_qty ? qty(i.purchased_qty, i.unit) : '-'}</td>
                    <td className="px-4 py-2.5 text-right tabular">
                      {i.used_qty ? qty(i.used_qty, i.unit) : '-'}
                      {i.used_paise > 0 && <span className="block text-xs text-ink-faint">{formatPaise(i.used_paise)}</span>}
                    </td>
                    <td className={cn('px-4 py-2.5 text-right tabular', i.wasted_qty > 0 && 'text-rose-700')}>
                      {i.wasted_qty ? qty(i.wasted_qty, i.unit) : '-'}
                      {i.wasted_paise > 0 && <span className="block text-xs">{formatPaise(i.wasted_paise)}</span>}
                    </td>
                    <td className={cn('px-4 py-2.5 text-right font-semibold tabular', i.low && 'text-amber-800')}>{qty(i.stock_qty, i.unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {data.dishes.length > 0 && (
            <Card className="overflow-hidden">
              <h3 className="border-b border-line px-4 py-3 text-sm font-semibold">Dish costs at today&apos;s prices</h3>
              <ul className="divide-y divide-line">
                {[...data.dishes]
                  .sort((a, b) => (b.cost_bp ?? 0) - (a.cost_bp ?? 0))
                  .map((d) => (
                    <li key={d.item_id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <span className="flex-1 font-medium">{d.name}</span>
                      <span className="text-ink-faint tabular">
                        {formatPaise(d.cost_paise)} / {formatPaise(d.price_paise)}
                      </span>
                      <span className={cn('w-14 text-right font-semibold tabular', (d.cost_bp ?? 0) > 4000 ? 'text-rose-700' : (d.cost_bp ?? 0) > 3000 ? 'text-amber-700' : 'text-emerald-700')}>
                        {d.cost_bp == null ? '-' : `${(d.cost_bp / 100).toFixed(0)}%`}
                      </span>
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
