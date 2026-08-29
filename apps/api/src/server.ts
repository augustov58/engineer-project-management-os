import type { Queue } from 'bullmq';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { ObjectStore } from './object-store.js';
import { systemTimeSource, type TimeSource } from './time-source.js';
import { assumptionRecordRoutes } from './routes/assumption-records.js';
import { healthRoutes } from './routes/health.js';
import { issueRoutes } from './routes/issues.js';
import { openItemRoutes } from './routes/open-items.js';
import { phaseRoutes } from './routes/phases.js';
import { photoRoutes } from './routes/photos.js';
import { projectRoutes } from './routes/projects.js';
import { reportRoutes } from './routes/reports.js';
import { siteVisitRoutes } from './routes/site-visits.js';
import { submissionRoutes } from './routes/submissions.js';
import { voiceRoutes } from './routes/voice.js';

export interface ServerDependencies {
  prisma: PrismaClient;
  queue: Queue;
  /** Where a photograph's bytes go. No default: there is no sensible one. */
  objectStore: ObjectStore;
  /** Defaults to the real clock; tests pass a fake and advance it by hand. */
  timeSource?: TimeSource;
  logger?: boolean;
}

/**
 * The plan's API shape is a versioned prefix (issue #1). One `register` call
 * carries it, so the version lives in a single place rather than in every path.
 */
const API_PREFIX = '/v1';

/**
 * The boundary, and only the boundary: the ajv setting every schema depends
 * on, the prefix every path is carried by, and the record types the API is
 * made of. A record's own routes, schemas and helpers live in its file under
 * `routes/`, one per record type (ADR-0033). The test files line up with them
 * but are not one-to-one: `submissions.ts` is driven by three of them, and
 * phases are exercised through `submissions.test.ts`.
 */
export function buildServer({
  prisma,
  queue,
  objectStore,
  timeSource = systemTimeSource,
  logger = false,
}: ServerDependencies): FastifyInstance {
  const app = Fastify({
    logger,
    // Fastify's ajv defaults to `removeAdditional: true`, which silently
    // strips an unknown field instead of failing the request. A body carrying
    // `owner` would then look accepted while the field vanished — so
    // `additionalProperties: false` is made to mean what it says.
    ajv: { customOptions: { removeAdditional: false } },
  });

  const dependencies = { prisma, queue, objectStore, timeSource };

  // One `register` call carries the version, so it is written once rather than
  // spelled into every path (ADR-0023). The eleven below are plain functions
  // and not plugins on purpose: a plugin would open an encapsulation context of
  // its own, and there is nothing here that wants one.
  app.register(
    async (v1) => {
      healthRoutes(v1, dependencies);
      projectRoutes(v1, dependencies);
      openItemRoutes(v1, dependencies);
      phaseRoutes(v1, dependencies);
      submissionRoutes(v1, dependencies);
      assumptionRecordRoutes(v1, dependencies);
      siteVisitRoutes(v1, dependencies);
      issueRoutes(v1, dependencies);
      photoRoutes(v1, dependencies);
      voiceRoutes(v1, dependencies);
      reportRoutes(v1, dependencies);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
