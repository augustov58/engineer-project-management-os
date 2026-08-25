import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Read directly rather than through prisma's `env()`, which throws while
    // loading this file when the variable is unset. `prisma generate` needs no
    // database, and it runs on `pnpm install` before any `.env` exists; the
    // migrate commands still fail loudly on their own if the URL is missing.
    url: process.env['DATABASE_URL'],
  },
});
