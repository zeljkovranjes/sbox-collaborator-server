import { EventEmitter } from 'node:events';

export const EVENT_TYPES = [
  'agent_registered',
  'agent_status_changed',
  'agent_offline',
  'task_created',
  'task_claimed',
  'task_updated',
  'task_completed',
  'file_reserved',
  'file_released',
  'reservation_expired',
  'change_started',
  'change_completed',
  'change_abandoned',
  'message_received',
  'commit_detected',
  'branch_updated',
  'pull_request_updated',
  'issue_updated',
  'decision_created',
  'decision_superseded',
  'knowledge_added',
  'test_started',
  'test_result',
  'build_broken',
  'asset_changed',
  'project_updated',
  'activity',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface CollabEvent {
  type: EventType;
  projectId: string;
  at: string;
  actor: { developerId: string | null; agentId: string | null };
  data: unknown;
  /** When set, only these developers receive the event (direct messages). */
  audience?: string[];
}

/** In-process fan-out of realtime events (SSE subscribers, the MCP notice system). */
export class EventBus {
  #emitter = new EventEmitter();

  constructor() {
    this.#emitter.setMaxListeners(0);
  }

  emit(event: CollabEvent): void {
    this.#emitter.emit('event', event);
  }

  subscribe(listener: (event: CollabEvent) => void): () => void {
    this.#emitter.on('event', listener);
    return () => this.#emitter.off('event', listener);
  }

  get listenerCount(): number {
    return this.#emitter.listenerCount('event');
  }
}
