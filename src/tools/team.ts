import * as z from 'zod';
import { DECISION_STATUSES } from '../services/decisions.js';
import { MESSAGE_TYPES } from '../services/messages.js';
import { SUGGESTED_TAGS } from '../services/knowledge.js';
import { parseSince } from '../lib/time.js';
import { defineTool, limitArg, projectOf, sinceArg } from './registry.js';

const project = z.string().max(48).optional();
const list = (max = 40) => z.array(z.string().max(400)).max(max).optional();

const decisionFields = {
  title: z.string().min(1).max(200),
  context: z.string().min(1).max(4000).describe('The situation / problem'),
  decision: z.string().min(1).max(4000).describe('What was decided'),
  reasoning: z.string().min(1).max(4000).describe('Why'),
  affectedSystems: z.array(z.string().max(80)).max(20).optional().describe('e.g. ["networking", "BoatController", "OceanSystem"]'),
  tags: z.array(z.string().max(40)).max(12).optional(),
  taskId: z.number().int().positive().optional(),
  commitSha: z.string().max(64).optional(),
  status: z.enum(['proposed', 'accepted']).optional(),
};

export const changeTools = [
  defineTool({
    name: 'change_start',
    title: 'Announce change start',
    description: 'Announce that you started a meaningful change (shows as "in progress" to teammates). Returns changeId for change_complete.',
    scope: 'write',
    core: true,
    input: { project, summary: z.string().min(1).max(300), taskId: z.number().int().positive().optional(), branch: z.string().max(200).optional(), files: list(200) },
    handler: async (ctx, a) => ctx.services.changes.start(ctx.actor, { ...a, project: await projectOf(ctx, a.project) }),
  }),
  defineTool({
    name: 'change_complete',
    title: 'Announce completed change',
    description:
      'Publish a structured summary when meaningful work is done. It lands in every teammate’s next sync. Include files, APIs added/removed/renamed, behavior and BREAKING changes, tests performed, known issues and follow-ups.',
    scope: 'write',
    core: true,
    input: {
      changeId: z.string().max(40).optional(),
      project,
      summary: z.string().min(1).max(600),
      taskId: z.number().int().positive().optional(),
      branch: z.string().max(200).optional(),
      commitSha: z.string().max(64).optional(),
      files: list(300),
      assets: list(300),
      apisAdded: list(),
      apisRemoved: list(),
      apisRenamed: z.array(z.object({ from: z.string().max(200), to: z.string().max(200) })).max(40).optional(),
      behaviorChanges: list(),
      breakingChanges: list(),
      testsPerformed: list(),
      knownIssues: list(),
      followUps: list(),
    },
    handler: async (ctx, a) => ctx.services.changes.complete(ctx.actor, a.changeId ? a : { ...a, project: await projectOf(ctx, a.project) }),
  }),
  defineTool({
    name: 'change_abandon',
    title: 'Abandon change',
    description: 'Mark a started change as abandoned, with the reason.',
    scope: 'write',
    input: { changeId: z.string().min(1).max(40), reason: z.string().min(1).max(600) },
    handler: (ctx, a) => ctx.services.changes.abandon(ctx.actor, a.changeId, a.reason),
  }),
];

export const decisionTools = [
  defineTool({
    name: 'decision_create',
    title: 'Record decision',
    description: 'Record a lasting technical decision (architecture, networking authority, shared systems). Agents consult these before changing affected systems.',
    scope: 'write',
    core: true,
    input: { project, ...decisionFields },
    handler: async (ctx, a) => ctx.services.decisions.create(ctx.actor, { ...a, project: await projectOf(ctx, a.project) }),
  }),
  defineTool({
    name: 'decision_list',
    title: 'List decisions',
    description: 'Decisions, ranked by relevance to query (e.g. the system or files you will touch). Check before modifying a system.',
    scope: 'read',
    core: true,
    input: { project, query: z.string().max(500).optional(), system: z.string().max(80).optional(), status: z.enum(DECISION_STATUSES).optional(), limit: limitArg(100) },
    handler: async (ctx, a) => {
      const { project: p, ...filter } = a;
      return ctx.services.decisions.list(ctx.actor, await projectOf(ctx, p), filter);
    },
  }),
  defineTool({
    name: 'decision_get',
    title: 'Get decision',
    description: 'One decision in full.',
    scope: 'read',
    input: { decisionId: z.number().int().positive() },
    handler: (ctx, a) => ctx.services.decisions.get(ctx.actor, a.decisionId),
  }),
  defineTool({
    name: 'decision_supersede',
    title: 'Supersede decision',
    description: 'Replace a decision with a new one (the old one is kept, marked superseded).',
    scope: 'write',
    input: { decisionId: z.number().int().positive(), newDecision: z.object(decisionFields), reason: z.string().min(1).max(1000) },
    handler: (ctx, a) => ctx.services.decisions.supersede(ctx.actor, a.decisionId, a.newDecision, a.reason),
  }),
];

const messageFields = {
  project,
  type: z.enum(MESSAGE_TYPES),
  body: z.string().min(1).max(1000),
  subject: z.string().max(120).optional(),
  taskId: z.number().int().positive().optional(),
  paths: z.array(z.string().max(512)).max(20).optional(),
};

