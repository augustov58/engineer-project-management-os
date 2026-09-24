/**
 * Keyword search across every job (issue #66, ADR-0067).
 *
 * The first escalation ADR-0019 names — *keyword search, when a corpus
 * outgrows reading* — and nothing past it: no embedding, no vector, no
 * similarity between records. Each searched table carries a `search_vector`
 * the database generates from the row's own text (the migration says which
 * columns), so no writer maintains it and it cannot drift from what it indexes.
 *
 * One read, across every job, archived ones included and said to be: *"a
 * document I cannot place on a job"* is the case the ticket names, and a box
 * scoped to one job cannot answer it. Results are **ranked** by `ts_rank` —
 * how well the words match, not how alike two records are — and at most
 * {@link MOST} come back.
 */

import type { FastifyInstance } from 'fastify';
import { Prisma } from '../../generated/prisma/client.js';
import type { RouteDependencies } from '../http.js';
import { currentVersion } from '../memory-version.js';

/** How many results one search answers with, across every kind. */
const MOST = 50;

/**
 * Where a match is inside an excerpt: two control characters no record's text
 * carries, so the screen can mark the match by splitting the string and never
 * by rendering markup from it. An arrival's body is a stranger's words.
 */
const HEADLINE = 'StartSel=\u0002, StopSel=\u0003, MaxWords=24, MinWords=10, MaxFragments=1';

/** Characters of OCR text the search column reads — the migration's bound. */
const OCR_SEARCHED = 300_000;

