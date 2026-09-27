import type { CreateTableBuilder, Kysely } from 'kysely';
import type { MigrationDialect } from './index.js';

/* Portable schema: runs on PostgreSQL (production) and SQLite (local/testing). */
export async function up(db: Kysely<any>, dialect: MigrationDialect): Promise<void> {
  type Builder = CreateTableBuilder<any, any>;
  const serial =
    (name: string) =>
    (t: Builder): Builder =>
      dialect === 'postgres' ? t.addColumn(name, 'serial', (c) => c.primaryKey()) : t.addColumn(name, 'integer', (c) => c.primaryKey().autoIncrement());

  await db.schema
    .createTable('developers')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('display_name', 'text', (c) => c.notNull())
    .addColumn('github_login', 'text', (c) => c.unique())
    .addColumn('github_id', 'bigint')
    .addColumn('role', 'text', (c) => c.notNull().defaultTo('member'))
    .addColumn('project_ids', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('disabled_at', 'bigint')
    .execute();

  await db.schema
    .createTable('access_keys')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('developer_id', 'text', (c) => c.notNull().references('developers.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('prefix', 'text', (c) => c.notNull())
    .addColumn('secret_hash', 'text', (c) => c.notNull())
    .addColumn('scopes', 'text', (c) => c.notNull())
    .addColumn('project_ids', 'text')
    .addColumn('created_via', 'text', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('last_used_at', 'bigint')
    .addColumn('expires_at', 'bigint')
    .addColumn('revoked_at', 'bigint')
    .execute();
  await db.schema.createIndex('access_keys_developer').on('access_keys').column('developer_id').execute();

  await db.schema
    .createTable('join_keys')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('prefix', 'text', (c) => c.notNull())
    .addColumn('secret_hash', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull().defaultTo('member'))
    .addColumn('github_login', 'text')
    .addColumn('max_uses', 'integer')
    .addColumn('uses', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('project_ids', 'text')
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('expires_at', 'bigint')
    .addColumn('revoked_at', 'bigint')
    .execute();

  await db.schema
    .createTable('web_sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('developer_id', 'text', (c) => c.notNull().references('developers.id').onDelete('cascade'))
    .addColumn('secret_hash', 'text', (c) => c.notNull())
    .addColumn('user_agent', 'text')
    .addColumn('ip', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('last_seen_at', 'bigint', (c) => c.notNull())
    .addColumn('expires_at', 'bigint', (c) => c.notNull())
    .addColumn('revoked_at', 'bigint')
    .execute();

  await db.schema
    .createTable('device_auths')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('device_code_hash', 'text', (c) => c.notNull().unique())
    .addColumn('user_code', 'text', (c) => c.notNull().unique())
    .addColumn('client_name', 'text', (c) => c.notNull())
    .addColumn('client_type', 'text', (c) => c.notNull())
    .addColumn('join_key_id', 'text')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('developer_id', 'text')
    .addColumn('key_id', 'text')
    .addColumn('interval', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('expires_at', 'bigint', (c) => c.notNull())
    .addColumn('last_polled_at', 'bigint')
    .execute();

  await db.schema
    .createTable('projects')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('package_ident', 'text')
    .addColumn('default_branch', 'text', (c) => c.notNull())
    .addColumn('summary', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('conventions', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('milestone', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('important_dirs', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('structure', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .addColumn('archived_at', 'bigint')
    .execute();

  await db.schema
    .createTable('project_repos')
    .addColumn('full_name', 'text', (c) => c.primaryKey())
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('display_name', 'text', (c) => c.notNull())
    .addColumn('default_branch', 'text')
    .execute();

  await db.schema
    .createTable('agents')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('developer_id', 'text', (c) => c.notNull().references('developers.id').onDelete('cascade'))
    .addColumn('key_id', 'text')
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('client_type', 'text', (c) => c.notNull())
    .addColumn('machine', 'text')
    .addColumn('model', 'text')
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('status_note', 'text')
    .addColumn('current_task_id', 'integer')
    .addColumn('branch', 'text')
    .addColumn('files', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('started_at', 'bigint', (c) => c.notNull())
    .addColumn('last_heartbeat_at', 'bigint', (c) => c.notNull())
    .addColumn('ended_at', 'bigint')
    .addColumn('last_sync_at', 'bigint')
    .addColumn('last_notice_at', 'bigint')
    .execute();
  await db.schema.createIndex('agents_project_heartbeat').on('agents').columns(['project_id', 'last_heartbeat_at']).execute();

  await db.schema
    .createTable('tasks')
    .$call(serial('id'))
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('priority', 'text', (c) => c.notNull())
    .addColumn('owner_id', 'text')
    .addColumn('agent_id', 'text')
    .addColumn('related_files', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('related_assets', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('depends_on', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('labels', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('branch', 'text')
    .addColumn('github_issue', 'integer')
    .addColumn('github_pr', 'integer')
    .addColumn('blocked_reason', 'text')
    .addColumn('completion_summary', 'text')
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .addColumn('claimed_at', 'bigint')
    .addColumn('completed_at', 'bigint')
    .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
    .execute();
  await db.schema.createIndex('tasks_project_status').on('tasks').columns(['project_id', 'status']).execute();

  await db.schema
    .createTable('reservations')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('path_key', 'text', (c) => c.notNull())
    .addColumn('is_directory', 'integer', (c) => c.notNull())
    .addColumn('developer_id', 'text', (c) => c.notNull())
    .addColumn('agent_id', 'text')
    .addColumn('task_id', 'integer')
    .addColumn('reason', 'text', (c) => c.notNull())
    .addColumn('branch', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('expires_at', 'bigint', (c) => c.notNull())
    .addColumn('released_at', 'bigint')
    .addColumn('release_reason', 'text')
    .execute();
  await db.schema.createIndex('reservations_active').on('reservations').columns(['project_id', 'released_at']).execute();

  await db.schema
    .createTable('assets')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('path_key', 'text', (c) => c.notNull())
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('tags', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('metadata', 'text', (c) => c.notNull().defaultTo('{}'))
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('last_commit_sha', 'text')
    .addColumn('last_changed_by', 'text')
    .addColumn('last_changed_at', 'bigint')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .addColumn('deleted_at', 'bigint')
    .addUniqueConstraint('assets_project_path', ['project_id', 'path_key'])
    .execute();

  await db.schema
    .createTable('asset_links')
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('from_key', 'text', (c) => c.notNull())
    .addColumn('to_key', 'text', (c) => c.notNull())
    .addColumn('to_path', 'text', (c) => c.notNull())
    .addColumn('source', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('asset_links_pk', ['project_id', 'from_key', 'to_key'])
    .execute();
  await db.schema.createIndex('asset_links_to').on('asset_links').columns(['project_id', 'to_key']).execute();

  await db.schema
    .createTable('commits')
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('sha', 'text', (c) => c.notNull())
    .addColumn('repo', 'text', (c) => c.notNull())
    .addColumn('branch', 'text')
    .addColumn('message', 'text', (c) => c.notNull())
    .addColumn('author_name', 'text')
    .addColumn('author_login', 'text')
    .addColumn('developer_id', 'text')
    .addColumn('url', 'text')
    .addColumn('at', 'bigint', (c) => c.notNull())
    .addColumn('pushed_at', 'bigint', (c) => c.notNull())
    .addColumn('added', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('modified', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('removed', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('task_id', 'integer')
    .addColumn('agent_id', 'text')
    .addPrimaryKeyConstraint('commits_pk', ['project_id', 'sha'])
    .execute();
  await db.schema.createIndex('commits_project_at').on('commits').columns(['project_id', 'at']).execute();

  await db.schema
    .createTable('branches')
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('repo', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('head_sha', 'text')
    .addColumn('last_push_at', 'bigint', (c) => c.notNull())
    .addColumn('last_pusher_login', 'text')
    .addColumn('developer_id', 'text')
    .addColumn('deleted_at', 'bigint')
    .addPrimaryKeyConstraint('branches_pk', ['project_id', 'repo', 'name'])
    .execute();

  await db.schema
    .createTable('pull_requests')
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('repo', 'text', (c) => c.notNull())
    .addColumn('number', 'integer', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('state', 'text', (c) => c.notNull())
    .addColumn('author_login', 'text')
    .addColumn('head_ref', 'text')
    .addColumn('base_ref', 'text')
    .addColumn('merged', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('url', 'text')
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .addColumn('task_id', 'integer')
    .addPrimaryKeyConstraint('pull_requests_pk', ['project_id', 'repo', 'number'])
    .execute();

  await db.schema
    .createTable('issues')
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('repo', 'text', (c) => c.notNull())
    .addColumn('number', 'integer', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('state', 'text', (c) => c.notNull())
    .addColumn('author_login', 'text')
    .addColumn('url', 'text')
    .addColumn('labels', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .addColumn('task_id', 'integer')
    .addPrimaryKeyConstraint('issues_pk', ['project_id', 'repo', 'number'])
    .execute();

  await db.schema
    .createTable('webhook_deliveries')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('event', 'text', (c) => c.notNull())
    .addColumn('received_at', 'bigint', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('changes')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('agent_id', 'text')
    .addColumn('developer_id', 'text', (c) => c.notNull())
    .addColumn('task_id', 'integer')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('summary', 'text', (c) => c.notNull())
    .addColumn('branch', 'text')
    .addColumn('commit_sha', 'text')
    .addColumn('files', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('assets', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('apis_added', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('apis_removed', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('apis_renamed', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('behavior_changes', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('breaking_changes', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('tests_performed', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('known_issues', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('follow_ups', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('reason', 'text')
    .addColumn('started_at', 'bigint', (c) => c.notNull())
    .addColumn('completed_at', 'bigint')
    .execute();
  await db.schema.createIndex('changes_project').on('changes').columns(['project_id', 'started_at']).execute();

  await db.schema
    .createTable('decisions')
    .$call(serial('id'))
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('context', 'text', (c) => c.notNull())
    .addColumn('decision', 'text', (c) => c.notNull())
    .addColumn('reasoning', 'text', (c) => c.notNull())
    .addColumn('affected_systems', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('tags', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('author_id', 'text', (c) => c.notNull())
    .addColumn('agent_id', 'text')
    .addColumn('task_id', 'integer')
    .addColumn('commit_sha', 'text')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('superseded_by', 'integer')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('messages')
    .$call(serial('id'))
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('from_developer_id', 'text', (c) => c.notNull())
    .addColumn('from_agent_id', 'text')
    .addColumn('to_developer_id', 'text')
    .addColumn('to_agent_id', 'text')
    .addColumn('subject', 'text')
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('task_id', 'integer')
    .addColumn('paths', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('messages_project_created').on('messages').columns(['project_id', 'created_at']).execute();

  await db.schema
    .createTable('message_receipts')
    .addColumn('message_id', 'integer', (c) => c.notNull().references('messages.id').onDelete('cascade'))
    .addColumn('developer_id', 'text', (c) => c.notNull())
    .addColumn('read_at', 'bigint')
    .addColumn('acked_at', 'bigint')
    .addPrimaryKeyConstraint('message_receipts_pk', ['message_id', 'developer_id'])
    .execute();

  await db.schema
    .createTable('knowledge')
    .$call(serial('id'))
    .addColumn('project_id', 'text', (c) => c.references('projects.id').onDelete('cascade'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('tags', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('author_id', 'text', (c) => c.notNull())
    .addColumn('agent_id', 'text')
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .addColumn('archived_at', 'bigint')
    .execute();

  await db.schema
    .createTable('test_runs')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('developer_id', 'text', (c) => c.notNull())
    .addColumn('agent_id', 'text')
    .addColumn('commit_sha', 'text')
    .addColumn('branch', 'text')
    .addColumn('build', 'text')
    .addColumn('scene', 'text')
    .addColumn('description', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('errors', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('logs', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('screenshots', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('started_at', 'bigint', (c) => c.notNull())
    .addColumn('finished_at', 'bigint')
    .execute();
  await db.schema.createIndex('test_runs_project').on('test_runs').columns(['project_id', 'started_at']).execute();

  await db.schema
    .createTable('activity')
    .$call(serial('id'))
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('at', 'bigint', (c) => c.notNull())
    .addColumn('actor_id', 'text')
    .addColumn('agent_id', 'text')
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('summary', 'text', (c) => c.notNull())
    .addColumn('ref_type', 'text')
    .addColumn('ref_id', 'text')
    .addColumn('importance', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('data', 'text')
    .execute();
  await db.schema.createIndex('activity_project_at').on('activity').columns(['project_id', 'at']).execute();

}
