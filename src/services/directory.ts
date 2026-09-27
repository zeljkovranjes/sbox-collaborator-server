import type { DeveloperRow } from '../db/schema.js';
import { parseJson } from '../lib/json.js';
import type { Deps } from './context.js';

export interface Developer {
  id: string;
  displayName: string;
  githubLogin: string | null;
  role: 'admin' | 'member';
  projectIds: string[] | null;
  disabled: boolean;
  discordUserId: string | null;
}

/** Small cached directory of developers and GitHub logins (a team is a handful of people). */
export class Directory {
  #byId = new Map<string, Developer>();
  #byLogin = new Map<string, Developer>();
  #loadedAt = 0;

  constructor(private readonly deps: Deps) {}

  invalidate(): void {
    this.#loadedAt = 0;
  }

  async #ensure(): Promise<void> {
    if (this.#loadedAt && this.deps.clock.now() - this.#loadedAt < 60_000) return;
    const rows = await this.deps.db.selectFrom('developers').selectAll().execute();
    this.#byId.clear();
    this.#byLogin.clear();
    for (const row of rows) {
      const developer = toDeveloper(row);
      this.#byId.set(developer.id, developer);
      if (developer.githubLogin) this.#byLogin.set(developer.githubLogin.toLowerCase(), developer);
    }
    this.#loadedAt = this.deps.clock.now();
  }

  async get(id: string | null | undefined): Promise<Developer | null> {
    if (!id) return null;
    await this.#ensure();
    return this.#byId.get(id) ?? null;
  }

  async name(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    return (await this.get(id))?.displayName ?? id;
  }

  async byGithubLogin(login: string | null | undefined): Promise<Developer | null> {
    if (!login) return null;
    await this.#ensure();
    return this.#byLogin.get(login.toLowerCase()) ?? null;
  }

  async all(): Promise<Developer[]> {
    await this.#ensure();
    return [...this.#byId.values()];
  }
}

export function toDeveloper(row: DeveloperRow): Developer {
  return {
    id: row.id,
    displayName: row.displayName,
    githubLogin: row.githubLogin,
    role: row.role,
    projectIds: parseJson<string[] | null>(row.projectIds, null),
    disabled: row.disabledAt != null,
    discordUserId: row.discordUserId ?? null,
  };
}
