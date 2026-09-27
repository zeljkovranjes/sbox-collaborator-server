import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { setLogLevel } from './lib/log.js';
import type { Scope } from './services/context.js';
import { createServices } from './services/index.js';
import { SYSTEM } from './services/projects.js';

const HELP = `Collaborator server admin CLI

  developer add <id> --name "Name" [--github login] [--admin]
  developer list
  developer disable <id>

  server-key create --name "for Alex" [--github login] [--uses 1] [--days 14] [--admin]
  server-key list
  server-key revoke <id>

  key create <developerId> --name "desktop claude-code" [--scopes read,write] [--projects a,b] [--days 90]
  key list [developerId]
  key revoke <keyId>

  project create <id> --name "Sailing" --kind game|library|tool [--repo owner/name] [--branch main] [--ident org.ident]
  project list

In Docker: docker compose exec server node dist/src/cli.js <command>`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

const str = (value: string | true | undefined) => (typeof value === 'string' ? value : undefined);
const num = (value: string | true | undefined) => (typeof value === 'string' ? Number(value) : undefined);
const csv = (value: string | true | undefined) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [group, action, target] = positional;
  if (!group || flags.help) {
    console.log(HELP);
    return;
  }
  const config = loadConfig();
  setLogLevel('warn');
  const database = await openDatabase(config.database);
  const s = createServices({ config, database });
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  try {
    switch (`${group} ${action ?? ''}`.trim()) {
      case 'developer add': {
        if (!target || !str(flags.name)) throw new Error('usage: developer add <id> --name "Name" [--github login] [--admin]');
        print(await s.accounts.createDeveloper({ id: target, displayName: str(flags.name)!, githubLogin: str(flags.github) ?? null, role: flags.admin ? 'admin' : 'member' }));
        break;
      }
      case 'developer list':
        print(await s.accounts.listDevelopers());
        break;
      case 'developer disable':
        if (!target) throw new Error('usage: developer disable <id>');
        print(await s.accounts.updateDeveloper(target, { disabled: true }));
        break;
      case 'server-key create': {
        const { token, key } = await s.accounts.createJoinKey({
          name: str(flags.name) ?? 'server key',
          githubLogin: str(flags.github) ?? null,
          maxUses: num(flags.uses) ?? 1,
          ...(num(flags.days) ? { expiresInDays: num(flags.days)! } : {}),
          role: flags.admin ? 'admin' : 'member',
        });
        print(key);
        console.log(`\nServer key (shown once – send it privately, never commit it):\n\n  ${token}\n`);
        break;
      }
      case 'server-key list':
        print(await s.accounts.listJoinKeys());
        break;
      case 'server-key revoke':
        if (!target) throw new Error('usage: server-key revoke <id>');
        print(await s.accounts.revokeJoinKey(target));
        break;
      case 'key create': {
        if (!target) throw new Error('usage: key create <developerId> --name "…"');
        const { token, key } = await s.accounts.createAccessKey(target, {
          name: str(flags.name) ?? 'cli key',
          scopes: (csv(flags.scopes) as Scope[] | undefined) ?? ['write'],
          projectIds: csv(flags.projects) ?? null,
          via: 'cli',
          expiresInDays: num(flags.days) ?? null,
        });
        print(key);
        console.log(`\nAccess key (shown once – keep it out of git):\n\n  ${token}\n`);
        break;
      }
      case 'key list':
        print(await s.accounts.listAccessKeys(target));
        break;
      case 'key revoke':
        if (!target) throw new Error('usage: key revoke <keyId>');
        print(await s.accounts.revokeAccessKey(SYSTEM, target));
        break;
      case 'project create': {
        const kind = str(flags.kind) ?? 'game';
        if (!target || !str(flags.name) || !['game', 'library', 'tool'].includes(kind)) throw new Error('usage: project create <id> --name "Name" --kind game|library|tool');
        print(
          await s.projects.create(null, {
            id: target,
            name: str(flags.name)!,
            kind: kind as 'game' | 'library' | 'tool',
            repos: csv(flags.repo) ?? [],
            ...(str(flags.branch) ? { defaultBranch: str(flags.branch)! } : {}),
            packageIdent: str(flags.ident) ?? null,
          }),
        );
        break;
      }
      case 'project list':
        print(await s.projects.list(SYSTEM));
        break;
      default:
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}

void main();