export const messageTools = [
  defineTool({
    name: 'message_send',
    title: 'Send message',
    description:
      'Send a short structured message to a developer (id) or agent (ag_…). Types: info, question, warning, blocker, request, handoff. Only when it matters – status belongs in agent_set_status, results in change_complete. Do not reply to info messages.',
    scope: 'write',
    core: true,
    input: { to: z.string().min(1).max(60), ...messageFields },
    handler: async (ctx, a) => ctx.services.messages.send(ctx.actor, { ...a, project: await projectOf(ctx, a.project) }),
  }),
  defineTool({
    name: 'message_broadcast',
    title: 'Broadcast message',
    description: 'Message the whole team (e.g. a warning that main is broken). Use sparingly.',
    scope: 'write',
    input: messageFields,
    handler: async (ctx, a) => ctx.services.messages.send(ctx.actor, { ...a, to: null, project: await projectOf(ctx, a.project) }),
  }),
  defineTool({
    name: 'message_get_unread',
    title: 'Unread messages',
    description: 'Messages waiting for you. info/warning are marked read when fetched; question/request/blocker/handoff stay until message_acknowledge.',
    scope: 'read',
    core: true,
    input: { project, markRead: z.boolean().optional() },
    handler: async (ctx, a) => {
      const projects = a.project || ctx.agent ? [await projectOf(ctx, a.project)] : (await ctx.services.projects.list(ctx.actor)).map((p) => p.id);
      return ctx.services.messages.unread(ctx.actor, projects, { markRead: a.markRead ?? true });
    },
  }),
  defineTool({
    name: 'message_acknowledge',
    title: 'Acknowledge messages',
    description: 'Acknowledge messages you have handled.',
    scope: 'write',
    core: true,
    input: { messageIds: z.array(z.number().int().positive()).min(1).max(100) },
    handler: (ctx, a) => ctx.services.messages.acknowledge(ctx.actor, a.messageIds),
  }),
];

export const knowledgeTools = [
  defineTool({
    name: 'knowledge_add',
    title: 'Add knowledge',
    description: `Save durable project knowledge (engine facts, gotchas, workarounds). Omit project for team-wide knowledge. Suggested tags: ${SUGGESTED_TAGS.join(', ')}.`,
    scope: 'write',
    core: true,
    input: { project, title: z.string().min(1).max(200), body: z.string().min(1).max(6000), tags: z.array(z.string().max(40)).max(12).optional() },
    handler: (ctx, a) => ctx.services.knowledge.add(ctx.actor, a),
  }),
  defineTool({
    name: 'knowledge_search',
    title: 'Search knowledge',
    description: 'Search team knowledge (project + global), ranked by relevance.',
    scope: 'read',
    core: true,
    input: { project, query: z.string().max(500).optional(), tags: z.array(z.string().max(40)).max(12).optional(), limit: limitArg(50) },
    handler: async (ctx, a) => ctx.services.knowledge.search(ctx.actor, { ...a, ...(a.project || ctx.agent ? { project: await projectOf(ctx, a.project) } : {}) }),
  }),
  defineTool({
    name: 'knowledge_update',
    title: 'Update knowledge',
    description: 'Correct, retag or archive a knowledge entry.',
    scope: 'write',
    input: { knowledgeId: z.number().int().positive(), title: z.string().min(1).max(200).optional(), body: z.string().min(1).max(6000).optional(), tags: z.array(z.string().max(40)).max(12).optional(), archived: z.boolean().optional() },
    handler: (ctx, a) => {
      const { knowledgeId, ...patch } = a;
      return ctx.services.knowledge.update(ctx.actor, knowledgeId, patch);
    },
  }),
];

const testFields = { commitSha: z.string().max(64).optional(), branch: z.string().max(200).optional(), build: z.string().max(200).optional(), scene: z.string().max(300).optional().describe('Map or scene tested') };

export const testTools = [
  defineTool({
    name: 'test_start',
    title: 'Start test',
    description: 'Record that a build/playtest started. Returns testId for test_result.',
    scope: 'write',
    input: { project, description: z.string().min(1).max(400), ...testFields },
    handler: async (ctx, a) => ctx.services.tests.start(ctx.actor, { ...a, project: await projectOf(ctx, a.project) }),
  }),
  defineTool({
    name: 'test_result',
    title: 'Record test result',
    description: 'Record a build/test result (passed, failed, error) with errors and log/screenshot references. A failure on a commit warns the whole team.',
    scope: 'write',
    core: true,
    input: {
      testId: z.string().max(40).optional(),
      project,
      description: z.string().max(400).optional(),
      status: z.enum(['passed', 'failed', 'error']),
      errors: z.array(z.string().max(1000)).max(30).optional(),
      logs: z.array(z.string().max(500)).max(20).optional(),
      screenshots: z.array(z.string().max(500)).max(20).optional(),
      ...testFields,
    },
    handler: async (ctx, a) => ctx.services.tests.result(ctx.actor, a.testId ? a : { ...a, project: await projectOf(ctx, a.project) }),
  }),
  defineTool({
    name: 'test_get_recent',
    title: 'Recent tests',
    description: 'Recent build/test results, optionally for one branch or commit.',
    scope: 'read',
    input: { project, branch: z.string().max(200).optional(), commitSha: z.string().max(64).optional(), limit: limitArg(100) },
    handler: async (ctx, a) => {
      const { project: p, ...filter } = a;
      return ctx.services.tests.recent(ctx.actor, await projectOf(ctx, p), filter);
    },
  }),
];

export const activityTools = [
  defineTool({
    name: 'activity_recent',
    title: 'Activity feed',
    description: 'The team activity feed (newest first). minImportance 2 shows only notable events (blockers, completions, breaking changes, failures).',
    scope: 'read',
    core: true,
    input: { project, limit: limitArg(200), since: sinceArg, minImportance: z.number().int().min(0).max(3).optional() },
    handler: async (ctx, a) => {
      const since = parseSince(a.since, ctx.services.deps.clock.now());
      return ctx.services.activity.recent(await projectOf(ctx, a.project), {
        limit: a.limit ?? 30,
        ...(since ? { since } : {}),
        ...(a.minImportance !== undefined ? { minImportance: a.minImportance } : {}),
      });
    },
  }),
];
