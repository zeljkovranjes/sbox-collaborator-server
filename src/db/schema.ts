import type { Generated, Insertable, Selectable, Updateable } from 'kysely';

/*
 * Column conventions (portable between PostgreSQL and SQLite):
 *  - timestamps: epoch milliseconds (bigint)
 *  - booleans:   integer 0/1
 *  - lists/maps: JSON text (see lib/json)
 * TypeScript names are camelCase; the CamelCasePlugin maps them to snake_case columns.
 */

type Ms = number;
type Json = string;

export interface DevelopersTable {
  id: string;
  displayName: string;
  githubLogin: string | null;
  githubId: number | null;
  role: 'admin' | 'member';
  projectIds: Json | null;
  createdAt: Ms;
  disabledAt: Ms | null;
  discordUserId: string | null;
}

export interface AccessKeysTable {
  id: string;
  developerId: string;
  name: string;
  prefix: string;
  secretHash: string;
  scopes: Json;
  projectIds: Json | null;
  createdVia: string;
  createdAt: Ms;
  lastUsedAt: Ms | null;
  expiresAt: Ms | null;
  revokedAt: Ms | null;
}

export interface JoinKeysTable {
  id: string;
  name: string;
  prefix: string;
  secretHash: string;
  role: 'admin' | 'member';
  githubLogin: string | null;
  maxUses: number | null;
  uses: number;
  projectIds: Json | null;
  createdBy: string | null;
  createdAt: Ms;
  expiresAt: Ms | null;
  revokedAt: Ms | null;
}

export interface WebSessionsTable {
  id: string;
  developerId: string;
  secretHash: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Ms;
  lastSeenAt: Ms;
  expiresAt: Ms;
  revokedAt: Ms | null;
}

export interface DeviceAuthsTable {
  id: string;
  deviceCodeHash: string;
  userCode: string;
  clientName: string;
  clientType: string;
  joinKeyId: string | null;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  developerId: string | null;
  keyId: string | null;
  interval: number;
  createdAt: Ms;
  expiresAt: Ms;
  lastPolledAt: Ms | null;
}

export interface ProjectsTable {
  id: string;
  name: string;
  kind: 'game' | 'library' | 'tool';
  packageIdent: string | null;
  defaultBranch: string;
  summary: string;
  conventions: string;
  milestone: string;
  importantDirs: Json;
  structure: string;
  createdAt: Ms;
  updatedAt: Ms;
  archivedAt: Ms | null;
  /** Discord webhook URL, AES-GCM encrypted with a key derived from SECRET_KEY. */
  discordWebhook: string | null;
}

export interface ProjectReposTable {
  fullName: string;
  projectId: string;
  displayName: string;
  defaultBranch: string | null;
}

export interface AgentsTable {
  id: string;
  developerId: string;
  keyId: string | null;
  projectId: string;
  clientType: string;
  machine: string | null;
  model: string | null;
  label: string;
  status: string;
  statusNote: string | null;
  currentTaskId: number | null;
  branch: string | null;
  files: Json;
  startedAt: Ms;
  lastHeartbeatAt: Ms;
  endedAt: Ms | null;
  lastSyncAt: Ms | null;
  lastNoticeAt: Ms | null;
}

export interface TasksTable {
  id: Generated<number>;
  projectId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  ownerId: string | null;
  agentId: string | null;
  relatedFiles: Json;
  relatedAssets: Json;
  dependsOn: Json;
  labels: Json;
  branch: string | null;
  githubIssue: number | null;
  githubPr: number | null;
  blockedReason: string | null;
  completionSummary: string | null;
  createdBy: string | null;
  createdAt: Ms;
  updatedAt: Ms;
  claimedAt: Ms | null;
  completedAt: Ms | null;
  version: number;
}

export interface ReservationsTable {
  id: string;
  projectId: string;
  path: string;
  pathKey: string;
  isDirectory: number;
  developerId: string;
  agentId: string | null;
  taskId: number | null;
  reason: string;
  branch: string | null;
  createdAt: Ms;
  expiresAt: Ms;
  releasedAt: Ms | null;
  releaseReason: string | null;
}

export interface AssetsTable {
  id: string;
  projectId: string;
  path: string;
  pathKey: string;
  type: string;
  name: string;
  description: string | null;
  tags: Json;
  metadata: Json;
  source: string;
  lastCommitSha: string | null;
  lastChangedBy: string | null;
  lastChangedAt: Ms | null;
  createdAt: Ms;
  updatedAt: Ms;
  deletedAt: Ms | null;
}

export interface AssetLinksTable {
  projectId: string;
  fromKey: string;
  toKey: string;
  toPath: string;
  source: string;
}

export interface CommitsTable {
  projectId: string;
  sha: string;
  repo: string;
  branch: string | null;
  message: string;
  authorName: string | null;
  authorLogin: string | null;
  developerId: string | null;
  url: string | null;
  at: Ms;
  pushedAt: Ms;
  added: Json;
  modified: Json;
  removed: Json;
  taskId: number | null;
  agentId: string | null;
}

export interface BranchesTable {
  projectId: string;
  repo: string;
  name: string;
  headSha: string | null;
  lastPushAt: Ms;
  lastPusherLogin: string | null;
  developerId: string | null;
  deletedAt: Ms | null;
}

export interface PullRequestsTable {
  projectId: string;
  repo: string;
  number: number;
  title: string;
  state: string;
  authorLogin: string | null;
  headRef: string | null;
  baseRef: string | null;
  merged: number;
  url: string | null;
  updatedAt: Ms;
  taskId: number | null;
}

