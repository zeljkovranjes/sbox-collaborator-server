import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import * as initial from './001_initial.js';
import * as v11 from './002_handoffs_digests_notifications.js';

export type MigrationDialect = 'postgres' | 'sqlite';

type Step = { up(db: Kysely<any>, dialect: MigrationDialect): Promise<void> };

/* Add new migrations here, in order. Never edit a migration that has shipped. */
const STEPS: Record<string, Step> = {
  '001_initial': initial,
  '002_handoffs_digests_notifications': v11,
};

class StaticProvider implements MigrationProvider {
  constructor(private readonly dialect: MigrationDialect) {}
  async getMigrations(): Promise<Record<string, Migration>> {
    const out: Record<string, Migration> = {};
    for (const [name, step] of Object.entries(STEPS)) out[name] = { up: (db) => step.up(db, this.dialect) };
    return out;
  }
}

export async function migrateToLatest(db: Kysely<any>, dialect: MigrationDialect): Promise<string[]> {
  const migrator = new Migrator({ db, provider: new StaticProvider(dialect) });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
