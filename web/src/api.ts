export interface Developer { discordUserId?: string | null; id: string; displayName: string; githubLogin: string | null; role: 'admin' | 'member'; online?: boolean }
export interface Project { discordConfigured?: boolean; id: string; name: string; kind: string; packageIdent: string | null; defaultBranch: string; repos: { fullName: string }[]; summary: string; conventions: string; milestone: string; importantDirs: { path: string; description: string }[]; structure: string; updatedAt: string }
export interface Agent { id: string; developerId: string; developerName: string; clientType: string; machine: string | null; model: string | null; label: string; status: string; statusNote: string | null; currentTaskId: number | null; currentTaskTitle: string | null; branch: string | null; files: string[]; lastHeartbeatAt: string; online: boolean }
export interface TaskNote { id: number; taskId: number; kind: string; authorName: string; summary: string; next: string | null; gotchas: string | null; files: string[]; toDeveloperId: string | null; createdAt: string }
export interface Task { suggestedBranch: string; lastHandoff: TaskNote | null; id: number; projectId: string; title: string; description: string; status: string; priority: string; ownerId: string | null; ownerName: string | null; agentId: string | null; relatedFiles: string[]; relatedAssets: string[]; dependsOn: number[]; branch: string | null; githubIssue: number | null; githubPr: number | null; blockedReason: string | null; completionSummary: string | null; createdBy: string | null; createdAt: string; updatedAt: string; version: number; stale: boolean }
export interface Reservation { id: string; path: string; isDirectory: boolean; developerId: string; developerName: string; agentLabel: string | null; taskId: number | null; taskTitle: string | null; reason: string; branch: string | null; createdAt: string; expiresAt: string }
export interface Activity { id: number; at: string; actorId: string | null; actorName: string | null; agentLabel: string | null; kind: string; summary: string; refType: string | null; refId: string | null; importance: number }
export interface Commit { sha: string; shortSha: string; repo: string; branch: string | null; message: string; authorName: string | null; authorLogin: string | null; developerId: string | null; url: string | null; at: string; taskId: number | null; added: string[]; modified: string[]; removed: string[] }
export interface Change { id: string; status: string; summary: string; developerId: string; developerName: string; taskId: number | null; branch: string | null; commitSha: string | null; files: string[]; assets: string[]; apisAdded: string[]; apisRemoved: string[]; apisRenamed: { from: string; to: string }[]; behaviorChanges: string[]; breakingChanges: string[]; testsPerformed: string[]; knownIssues: string[]; followUps: string[]; startedAt: string; completedAt: string | null }
export interface Message { id: number; type: string; fromDeveloperId: string; fromName: string; toDeveloperId: string | null; broadcast: boolean; subject: string | null; body: string; taskId: number | null; paths: string[]; createdAt: string; readAt: string | null; ackedAt: string | null }
export interface Decision { id: number; title: string; context: string; decision: string; reasoning: string; affectedSystems: string[]; tags: string[]; authorName: string; status: string; supersededBy: number | null; taskId: number | null; commitSha: string | null; createdAt: string }
export interface Knowledge { id: number; projectId: string | null; title: string; body: string; tags: string[]; authorName: string; updatedAt: string }
export interface TestRun { id: string; developerName: string; commitSha: string | null; branch: string | null; build: string | null; scene: string | null; description: string; status: string; errors: string[]; logs: string[]; screenshots: string[]; startedAt: string; finishedAt: string | null }
export interface Asset { path: string; type: string; name: string; description: string | null; tags: string[]; lastCommitSha: string | null; lastChangedByName: string | null; lastChangedAt: string | null; source: string }
export interface Blocker { kind: string; title: string; detail: string; at: string; refId: string }
export interface Overview { project: Project; me: Developer; team: { developer: Developer; agents: Agent[] }[]; reservations: Reservation[]; tasksInProgress: Task[]; blockers: Blocker[]; recentCommits: Commit[]; recentChanges: Change[]; activity: Activity[]; unreadMessages: number; lastTest: TestRun | null }
export interface Me { developer: Developer; scopes: string[]; projectIds: string[] | null; viaSession: boolean }
export interface ServerInfo { name: string; version: string; githubLogin: boolean; keyLogin: boolean }

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'x-collab-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data: { ok?: boolean; result?: T; error?: { code: string; message: string } } = {};
  try {
    data = await response.json();
  } catch {
    /* non-JSON */
  }
  if (!response.ok || !data.ok) throw new ApiError(data.error?.code ?? 'internal', data.error?.message ?? `Request failed (${response.status})`, response.status);
  return data.result as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  tool: <T>(name: string, args: Record<string, unknown> = {}) => request<T>('POST', `/api/tools/${name}`, args),
};
export interface CatchUp { since: string; until: string; summary: string; counts: Record<string, number> }
export interface Digest { id: number | null; from: string; to: string; summary: string; stats: Record<string, unknown>; createdAt: string | null }
export interface FileHistory {
  path: string;
  commits: { sha: string; shortSha: string; message: string; author: string | null; at: string | null; branch: string | null; taskId: number | null; url: string | null; change: string }[];
  changes: { id: string; summary: string; developerName: string; completedAt: string | null; breaking: boolean; taskId: number | null }[];
  tasks: { id: number; title: string; status: string; ownerName: string | null }[];
  reservations: Reservation[];
}