export interface IssuesTable {
  projectId: string;
  repo: string;
  number: number;
  title: string;
  state: string;
  authorLogin: string | null;
  url: string | null;
  labels: Json;
  updatedAt: Ms;
  taskId: number | null;
}

export interface WebhookDeliveriesTable {
  id: string;
  event: string;
  receivedAt: Ms;
  status: string;
}

export interface ChangesTable {
  id: string;
  projectId: string;
  agentId: string | null;
  developerId: string;
  taskId: number | null;
  status: 'started' | 'completed' | 'abandoned';
  summary: string;
  branch: string | null;
  commitSha: string | null;
  files: Json;
  assets: Json;
  apisAdded: Json;
  apisRemoved: Json;
  apisRenamed: Json;
  behaviorChanges: Json;
  breakingChanges: Json;
  testsPerformed: Json;
  knownIssues: Json;
  followUps: Json;
  reason: string | null;
  startedAt: Ms;
  completedAt: Ms | null;
}

export interface DecisionsTable {
  id: Generated<number>;
  projectId: string;
  title: string;
  context: string;
  decision: string;
  reasoning: string;
  affectedSystems: Json;
  tags: Json;
  authorId: string;
  agentId: string | null;
  taskId: number | null;
  commitSha: string | null;
  status: string;
  supersededBy: number | null;
  createdAt: Ms;
  updatedAt: Ms;
}

export interface MessagesTable {
  id: Generated<number>;
  projectId: string;
  type: string;
  fromDeveloperId: string;
  fromAgentId: string | null;
  toDeveloperId: string | null;
  toAgentId: string | null;
  subject: string | null;
  body: string;
  taskId: number | null;
  paths: Json;
  createdAt: Ms;
}

export interface MessageReceiptsTable {
  messageId: number;
  developerId: string;
  readAt: Ms | null;
  ackedAt: Ms | null;
}

export interface KnowledgeTable {
  id: Generated<number>;
  projectId: string | null;
  title: string;
  body: string;
  tags: Json;
  authorId: string;
  agentId: string | null;
  createdAt: Ms;
  updatedAt: Ms;
  archivedAt: Ms | null;
}

export interface TestRunsTable {
  id: string;
  projectId: string;
  developerId: string;
  agentId: string | null;
  commitSha: string | null;
  branch: string | null;
  build: string | null;
  scene: string | null;
  description: string;
  status: string;
  errors: Json;
  logs: Json;
  screenshots: Json;
  startedAt: Ms;
  finishedAt: Ms | null;
}

export interface ActivityTable {
  id: Generated<number>;
  projectId: string;
  at: Ms;
  actorId: string | null;
  agentId: string | null;
  kind: string;
  summary: string;
  refType: string | null;
  refId: string | null;
  importance: number;
  data: Json | null;
}

export interface TaskNotesTable {
  id: Generated<number>;
  taskId: number;
  projectId: string;
  kind: 'handoff' | 'note';
  authorId: string;
  agentId: string | null;
  summary: string;
  next: string | null;
  gotchas: string | null;
  files: Json;
  toDeveloperId: string | null;
  createdAt: Ms;
}

export interface CatchUpMarksTable {
  developerId: string;
  projectId: string;
  at: Ms;
}

export interface DigestsTable {
  id: Generated<number>;
  projectId: string;
  fromAt: Ms;
  toAt: Ms;
  summary: string;
  stats: Json;
  createdAt: Ms;
}

export interface Database {
  taskNotes: TaskNotesTable;
  catchUpMarks: CatchUpMarksTable;
  digests: DigestsTable;
  developers: DevelopersTable;
  accessKeys: AccessKeysTable;
  joinKeys: JoinKeysTable;
  webSessions: WebSessionsTable;
  deviceAuths: DeviceAuthsTable;
  projects: ProjectsTable;
  projectRepos: ProjectReposTable;
  agents: AgentsTable;
  tasks: TasksTable;
  reservations: ReservationsTable;
  assets: AssetsTable;
  assetLinks: AssetLinksTable;
  commits: CommitsTable;
  branches: BranchesTable;
  pullRequests: PullRequestsTable;
  issues: IssuesTable;
  webhookDeliveries: WebhookDeliveriesTable;
  changes: ChangesTable;
  decisions: DecisionsTable;
  messages: MessagesTable;
  messageReceipts: MessageReceiptsTable;
  knowledge: KnowledgeTable;
  testRuns: TestRunsTable;
  activity: ActivityTable;
}

export type DeveloperRow = Selectable<DevelopersTable>;
export type AccessKeyRow = Selectable<AccessKeysTable>;
export type JoinKeyRow = Selectable<JoinKeysTable>;
export type ProjectRow = Selectable<ProjectsTable>;
export type AgentRow = Selectable<AgentsTable>;
export type TaskRow = Selectable<TasksTable>;
export type NewTask = Insertable<TasksTable>;
export type TaskUpdate = Updateable<TasksTable>;
export type ReservationRow = Selectable<ReservationsTable>;
export type AssetRow = Selectable<AssetsTable>;
export type CommitRow = Selectable<CommitsTable>;
export type ChangeRow = Selectable<ChangesTable>;
export type DecisionRow = Selectable<DecisionsTable>;
export type MessageRow = Selectable<MessagesTable>;
export type KnowledgeRow = Selectable<KnowledgeTable>;
export type TestRunRow = Selectable<TestRunsTable>;
export type ActivityRow = Selectable<ActivityTable>;
export type TaskNoteRow = Selectable<TaskNotesTable>;
export type DigestRow = Selectable<DigestsTable>;
