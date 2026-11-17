// The teacher's own arrangement of the computer cards, e.g. to match where the
// computers stand in the room. Pure helpers shared by the roster (main
// process) and the grid (renderer).

const MAX_ORDER = 1000;

/** Keeps distinct string ids only: the order comes from the renderer or disk. */
export function cleanOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === 'string' && id !== ''))].slice(0, MAX_ORDER);
}

/**
 * Sorts students into the saved order. Computers missing from it (new ones,
 * or all of them before the teacher arranges anything) follow in name order.
 */
export function arrange<T extends { id: string }>(items: T[], order: string[], name: (item: T) => string): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id) ?? Infinity;
    const rb = rank.get(b.id) ?? Infinity;
    if (ra !== rb) return ra < rb ? -1 : 1;
    return name(a).localeCompare(name(b), undefined, { numeric: true });
  });
}

/**
 * The whole order after the teacher rearranged the cards on screen. `shown` is
 * the new order of the visible cards. Hidden ones (another group, or offline
 * with "Show offline" off) keep their places, and the visible ones fill the
 * places they had between them.
 */
export function rearrange(all: string[], shown: string[]): string[] {
  const known = new Set(all);
  const moved = shown.filter((id) => known.has(id));
  const visible = new Set(moved);
  let next = 0;
  return all.map((id) => (visible.has(id) ? moved[next++] : id));
}
