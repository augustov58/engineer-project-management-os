/**
 * Which project-memory version is current, and the history's order (issue #42).
 *
 * A **leaf** by ADR-0033's trigger: this lived in `routes/memory.ts` while the
 * memory record was its only reader, and moved when search became the second
 * (issue #66) — a thing two records use leaves the record that had it first,
 * and a route module importing another is the cycle the leaves exist to
 * prevent. The two orders move together because they must stay each other's
 * exact reverse. It imports Prisma's types and nothing of this product's.
 */

import type { Prisma } from '../generated/prisma/client.js';

/**
 * The order the history reads in, oldest first — and a **total** one.
 *
 * `created_at` is `TIMESTAMP(3)`, so two versions written in the same
 * millisecond tie, and the `id` this used to fall back on is a random v4
 * uuid: the tie was settled by coin toss, and the older of the two could
 * read as the current memory. `seq` is a sequence, allocated in the order
 * the inserts were issued (issue #42).
 */
export const OLDEST_FIRST = [
  { createdAt: 'asc' },
  { seq: 'asc' },
] satisfies Prisma.ProjectMemoryVersionOrderByWithRelationInput[];

/**
 * That order reversed, which is what picks the current memory. It must stay
 * an exact reverse of `OLDEST_FIRST`: the history's last row and the current
 * memory are the same row, and a key added to one and not the other would
 * split them — the split this change exists to close. A test writes five
 * versions in one millisecond and asserts both readings agree.
 */
const NEWEST_FIRST = [
  { createdAt: 'desc' },
  { seq: 'desc' },
] satisfies Prisma.ProjectMemoryVersionOrderByWithRelationInput[];

/**
 * Which version is current, read in **one place**: the memory read, the base
 * a proposal is written against and the base an accept is checked against
 * all come through here, so they cannot come to disagree about which row it
 * is — and since issue #66 so does search, which finds only what the memory
 * says now. The one other order here is the history's, and it is this one
 * reversed.
 */
export async function currentVersion(
  prisma: Prisma.TransactionClient,
  projectId: string,
) {
  return prisma.projectMemoryVersion.findFirst({
    where: { projectId },
    orderBy: NEWEST_FIRST,
    select: { id: true, content: true, createdAt: true },
  });
}
