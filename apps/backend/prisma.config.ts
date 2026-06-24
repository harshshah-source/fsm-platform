import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 moved the connection URL out of schema.prisma. With a config file present
// the CLI no longer auto-loads .env, so dotenv/config is imported above. The datasource
// url here is what Migrate/introspection use; the runtime client connects via its adapter.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
  },
});
