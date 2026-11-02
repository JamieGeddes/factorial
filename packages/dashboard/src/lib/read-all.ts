/**
 * Every item of a cursor-paged list: calls `fetchPage` with no cursor, then
 * with each `nextCursor` until there is none. Offset cursors can repeat a row
 * when the ledger changes between reads, so items are de-duplicated by id
 * (the first kept). A repeated cursor stops the loop. Returns the last page's
 * other fields (totals, sources, counts) with all the items and no cursor; a
 * page that rejects rejects the whole read.
 */
export async function readAll<T extends { id: string }, P extends { items: T[]; nextCursor?: string | undefined }>(fetchPage: (cursor: string | undefined) => Promise<P>): Promise<Omit<P, 'nextCursor'>> {
  const seen = new Set<string>();
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    const next = page.nextCursor;
    if (!next || cursors.has(next)) {
      const { nextCursor: _ignored, ...rest } = page;
      return { ...rest, items };
    }
    cursors.add(next);
    cursor = next;
  }
}
