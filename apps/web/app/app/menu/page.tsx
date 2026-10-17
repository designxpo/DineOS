'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Clock, Download, ImageOff, ImagePlus, Pencil, Plus, Trash2, Upload, UtensilsCrossed } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { rupeesToPaise } from '@mezmitra/shared/money';
import type { MenuCategoryDTO, MenuDTO, MenuItemDTO, ModifierGroupDTO } from '@mezmitra/shared/dto';
import { API_URL, apiBlobUrl, errorMessage } from '@/lib/api';
import { formatPrice, formatRate, rupeesInput } from '@/lib/format';
import { resizeImage } from '@/lib/image';
import { useStaffMenu } from '@/lib/menu-cache';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { ConfirmDialog, Sheet } from '@/components/ui/overlay';
import { Badge, Card, EmptyState, Field, Input, Segmented, Select, Spinner, Switch, Textarea, VegMark } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { ScreensStatus } from '@/components/staff/screens-status';
import { PageHeader } from '@/components/staff/shell';

type Tab = 'items' | 'modifiers' | 'import';

export default function MenuPage() {
  const { can } = useStaff();
  const menu = useStaffMenu();
  const manage = can('menu.manage');
  const [tab, setTab] = useState<Tab>('items');

  return (
    <div className="pb-12">
      <PageHeader
        title="Menu"
        subtitle={manage ? 'Changes reach every guest phone within seconds' : 'Mark dishes sold out or back in stock'}
        actions={manage ? <Segmented value={tab} onChange={setTab} options={[{ value: 'items', label: 'Dishes' }, { value: 'modifiers', label: 'Options & add-ons' }, { value: 'import', label: 'Import' }]} /> : undefined}
      />
      <div className="px-4 lg:px-8">
        <ScreensStatus className="mb-4 max-w-3xl" />
      </div>
      {!menu.data ? (
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      ) : tab === 'items' ? (
        <ItemsTab menu={menu.data} manage={manage} />
      ) : tab === 'modifiers' ? (
        <ModifiersTab menu={menu.data} />
      ) : (
        <ImportTab />
      )}
    </div>
  );
}

function useMenuMutation() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['menu'] });
      if (done) toast(done);
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  };
}

