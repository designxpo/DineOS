import type {
  AvailabilitySchedule,
  MenuCategoryDTO,
  MenuDTO,
  MenuItemDTO,
  ModifierGroupDTO,
  Translations,
} from '@dineos/shared/dto';
import { isScheduleOpen } from '@dineos/shared/menu';
import type { Tx } from '../../context';
import { notFound } from '../../lib/errors';

/**
 * The outlet's menu. Staff see inactive categories; guests only see active ones (out-of-stock
 * items are still listed so the phone can show them greyed out).
 */
export async function loadMenu(tx: Tx, outletId: string, opts: { forGuest?: boolean; now?: Date } = {}): Promise<MenuDTO> {
  const outlet = await tx.db
    .selectFrom('outlets')
    .select(['id', 'timezone', 'menu_version'])
    .where('id', '=', outletId)
    .executeTakeFirst();
  if (!outlet) throw notFound('Outlet');
  const now = opts.now ?? new Date();

  let catQuery = tx.db
    .selectFrom('menu_categories')
    .selectAll()
    .where('outlet_id', '=', outletId)
    .where('deleted_at', 'is', null);
  if (opts.forGuest) catQuery = catQuery.where('is_active', '=', true);
  const categories = await catQuery.orderBy('sort').orderBy('name').execute();
  const catIds = categories.map((c) => c.id);

  const items = catIds.length
    ? await tx.db
        .selectFrom('menu_items')
        .selectAll()
        .where('outlet_id', '=', outletId)
        .where('category_id', 'in', catIds)
        .where('deleted_at', 'is', null)
        .orderBy('sort')
        .orderBy('name')
        .execute()
    : [];

  const groups = await tx.db
    .selectFrom('modifier_groups')
    .selectAll()
    .where('outlet_id', '=', outletId)
    .where('deleted_at', 'is', null)
    .orderBy('sort')
    .orderBy('name')
    .execute();
  const groupIds = groups.map((g) => g.id);
  const modifiers = groupIds.length
    ? await tx.db
        .selectFrom('modifiers')
        .selectAll()
        .where('group_id', 'in', groupIds)
        .where('deleted_at', 'is', null)
        .orderBy('sort')
        .orderBy('name')
        .execute()
    : [];
  const itemIds = items.map((i) => i.id);
  const links = itemIds.length
    ? await tx.db
        .selectFrom('item_modifier_groups')
        .select(['item_id', 'group_id'])
        .where('item_id', 'in', itemIds)
        .where('group_id', 'in', groupIds.length ? groupIds : ['00000000-0000-0000-0000-000000000000'])
        .orderBy('sort')
        .execute()
    : [];

  const categoriesDto: MenuCategoryDTO[] = categories.map((c) => ({
    id: c.id,
    outlet_id: c.outlet_id,
    name: c.name,
    sort: c.sort,
    available_schedule: (c.available_schedule ?? null) as AvailabilitySchedule | null,
    available_now: isScheduleOpen(c.available_schedule as AvailabilitySchedule | null, now, outlet.timezone),
    is_active: c.is_active,
    translations: (c.translations ?? {}) as Translations,
  }));

  const itemsDto: MenuItemDTO[] = items.map((i) => ({
    id: i.id,
    outlet_id: i.outlet_id,
    category_id: i.category_id,
    name: i.name,
    description: i.description,
    photo_url: i.photo_url,
    price_paise: i.price_paise,
    is_veg: i.is_veg,
    hsn_sac: i.hsn_sac,
    tax_rate_bp: i.tax_rate_bp,
    tags: i.tags,
    in_stock: i.in_stock,
    station: i.station,
    sort: i.sort,
    short_code: i.short_code,
    modifier_group_ids: links.filter((l) => l.item_id === i.id).map((l) => l.group_id),
    translations: (i.translations ?? {}) as Translations,
  }));

  const groupsDto: ModifierGroupDTO[] = groups.map((g) => ({
    id: g.id,
    outlet_id: g.outlet_id,
    name: g.name,
    min_select: g.min_select,
    max_select: g.max_select,
    sort: g.sort,
    translations: (g.translations ?? {}) as Translations,
    modifiers: modifiers
      .filter((m) => m.group_id === g.id)
      .map((m) => ({
        id: m.id,
        group_id: m.group_id,
        name: m.name,
        price_delta_paise: m.price_delta_paise,
        is_veg: m.is_veg,
        in_stock: m.in_stock,
        sort: m.sort,
        translations: (m.translations ?? {}) as Translations,
      })),
  }));

  return { menu_version: outlet.menu_version, categories: categoriesDto, items: itemsDto, modifier_groups: groupsDto };
}

/**
 * Bumps the outlet's menu version (which keys the guest menu cache) and tells every open guest
 * menu and staff screen to refetch.
 */
export async function bumpMenu(tx: Tx, outletId: string): Promise<number> {
  const { menu_version } = await tx.db
    .updateTable('outlets')
    .set((eb) => ({ menu_version: eb('menu_version', '+', 1) }))
    .where('id', '=', outletId)
    .returning('menu_version')
    .executeTakeFirstOrThrow();
  await tx.emit({ outletId, type: 'menu.updated', channels: ['outlet', 'menu'], payload: { menu_version } });
  return menu_version;
}
