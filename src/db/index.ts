import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CamelCasePlugin, Kysely, PostgresDialect, SqliteDialect, sql, type DatabaseConnection, type Driver, type Transaction } from 'kysely';
import pg from 'pg';
import type { Config } from '../config.js';
import { Mutex } from '../lib/mutex.js';
import { migrateToLatest, type MigrationDialect } from './migrations/index.js';
import type { Database } from './schema.js';

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export interface DatabaseHandle {
  db: Db;
  dialect: MigrationDialect;
  /** Takes a transaction-scoped lock (PostgreSQL advisory lock; SQLite is single-writer already). */
  lock(trx: Tx, key: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

// int8 (bigint) columns hold epoch milliseconds: return them as numbers, not strings.
pg.types.setTypeParser(20, (value: string) => Number(value));

/** node:sqlite (built into Node 22+) exposed through Kysely's SqliteDatabase interface. */
function nodeSqlite(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  return {
    close: () => database.close(),
    prepare(query: string) {
      const statement = database.prepare(query);
      const reader = statement.columns().length > 0;
      const params = (parameters: ReadonlyArray<unknown>) =>
        parameters.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as (string | number | bigint | null | Uint8Array)[];
      return {
        reader,
        all: (parameters: ReadonlyArray<unknown>) => statement.all(...params(parameters)),
        run: (parameters: ReadonlyArray<unknown>) => {
          const result = statement.run(...params(parameters));
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        iterate: (parameters: ReadonlyArray<unknown>) => statement.iterate(...params(parameters)) as IterableIterator<unknown>,
      };
    },
  };
}

/**
 * Kysely's SQLite driver shares one connection without locking, so two concurrent
 * transactions could interleave. This dialect hands the connection out one caller at a time.
 */
class SerializedSqliteDialect extends SqliteDialect {
  override createDriver(): Driver {
    const inner = super.createDriver();
    const mutex = new Mutex();
    const waiting: (() => void)[] = [];
    return {
      init: () => inner.init(),
      destroy: () => inner.destroy(),
      acquireConnection: async () => {
        const connection = await inner.acquireConnection();
        await new Promise<void>((acquired) => {
          void mutex.run(
            () =>
              new Promise<void>((release) => {
                waiting.push(release);
                acquired();
              }),
          );
        });
        return connection;
      },
      releaseConnection: async (connection: DatabaseConnection) => {
        await inner.releaseConnection(connection);
        waiting.shift()?.();
      },
      beginTransaction: (c, s) => inner.beginTransaction(c, s),
      commitTransaction: (c) => inner.commitTransaction(c),
      rollbackTransaction: (c) => inner.rollbackTransaction(c),
      savepoint: inner.savepoint?.bind(inner),
      rollbackToSavepoint: inner.rollbackToSavepoint?.bind(inner),
      releaseSavepoint: inner.releaseSavepoint?.bind(inner),
    } as Driver;
  }
}

/** Wraps any PostgreSQL-compatible Kysely instance (node-postgres in production, PGlite in tests). */
export async function postgresHandle(db: Db): Promise<DatabaseHandle> {
  await migrateToLatest(db, 'postgres');
  return {
    db,
    dialect: 'postgres',
    lock: async (trx, key) => {
      await sql`select pg_advisory_xact_lock(hashtext(${key}))`.execute(trx);
    },
    ping: async () => {
      await sql`select 1`.execute(db);
      return true;
    },
    close: () => db.destroy(),
  };
}

export async function openDatabase(config: Config['database']): Promise<DatabaseHandle> {
  if (config.kind === 'postgres') {
    const pool = new pg.Pool({ connectionString: config.url, max: 10 });
    return postgresHandle(new Kysely<Database>({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] }));
  }

  const db = new Kysely<Database>({
    dialect: new SerializedSqliteDialect({ database: nodeSqlite(config.path) }),
    plugins: [new CamelCasePlugin()],
  });
  await migrateToLatest(db, 'sqlite');
  return {
    db,
    dialect: 'sqlite',
    lock: async () => {},
    ping: async () => {
      await sql`select 1`.execute(db);
      return true;
    },
    close: () => db.destroy(),
  };
}