const searchQuerySchema = {
  type: 'object',
  required: ['q'],
  additionalProperties: false,
  properties: {
    q: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

/** One match, as a kind's query returns it. */
interface Match {
  kind: string;
  id: string;
  project_id: string;
  link_id: string;
  title: string;
  rank: number;
  excerpt: string | null;
}

/**
 * Each kind's query: the matching rows, best first, at most {@link MOST}, and
 * the excerpt drawn only for those — `ts_headline` reads the whole text it is
 * handed, which for an extraction is up to {@link OCR_SEARCHED} characters.
 *
 * **Each `body` is the same fields as that table's `search_vector`**, in the
 * migration's order: a row matched on a field the excerpt leaves out comes
 * back with no match marked and no sign of why it matched. A field added to
 * one is added to the other. A job's own match needs no excerpt; its title is
 * the two fields it is indexed on.
 */
function matches(query: Prisma.Sql): Prisma.Sql[] {
  const top = (select: Prisma.Sql) => Prisma.sql`
    SELECT h."kind", h."id", h."project_id", h."link_id", h."title", h."rank",
      CASE WHEN h."body" IS NULL THEN NULL
        ELSE ts_headline('english'::regconfig, h."body", q.query, ${HEADLINE}) END AS "excerpt"
    FROM (${select} ORDER BY "rank" DESC LIMIT ${MOST}) h,
      (SELECT ${query} AS query) q`;

  return [
    top(Prisma.sql`
      SELECT 'project' AS "kind", p."id", p."id" AS "project_id", p."id" AS "link_id",
        p."project_number" || ' — ' || p."name" AS "title",
        ts_rank(p."search_vector", ${query}) AS "rank", NULL::text AS "body"
      FROM "projects" p WHERE p."search_vector" @@ ${query}`),
    top(Prisma.sql`
      SELECT 'open-item' AS "kind", o."id", o."subject_id" AS "project_id", o."subject_id" AS "link_id",
        o."unresolved" AS "title", ts_rank(o."search_vector", ${query}) AS "rank",
        o."unresolved" || ' ' || o."blocks" || ' ' || coalesce(o."waiting_on", '') || ' ' ||
          coalesce(o."resolution_note", '') || ' ' || o."counterfactual" AS "body"
      FROM "open_items" o
      WHERE o."subject_type" = 'PROJECT' AND o."search_vector" @@ ${query}`),
    top(Prisma.sql`
      SELECT 'submission' AS "kind", s."id", s."project_id", s."id" AS "link_id",
        s."revision" || ' to ' || s."recipient" AS "title",
        ts_rank(s."search_vector", ${query}) AS "rank",
        s."recipient" || ' ' || s."recipient_role" || ' ' || s."sheet_list" || ' ' ||
          s."revision" AS "body"
      FROM "submissions" s WHERE s."search_vector" @@ ${query}`),
    top(Prisma.sql`
      SELECT 'assumption-record' AS "kind", a."id", s."project_id", s."id" AS "link_id",
        'Assumption record, ' || a."code_edition" AS "title",
        ts_rank(a."search_vector", ${query}) AS "rank",
        a."assumptions" || ' ' || a."flags" || ' ' || a."code_edition" AS "body"
      FROM "assumption_records" a JOIN "submissions" s ON s."id" = a."submission_id"
      WHERE a."search_vector" @@ ${query}`),
    // An observation that stayed one opens on its walk.
    top(Prisma.sql`
      SELECT 'observation' AS "kind", o."id", v."project_id", v."id" AS "link_id",
        'Floor ' || o."floor" || ' — ' || o."qualifier" AS "title",
        ts_rank(o."search_vector", ${query}) AS "rank",
        o."observed" || ' ' || o."floor" || ' ' || o."qualifier" AS "body"
      FROM "observations" o JOIN "site_visits" v ON v."id" = o."site_visit_id"
      WHERE o."search_vector" @@ ${query}
        AND NOT EXISTS (SELECT 1 FROM "issue_observations" io WHERE io."observation_id" = o."id")`),
    // A sighting opens on its finding, by the number a person has written
    // down (ADR-0031) — as does a finding matched by its closure note.
    top(Prisma.sql`
      SELECT 'issue' AS "kind", i."id", i."project_id", i."number"::text AS "link_id",
        'Issue ' || i."number" AS "title", ts_rank(o."search_vector", ${query}) AS "rank",
        o."observed" || ' ' || o."floor" || ' ' || o."qualifier" AS "body"
      FROM "observations" o
        JOIN "issue_observations" io ON io."observation_id" = o."id"
        JOIN "issues" i ON i."id" = io."issue_id"
      WHERE o."search_vector" @@ ${query}
      UNION ALL
      SELECT 'issue', i."id", i."project_id", i."number"::text, 'Issue ' || i."number",
        ts_rank(i."search_vector", ${query}), i."closure_note"
      FROM "issues" i WHERE i."search_vector" @@ ${query}`),
    top(Prisma.sql`
      SELECT 'register-entry' AS "kind", e."id", r."project_id", e."id" AS "link_id",
        e."number" || ' — ' || e."subject" AS "title",
        ts_rank(e."search_vector", ${query}) AS "rank",
        e."number" || ' ' || e."subject" || ' ' || e."from_party" || ' ' || e."to_party" || ' ' ||
          coalesce(e."question", '') || ' ' || coalesce(e."response", '') AS "body"
      FROM "register_entries" e JOIN "registers" r ON r."id" = e."register_id"
      WHERE e."search_vector" @@ ${query}`),
    top(Prisma.sql`
      SELECT 'document' AS "kind", d."id", d."project_id", d."project_id" AS "link_id",
        d."title", ts_rank(d."search_vector", ${query}) AS "rank", d."title" AS "body"
      FROM "documents" d WHERE d."search_vector" @@ ${query}
      UNION ALL
      SELECT 'document', d."id", d."project_id", d."project_id", d."title",
        ts_rank(dv."search_vector", ${query}), dv."filename" || ' ' || dv."revision"
      FROM "document_versions" dv JOIN "documents" d ON d."id" = dv."document_id"
      WHERE dv."search_vector" @@ ${query}`),
    top(Prisma.sql`
      SELECT 'arrival' AS "kind", a."id", a."project_id", a."project_id" AS "link_id",
        coalesce(a."subject", 'An arrival') AS "title",
        ts_rank(a."search_vector", ${query}) AS "rank",
        coalesce(a."sender", '') || ' ' || coalesce(a."subject", '') || ' ' ||
          coalesce(a."body", '') || ' ' || coalesce(a."note", '') AS "body"
      FROM "ingested_documents" a WHERE a."search_vector" @@ ${query}`),
    top(Prisma.sql`
      SELECT 'extraction' AS "kind", x."id", x."project_id", x."id" AS "link_id",
        coalesce(x."proposed_title", x."proposed_number", 'An extraction') AS "title",
        ts_rank(x."search_vector", ${query}) AS "rank",
        left(coalesce(x."ocr_text", ''), ${OCR_SEARCHED}) || ' ' ||
          coalesce(x."proposed_number", '') || ' ' || coalesce(x."proposed_subject", '') || ' ' ||
          coalesce(x."proposed_from_party", '') || ' ' || coalesce(x."proposed_to_party", '') || ' ' ||
          coalesce(x."proposed_question", '') || ' ' || coalesce(x."proposed_response", '') || ' ' ||
          coalesce(x."proposed_party", '') || ' ' || coalesce(x."proposed_title", '') || ' ' ||
          coalesce(x."proposed_revision", '') AS "body"
      FROM "register_entry_extractions" x WHERE x."search_vector" @@ ${query}`),
    top(Prisma.sql`
      SELECT 'memory' AS "kind", m."id", m."project_id", m."project_id" AS "link_id",
        'Project memory' AS "title", ts_rank(m."search_vector", ${query}) AS "rank",
        m."content" AS "body"
      FROM "project_memory_versions" m WHERE m."search_vector" @@ ${query}`),
  ];
}

export function searchRoutes(
  v1: FastifyInstance,
  { prisma }: RouteDependencies,
): void {
  v1.get<{ Querystring: { q: string } }>(
    '/search',
    { schema: { querystring: searchQuerySchema } },
    async (request) => {
      const { q } = request.query;
      // `websearch_to_tsquery` takes what a person types — words, a quoted
      // phrase, `-word` — and never refuses it as syntax. Stop words alone
      // make an empty query, which matches nothing.
      const query = Prisma.sql`websearch_to_tsquery('english'::regconfig, ${q})`;

      const found = (
        await Promise.all(matches(query).map((sql) => prisma.$queryRaw<Match[]>(sql)))
      ).flat();

      // Only what the memory says **now** — the current version is read in
      // the one place it is read (`currentVersion`), never worked out again
      // here with a second ordering.
      const current = new Map<string, string | undefined>();
      for (const match of found.filter((one) => one.kind === 'memory')) {
        if (!current.has(match.project_id)) {
          current.set(match.project_id, (await currentVersion(prisma, match.project_id))?.id);
        }
      }

      // One result per record: a document matched by its title and by a
      // version's filename, or a finding by two sightings, is one result at
      // its best rank.
      const best = new Map<string, Match>();
      for (const match of found) {
        if (match.kind === 'memory' && current.get(match.project_id) !== match.id) {
          continue;
        }
        const key = `${match.kind}:${match.id}`;
        const seen = best.get(key);
        if (seen === undefined || match.rank > seen.rank) {
          best.set(key, match);
        }
      }
      const ranked = [...best.values()]
        .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title))
        .slice(0, MOST);

      const projects = new Map(
        (
          await prisma.project.findMany({
            where: { id: { in: [...new Set(ranked.map((one) => one.project_id))] } },
            select: { id: true, projectNumber: true, name: true, archivedAt: true },
          })
        ).map((project) => [project.id, project]),
      );

      return {
        results: ranked.map((match) => {
          const project = projects.get(match.project_id)!;
          return {
            kind: match.kind,
            id: match.id,
            projectId: project.id,
            projectNumber: project.projectNumber,
            projectName: project.name,
            archived: project.archivedAt !== null,
            title: match.title,
            excerpt: match.excerpt,
            linkId: match.link_id,
          };
        }),
      };
    },
  );
}
