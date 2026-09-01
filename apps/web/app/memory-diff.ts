/**
 * A line diff between what the memory said and what a proposal would make it
 * say (story 100).
 *
 * The proposal carries the whole proposed text and the base it was written
 * against, so the diff is derived here on every render and stored nowhere —
 * the shape the API gives it. LCS over lines: memory is bounded by its size
 * budget, so the quadratic table is a few thousand cells, not a risk.
 */

export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export function diffLines(base: string | null, proposed: string): DiffLine[] {
  const before = base === null ? [] : base.split('\n');
  const after = proposed.split('\n');

  // lcs[i][j] is the length of the common subsequence of before[i:] and
  // after[j:], computed backwards.
  const lcs: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ kind: 'same', text: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ kind: 'removed', text: before[i]! });
      i++;
    } else {
      lines.push({ kind: 'added', text: after[j]! });
      j++;
    }
  }
  for (; i < before.length; i++) {
    lines.push({ kind: 'removed', text: before[i]! });
  }
  for (; j < after.length; j++) {
    lines.push({ kind: 'added', text: after[j]! });
  }
  return lines;
}