function ItemsTab({ menu, manage }: { menu: MenuDTO; manage: boolean }) {
  const { api } = useStaff();
  const mutate = useMenuMutation();
  const [catId, setCatId] = useState<string | null>(menu.categories[0]?.id ?? null);
  const [editing, setEditing] = useState<MenuItemDTO | 'new' | null>(null);
  const [editingCat, setEditingCat] = useState<MenuCategoryDTO | 'new' | null>(null);
  const [query, setQuery] = useState('');
  const cat = menu.categories.find((c) => c.id === catId) ?? menu.categories[0];
  const items = menu.items.filter((i) => (query ? i.name.toLowerCase().includes(query.toLowerCase()) : i.category_id === cat?.id));

  return (
    <div className="grid gap-4 px-4 lg:grid-cols-[260px_1fr] lg:px-8">
      <Card className="h-fit p-2">
        <ul>
          {menu.categories.map((c) => {
            const n = menu.items.filter((i) => i.category_id === c.id).length;
            const out = menu.items.filter((i) => i.category_id === c.id && !i.in_stock).length;
            return (
              <li key={c.id} className="group flex items-center">
                <button
                  onClick={() => {
                    setCatId(c.id);
                    setQuery('');
                  }}
                  className={cn('flex h-11 flex-1 cursor-pointer items-center gap-2 rounded-xl px-3 text-left text-sm', cat?.id === c.id && !query ? 'bg-brand-50 font-semibold text-brand-700' : 'hover:bg-stone-50')}
                >
                  <span className={cn('flex-1 truncate', !c.is_active && 'text-ink-faint line-through')}>{c.name}</span>
                  {c.available_schedule && <Clock className="size-3.5 text-ink-faint" aria-label="Has a schedule" />}
                  {out > 0 && <span className="rounded-full bg-rose-100 px-1.5 text-[11px] font-semibold text-rose-700">{out} out</span>}
                  <span className="text-xs text-ink-faint tabular">{n}</span>
                </button>
                {manage && (
                  <IconButton label={`Edit ${c.name}`} className="size-9 opacity-60 group-hover:opacity-100" onClick={() => setEditingCat(c)}>
                    <Pencil className="size-3.5" />
                  </IconButton>
                )}
              </li>
            );
          })}
        </ul>
        {manage && (
          <Button variant="ghost" block className="mt-1 justify-start" onClick={() => setEditingCat('new')}>
            <Plus className="size-4" /> Add category
          </Button>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all dishes" className="h-10 max-w-xs" aria-label="Search dishes" />
          {manage && cat && (
            <Button className="ml-auto" onClick={() => setEditing('new')}>
              <Plus className="size-4" /> Add dish
            </Button>
          )}
        </div>
        {items.length === 0 ? (
          <EmptyState icon={<UtensilsCrossed className="size-5" />} title="No dishes here yet" hint={manage ? 'Add one, or import a spreadsheet.' : undefined} />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2.5">
                {i.photo_url ? <img src={i.photo_url} alt="" className="size-12 rounded-xl object-cover" /> : <div className="grid size-12 place-items-center rounded-xl bg-stone-100 text-ink-faint"><UtensilsCrossed className="size-4" /></div>}
                <div className="min-w-0 flex-1">
                  <p className={cn('flex items-start gap-2 font-medium leading-snug', !i.in_stock && 'text-ink-faint')}>
                    <VegMark veg={i.is_veg} className="mt-1 shrink-0" /> <span className="line-clamp-2">{i.name}</span>
                  </p>
                  <p className="text-xs text-ink-faint">
                    {formatPrice(i.price_paise)} · GST {formatRate(i.tax_rate_bp)} · {i.station}
                    {i.modifier_group_ids.length > 0 && ` · ${i.modifier_group_ids.length} option group${i.modifier_group_ids.length > 1 ? 's' : ''}`}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-xs text-ink-soft">
                  {i.in_stock ? <span className="hidden sm:inline">In stock</span> : <Badge tone="rose">Sold out</Badge>}
                  <Switch label={`${i.name} in stock`} checked={i.in_stock} onChange={(v) => void mutate(() => api(`/menu/items/${i.id}/stock`, { method: 'PATCH', body: { in_stock: v } }), v ? `${i.name} back in stock` : `${i.name} marked sold out`)} />
                </label>
                {manage && (
                  <IconButton label={`Edit ${i.name}`} onClick={() => setEditing(i)}>
                    <Pencil className="size-4" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && <ItemEditor menu={menu} item={editing === 'new' ? null : editing} categoryId={cat?.id ?? ''} onClose={() => setEditing(null)} />}
      {editingCat && <CategoryEditor category={editingCat === 'new' ? null : editingCat} onClose={() => setEditingCat(null)} onCreated={setCatId} />}
    </div>
  );
}

function CategoryEditor({ category, onClose, onCreated }: { category: MenuCategoryDTO | null; onClose: () => void; onCreated: (id: string) => void }) {
  const { api, outletId } = useStaff();
  const mutate = useMenuMutation();
  const [name, setName] = useState(category?.name ?? '');
  const [hi, setHi] = useState(category?.translations.hi?.name ?? '');
  const [active, setActive] = useState(category?.is_active ?? true);
  const [timed, setTimed] = useState(!!category?.available_schedule?.from);
  const [from, setFrom] = useState(category?.available_schedule?.from ?? '07:00');
  const [to, setTo] = useState(category?.available_schedule?.to ?? '11:00');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    const body = { name, is_active: active, available_schedule: timed ? { from, to } : null, translations: hi ? { hi: { name: hi } } : {} };
    const ok = await mutate(async () => {
      if (category) await api(`/menu/categories/${category.id}`, { method: 'PATCH', body });
      else onCreated((await api<MenuCategoryDTO>('/menu/categories', { method: 'POST', body: { ...body, outlet_id: outletId, sort: 99 } })).id);
    }, 'Category saved');
    if (ok) onClose();
  };

  return (
    <Sheet open onClose={onClose} title={category ? 'Edit category' : 'New category'} footer={<Button block onClick={() => void save()} disabled={!name.trim()}>Save</Button>}>
      <div className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Name in Hindi" hint="Shown to guests who switch to Hindi">{(id) => <Input id={id} value={hi} onChange={(e) => setHi(e.target.value)} lang="hi" />}</Field>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Show on the menu</span>
          <Switch label="Show on the menu" checked={active} onChange={setActive} />
        </div>
        <div className="rounded-2xl bg-stone-50 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Only at certain times</span>
            <Switch label="Only at certain times" checked={timed} onChange={setTimed} />
          </div>
          {timed && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="From">{(id) => <Input id={id} type="time" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
              <Field label="Until">{(id) => <Input id={id} type="time" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
            </div>
          )}
        </div>
        {category && (
          <Button variant="ghost" className="text-rose-700" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="size-4" /> Delete category
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${category?.name}?`}
        description="Its dishes leave the menu too. Past orders and bills keep their names and prices."
        confirmLabel="Delete"
        onConfirm={() => void mutate(() => api(`/menu/categories/${category!.id}`, { method: 'DELETE' }), 'Category deleted').then((ok) => ok && onClose())}
      />
    </Sheet>
  );
}

const TAX_RATES = [0, 500, 1200, 1800, 2800];

function ItemEditor({ menu, item, categoryId, onClose }: { menu: MenuDTO; item: MenuItemDTO | null; categoryId: string; onClose: () => void }) {
  const { api, outletId, outlet, token } = useStaff();
  const mutate = useMenuMutation();
  const toast = useToast();
  const [form, setForm] = useState({
    name: item?.name ?? '',
    hi: item?.translations.hi?.name ?? '',
    description: item?.description ?? '',
    price: item ? rupeesInput(item.price_paise) : '',
    is_veg: item?.is_veg ?? true,
    tax_rate_bp: item?.tax_rate_bp ?? outlet?.default_tax_rate_bp ?? 500,
    hsn_sac: item?.hsn_sac ?? '996331',
    station: item?.station ?? outlet?.kitchen_stations[0] ?? 'kitchen',
    tags: item?.tags.join(', ') ?? '',
    short_code: item?.short_code ?? '',
    category_id: item?.category_id ?? categoryId,
    groups: item?.modifier_group_ids ?? [],
  });
  const [photo, setPhoto] = useState<string | null>(item?.photo_url ?? null);
  // A photo picked before a new dish is saved: it uploads once the dish exists.
  const [pendingPhoto, setPendingPhoto] = useState<Blob | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    let price: number;
    try {
      price = rupeesToPaise(form.price);
    } catch {
      return toast('Enter a price like 250 or 249.50', 'error');
    }
    const body = {
      name: form.name,
      description: form.description || null,
      price_paise: price,
      is_veg: form.is_veg,
      tax_rate_bp: form.tax_rate_bp,
      hsn_sac: form.hsn_sac || null,
      station: form.station,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      short_code: form.short_code.trim() || null,
      category_id: form.category_id,
      modifier_group_ids: form.groups,
      translations: form.hi ? { hi: { name: form.hi } } : {},
    };
    const result = { photoError: null as string | null };
    const ok = await mutate(async () => {
      if (item) return api(`/menu/items/${item.id}`, { method: 'PATCH', body });
      const created = await api<{ id: string }>('/menu/items', { method: 'POST', body: { ...body, outlet_id: outletId } });
      // The dish is saved either way; a failed photo must not lead to saving it twice.
      if (pendingPhoto) await sendPhoto(created.id, pendingPhoto).catch((err: Error) => (result.photoError = err.message));
    }, 'Dish saved');
    if (ok && result.photoError) toast(`The photo did not upload (${result.photoError}). Open the dish to add it again.`, 'error');
    if (ok) onClose();
  };

  const sendPhoto = async (itemId: string, blob: Blob): Promise<string> => {
    const fd = new FormData();
    fd.append('file', blob, 'photo.jpg');
    const res = await fetch(`${API_URL}/v1/menu/items/${itemId}/photo`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
    if (!res.ok) throw new Error((await res.json()).error?.message ?? 'Upload failed');
    return (await res.json()).photo_url;
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const blob = await resizeImage(file);
      if (!item) {
        setPendingPhoto(blob);
        setPhoto(URL.createObjectURL(blob));
        return;
      }
      setPhoto(await sendPhoto(item.id, blob));
      await mutate(async () => {});
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setUploading(false);
    }
  };

  const removePhoto = async () => {
    if (!item) {
      setPendingPhoto(null);
      setPhoto(null);
      return;
    }
    if (await mutate(() => api(`/menu/items/${item.id}/photo`, { method: 'DELETE' }), 'Photo removed')) setPhoto(null);
  };

  return (
    <Sheet open wide onClose={onClose} title={item ? 'Edit dish' : 'New dish'} footer={<Button block size="lg" onClick={() => void save()} disabled={!form.name.trim() || !form.price}>Save dish</Button>}>
      <div className="grid gap-5 sm:grid-cols-[1fr_200px]">
        <div className="space-y-4">
          <Field label="Name">{(id) => <Input id={id} value={form.name} onChange={(e) => set('name', e.target.value)} />}</Field>
          <Field label="Name in Hindi">{(id) => <Input id={id} value={form.hi} onChange={(e) => set('hi', e.target.value)} lang="hi" />}</Field>
          <Field label="Description">{(id) => <Textarea id={id} value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={500} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Price (₹)" hint={outlet?.prices_include_tax ? 'Including GST' : 'Before GST'}>{(id) => <Input id={id} value={form.price} onChange={(e) => set('price', e.target.value)} inputMode="decimal" />}</Field>
            <Field label="GST rate">
              {(id) => (
                <Select id={id} value={form.tax_rate_bp} onChange={(e) => set('tax_rate_bp', Number(e.target.value))}>
                  {TAX_RATES.map((r) => (
                    <option key={r} value={r}>
                      {formatRate(r)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Category">
              {(id) => (
                <Select id={id} value={form.category_id} onChange={(e) => set('category_id', e.target.value)}>
                  {menu.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Kitchen station">
              {(id) => (
                <Select id={id} value={form.station} onChange={(e) => set('station', e.target.value)}>
                  {(outlet?.kitchen_stations ?? ['kitchen']).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="HSN / SAC">{(id) => <Input id={id} value={form.hsn_sac} onChange={(e) => set('hsn_sac', e.target.value)} />}</Field>
            <Field label="Tags" hint="Comma separated, e.g. bestseller, spicy">{(id) => <Input id={id} value={form.tags} onChange={(e) => set('tags', e.target.value)} />}</Field>
            <Field label="Short code" hint="Typed at the till to find it fast, e.g. PT. Optional.">
              {(id) => <Input id={id} value={form.short_code} maxLength={8} onChange={(e) => set('short_code', e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())} />}
            </Field>
          </div>
          <div className="flex gap-2">
            {[true, false].map((v) => (
              <button key={String(v)} onClick={() => set('is_veg', v)} className={cn('flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border text-sm font-medium', form.is_veg === v ? (v ? 'border-veg bg-emerald-50' : 'border-nonveg bg-orange-50') : 'border-line')}>
                <VegMark veg={v} /> {v ? 'Vegetarian' : 'Non-vegetarian'}
              </button>
            ))}
          </div>
          {menu.modifier_groups.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium">Options & add-ons</p>
              <div className="flex flex-wrap gap-2">
                {menu.modifier_groups.map((g) => {
                  const on = form.groups.includes(g.id);
                  return (
                    <button key={g.id} onClick={() => set('groups', on ? form.groups.filter((x) => x !== g.id) : [...form.groups, g.id])} className={cn('h-9 cursor-pointer rounded-full border px-3 text-sm', on ? 'border-[var(--brand)] bg-brand-50 font-medium text-brand-700' : 'border-line')}>
                      {g.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Photo</p>
          <label className="relative grid aspect-square cursor-pointer place-items-center overflow-hidden rounded-2xl border-2 border-dashed border-line bg-stone-50 text-ink-faint hover:bg-stone-100">
            {photo ? <img src={photo} alt="" className="absolute inset-0 size-full object-cover" /> : <ImagePlus className="size-7" />}
            {uploading && <span className="absolute inset-0 grid place-items-center bg-white/70"><Spinner /></span>}
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          </label>
          <p className="mt-2 text-xs text-ink-faint">{item ? 'Square photos look best. We resize before uploading.' : 'Square photos look best. It uploads when you save the dish.'}</p>
          {photo && (
            <Button variant="ghost" className="mt-2" onClick={() => void removePhoto()} disabled={uploading}>
              <ImageOff className="size-4" /> Remove photo
            </Button>
          )}
          {item && (
            <Button variant="ghost" className="mt-4 text-rose-700" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-4" /> Delete dish
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${item?.name}?`}
        description="It leaves the menu. Past orders and bills keep it."
        confirmLabel="Delete"
        onConfirm={() => void mutate(() => api(`/menu/items/${item!.id}`, { method: 'DELETE' }), 'Dish deleted').then((ok) => ok && onClose())}
      />
    </Sheet>
  );
}

function ModifiersTab({ menu }: { menu: MenuDTO }) {
  const [editing, setEditing] = useState<ModifierGroupDTO | 'new' | null>(null);
  return (
    <div className="px-4 lg:px-8">
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setEditing('new')}>
          <Plus className="size-4" /> Add option group
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {menu.modifier_groups.map((g) => (
          <Card key={g.id} className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-semibold">{g.name}</p>
                <p className="text-xs text-ink-faint">
                  {g.min_select > 0 ? `Required, pick ${g.min_select === g.max_select ? g.min_select : `${g.min_select}–${g.max_select}`}` : `Optional, up to ${g.max_select}`} · used by {menu.items.filter((i) => i.modifier_group_ids.includes(g.id)).length} dishes
                </p>
              </div>
              <IconButton label={`Edit ${g.name}`} onClick={() => setEditing(g)}>
                <Pencil className="size-4" />
              </IconButton>
            </div>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {g.modifiers.map((m) => (
                <li key={m.id} className={cn('rounded-lg bg-stone-100 px-2 py-1 text-xs', !m.in_stock && 'text-ink-faint line-through')}>
                  {m.name}
                  {m.price_delta_paise ? ` +${formatPrice(m.price_delta_paise)}` : ''}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      {editing && <GroupEditor group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function GroupEditor({ group, onClose }: { group: ModifierGroupDTO | null; onClose: () => void }) {
  const { api, outletId } = useStaff();
  const mutate = useMenuMutation();
  const [name, setName] = useState(group?.name ?? '');
  const [min, setMin] = useState(group?.min_select ?? 0);
  const [max, setMax] = useState(group?.max_select ?? 1);
  const [mods, setMods] = useState(
    group?.modifiers.map((m) => ({ id: m.id as string | undefined, name: m.name, price: rupeesInput(m.price_delta_paise), in_stock: m.in_stock, is_veg: m.is_veg })) ?? [{ id: undefined, name: '', price: '0', in_stock: true, is_veg: true }],
  );
  const save = async () => {
    const body = {
      name,
      min_select: min,
      max_select: Math.max(max, min, 1),
      modifiers: mods.filter((m) => m.name.trim()).map((m) => ({ id: m.id, name: m.name.trim(), price_delta_paise: rupeesToPaise(m.price || '0'), in_stock: m.in_stock, is_veg: m.is_veg })),
    };
    const ok = await mutate(() => (group ? api(`/menu/modifier-groups/${group.id}`, { method: 'PATCH', body }) : api('/menu/modifier-groups', { method: 'POST', body: { ...body, outlet_id: outletId } })), 'Options saved');
    if (ok) onClose();
  };
  return (
    <Sheet open onClose={onClose} title={group ? 'Edit option group' : 'New option group'} footer={<Button block onClick={() => void save()} disabled={!name.trim()}>Save</Button>}>
      <div className="space-y-4">
        <Field label="Name" hint="e.g. Size, Spice level, Add-ons">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Guests must pick at least">{(id) => <Input id={id} type="number" min={0} value={min} onChange={(e) => setMin(Number(e.target.value))} />}</Field>
          <Field label="And at most">{(id) => <Input id={id} type="number" min={1} value={max} onChange={(e) => setMax(Number(e.target.value))} />}</Field>
        </div>
        <div className="space-y-2">
          {mods.map((m, i) => (
            <div key={m.id ?? `new-${i}`} className="flex items-center gap-2">
              <Input value={m.name} onChange={(e) => setMods(mods.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Option" aria-label="Option name" />
              <Input value={m.price} onChange={(e) => setMods(mods.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} className="w-24" inputMode="decimal" aria-label="Extra price in rupees" />
              <Switch label="In stock" checked={m.in_stock} onChange={(v) => setMods(mods.map((x, j) => (j === i ? { ...x, in_stock: v } : x)))} />
              <IconButton label="Remove option" onClick={() => setMods(mods.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
          <Button variant="ghost" onClick={() => setMods([...mods, { id: undefined, name: '', price: '0', in_stock: true, is_veg: true }])}>
            <Plus className="size-4" /> Add option
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

interface ImportResult {
  dry_run: boolean;
  categories_created: number;
  items_created: number;
  items_updated: number;
  errors: { row: number; message: string }[];
}

function ImportTab() {
  const { token, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const res = await fetch(`${API_URL}/v1/menu/import?outlet_id=${outletId}&dry_run=${dryRun ? 1 : 0}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? 'Import failed');
      setPreview(body);
      if (!dryRun && body.errors.length === 0) {
        toast(`Imported: ${body.items_created} new, ${body.items_updated} updated`);
        await qc.invalidateQueries({ queryKey: ['menu'] });
        setFile(null);
        setPreview(null);
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = async () => {
    const url = await apiBlobUrl('/menu/import/template.csv', token);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'menu-template.csv';
    a.click();
  };

  useEffect(() => setPreview(null), [file]);
  const columns = useMemo(() => ['category', 'name', 'price', 'veg', 'description', 'tax_rate', 'hsn_sac', 'station', 'tags', 'in_stock', 'name_hi'], []);

  return (
    <div className="max-w-2xl px-4 lg:px-8">
      <Card className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Import from a spreadsheet</h2>
          <p className="mt-1 text-sm text-ink-soft">CSV or Excel. One row per dish. Matching dishes (same category and name) are updated, so you can re-import to change prices.</p>
          <p className="mt-2 text-xs text-ink-faint">Columns: {columns.join(', ')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void downloadTemplate()}>
            <Download className="size-4" /> Template
          </Button>
          <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-line px-4 text-sm font-medium hover:bg-stone-50">
            <Upload className="size-4" /> {file ? file.name : 'Choose file'}
            <input type="file" accept=".csv,.xlsx" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <Button disabled={!file} loading={busy && !preview} onClick={() => void run(true)}>
            Check file
          </Button>
        </div>
        {preview && (
          <div className="rounded-2xl bg-stone-50 p-4 text-sm">
            {preview.errors.length ? (
              <>
                <p className="font-semibold text-rose-800">Fix these rows and try again. Nothing was imported.</p>
                <ul className="mt-2 max-h-60 space-y-1 overflow-y-auto">
                  {preview.errors.map((e) => (
                    <li key={e.row}>
                      Row {e.row}: {e.message}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <p>
                  Ready: <b>{preview.items_created}</b> new dishes, <b>{preview.items_updated}</b> updated, <b>{preview.categories_created}</b> new categories.
                </p>
                <Button className="mt-3" loading={busy} onClick={() => void run(false)}>
                  Import now
                </Button>
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
