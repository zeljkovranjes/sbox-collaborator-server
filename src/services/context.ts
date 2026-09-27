import type { Config } from '../config.js';
import type { DatabaseHandle, Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { forbidden } from '../lib/errors.js';
import type { KeyedMutex } from '../lib/mutex.js';
import type { Clock } from '../lib/time.js';

export type Scope = 'read' | 'write' | 'admin';

/** Who is calling: an authenticated developer, through a key or a web session, maybe as an agent. */
export interface Actor {
  developerId: string;
  displayName: string;
  role: 'admin' | 'member';
  keyId: string | null;
  scopes: Scope[];
  /** Projects this caller may touch; null = all. */
  projectIds: string[] | null;
  agentId: string | null;
}

export interface Deps {
  db: Db;
  database: DatabaseHandle;
  config: Config;
  bus: EventBus;
  clock: Clock;
  locks: KeyedMutex;
}

export function hasScope(actor: Actor, scope: Scope): boolean {
  if (actor.scopes.includes('admin')) return true;
  if (scope === 'read') return actor.scopes.includes('read') || actor.scopes.includes('write');
  return actor.scopes.includes(scope);
}

export function requireScope(actor: Actor, scope: Scope): void {
  if (!hasScope(actor, scope)) {
    throw forbidden(scope === 'write' ? 'This access key is read-only.' : `This action needs the "${scope}" scope.`);
  }
}

export function canAccessProject(actor: Actor, projectId: string): boolean {
  return actor.projectIds === null || actor.projectIds.includes(projectId);
}

export function requireProjectAccess(actor: Actor, projectId: string): void {
  if (!canAccessProject(actor, projectId)) throw forbidden(`No access to project "${projectId}".`);
}

/** Intersection of two optional allow-lists (null = everything). */
export function intersectProjects(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.filter((id) => b.includes(id));
}
