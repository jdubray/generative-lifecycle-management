/**
 * In-process pub/sub for workspace-scoped events.
 *
 * Producers (REST handlers, the generation pipeline, the verifier) call
 * `publish(workspaceId, event)`. Consumers (the WebSocket handler, audit
 * subscribers, tests) call `subscribe(workspaceId, handler)`.
 *
 * Synchronous fan-out: subscribers are invoked in the publisher's stack
 * before `publish` returns. Errors in one subscriber do not stop the others.
 */

export type WorkspaceEventType =
  | 'node.changed'
  | 'node.locked'
  | 'node.unlocked'
  | 'scr.created'
  | 'scr.status_changed'
  | 'scr.approval_added'
  | 'drift.detected'
  | 'drift.resolved'
  | 'generation.started'
  | 'generation.progress'
  | 'generation.complete'
  | 'git.synced'
  | 'git.conflict'
  | 'variant.published';

export interface WorkspaceEvent<P = unknown> {
  type: WorkspaceEventType;
  payload: P;
  ts: string;
}

export type WorkspaceEventHandler = (event: WorkspaceEvent) => void;

export interface Subscription {
  unsubscribe(): void;
}

export class EventBus {
  private readonly handlers = new Map<string, Set<WorkspaceEventHandler>>();

  publish(workspaceId: string, event: WorkspaceEvent): void {
    const set = this.handlers.get(workspaceId);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(event);
      } catch (err) {
        console.error(`[event-bus] handler threw for ${event.type}:`, err);
      }
    }
  }

  subscribe(workspaceId: string, handler: WorkspaceEventHandler): Subscription {
    let set = this.handlers.get(workspaceId);
    if (!set) {
      set = new Set();
      this.handlers.set(workspaceId, set);
    }
    set.add(handler);
    return {
      unsubscribe: () => {
        const current = this.handlers.get(workspaceId);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) this.handlers.delete(workspaceId);
      },
    };
  }

  /** Number of active subscribers for a workspace (for debugging / tests). */
  subscriberCount(workspaceId: string): number {
    return this.handlers.get(workspaceId)?.size ?? 0;
  }

  /** Drop all subscriptions. Used by tests between scenarios. */
  reset(): void {
    this.handlers.clear();
  }
}
