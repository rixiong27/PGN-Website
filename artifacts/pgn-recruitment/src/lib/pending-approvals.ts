export function restorePendingApproval<T extends { id: number }>(
  current: readonly T[] | undefined,
  previous: T,
  previousIndex: number,
): T[] {
  const next = current ? [...current] : [];
  if (next.some((row) => row.id === previous.id)) return next;

  const insertionIndex = Math.max(0, Math.min(previousIndex, next.length));
  next.splice(insertionIndex, 0, previous);
  return next;
}