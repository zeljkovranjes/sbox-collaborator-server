import type { CreateTableBuilder, Kysely } from 'kysely';
import type { MigrationDialect } from './index.js';

/* v1.1: task notes (handoffs), catch-up markers, weekly digests, Discord notifications. */
export async function up(db: Kysely<any>, dialect: MigrationDialect): Promise<void> {
  type Builder = CreateTableBuilder<any, any>;
  const serial =
    (name: string) =>
    (t: Builder): Builder =>
      dialect === 'postgres' ? t.addColumn(name, 'serial', (c) => c.primaryKey()) : t.addColumn(name, 'integer', (c) => c.primaryKey().autoIncrement());

  await db.schema
    .createTable('task_notes')
    .$call(serial('id'))
    .addColumn('task_id', 'integer', (c) => c.notNull().references('tasks.id').onDelete('cascade'))
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('author_id', 'text', (c) => c.notNull())
    .addColumn('agent_id', 'text')
    .addColumn('summary', 'text', (c) => c.notNull())
    .addColumn('next', 'text')
    .addColumn('gotchas', 'text')
    .addColumn('files', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('to_developer_id', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('task_notes_task').on('task_notes').columns(['task_id', 'created_at']).execute();

  await db.schema
    .createTable('catch_up_marks')
    .addColumn('developer_id', 'text', (c) => c.notNull())
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('at', 'bigint', (c) => c.notNull())
    .addPrimaryKeyConstraint('catch_up_marks_pk', ['developer_id', 'project_id'])
    .execute();

  await db.schema
    .createTable('digests')
    .$call(serial('id'))
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('from_at', 'bigint', (c) => c.notNull())
    .addColumn('to_at', 'bigint', (c) => c.notNull())
    .addColumn('summary', 'text', (c) => c.notNull())
    .addColumn('stats', 'text', (c) => c.notNull().defaultTo('{}'))
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('digests_project').on('digests').columns(['project_id', 'created_at']).execute();

  await db.schema.alterTable('developers').addColumn('discord_user_id', 'text').execute();
  await db.schema.alterTable('projects').addColumn('discord_webhook', 'text').execute();
}
