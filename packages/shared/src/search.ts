// Finding a dish in two keystrokes: by the outlet's short code, by the first letters of its words
// ("pt" finds Paneer Tikka, "cc" Cold Coffee), by the start of its words, or anywhere in the name.
// Ties go to what the outlet sells most.

export interface Searchable {
  id: string;
  name: string;
  short_code?: string | null;
}

// Letters (any script, with their vowel signs) and numbers make up words.
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);

/** How well `query` finds this dish: 0 when it does not; higher is better. */
export function dishScore(query: string, dish: Searchable): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const code = dish.short_code?.toLowerCase();
  if (code && code === q) return 100;
  const name = dish.name.toLowerCase();
  const w = words(name);
  const initials = w.map((x) => x[0]).join('');
  const parts = words(q);
  if (name === q) return 90;
  // "pt" → Paneer Tikka before Paneer Tikka Masala, whose initials only start with it.
  if (parts.length === 1 && q.length >= 2 && initials === q) return 85;
  if (code && q.length >= 2 && code.startsWith(q)) return 75;
  if (parts.length === 1 && q.length >= 2 && initials.startsWith(q)) return 70 - (initials.length - q.length);
  // "pan tik" → every typed word starts a word of the name, in order.
  if (parts.length > 1) {
    let at = 0;
    const inOrder = parts.every((p) => {
      const i = w.findIndex((x, j) => j >= at && x.startsWith(p));
      if (i < 0) return false;
      at = i + 1;
      return true;
    });
    if (inOrder) return 60;
  }
  if (name.startsWith(q)) return 50;
  if (w.some((x) => x.startsWith(q))) return 40;
  if (name.includes(q)) return 20;
  return 0;
}

/**
 * Dishes that match, best first; equal matches by how often the outlet sold them lately
 * (`popular` is item ids, best seller first), then by name.
 */
export function searchDishes<T extends Searchable>(items: readonly T[], query: string, popular: readonly string[] = []): T[] {
  const rank = new Map(popular.map((id, i) => [id, i]));
  return items
    .map((item) => ({ item, score: dishScore(query, item) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (rank.get(a.item.id) ?? Infinity) - (rank.get(b.item.id) ?? Infinity) || a.item.name.localeCompare(b.item.name))
    .map((x) => x.item);
}
