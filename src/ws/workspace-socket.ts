import type { ServerWebSocket } from 'bun';
import type { ChangeLogRepository } from '../repository/change-log-repository.ts';
import type { EventBus, Subscription, WorkspaceEvent } from './event-bus.ts';

/**
 * Per-workspace WebSocket fan-out. The server registers a single Bun
 * `websocket` handler with these callbacks and uses `attach()` to bind
 * each upgraded socket to its workspace channel.
 *
 * Messages from the client are JSON-framed:
 *
 *   { type: 'hello' }                    → server replies with {type:'welcome'}
 *   { type: 'replay', since: '<iso>' }   → server replays change_log rows
 *   { type: 'ping' }                     → server replies with {type:'pong'}
 *
 * Server-pushed messages share the `WorkspaceEvent` shape.
 */

export interface SocketContext {
  workspaceId: string;
  userId: string;
  /** Set in `open` and cleared in `close`. */
  subscription?: Subscription;
}

export interface SocketDeps {
  events: EventBus;
  changeLog: ChangeLogRepository;
}

export function makeWebSocketHandler(deps: SocketDeps) {
  return {
    open(ws: ServerWebSocket<SocketContext>): void {
      ws.send(JSON.stringify({ type: 'welcome', ts: new Date().toISOString() }));
      ws.data.subscription = deps.events.subscribe(ws.data.workspaceId, (event) => {
        try {
          ws.send(JSON.stringify(event));
        } catch (err) {
          // Socket was closed mid-publish; the subscription will be cleaned up on close().
          console.warn('[ws] send failed:', err);
        }
      });
    },

    message(ws: ServerWebSocket<SocketContext>, raw: string | Buffer): void {
      let msg: { type?: string; since?: string } = {};
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        ws.send(JSON.stringify({ type: 'error', reason: 'invalid_json' }));
        return;
      }

      switch (msg.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
          return;
        case 'replay': {
          const since = typeof msg.since === 'string' ? msg.since : '1970-01-01T00:00:00.000Z';
          const entries = deps.changeLog.listSince(ws.data.workspaceId, since);
          ws.send(JSON.stringify({ type: 'replay.start', count: entries.length }));
          for (const entry of entries) {
            const event: WorkspaceEvent = {
              type: 'node.changed',
              payload: entry,
              ts: entry.ts,
            };
            ws.send(JSON.stringify(event));
          }
          ws.send(JSON.stringify({ type: 'replay.end' }));
          return;
        }
        default:
          ws.send(JSON.stringify({ type: 'error', reason: 'unknown_type' }));
      }
    },

    close(ws: ServerWebSocket<SocketContext>): void {
      ws.data.subscription?.unsubscribe();
      ws.data.subscription = undefined;
    },
  };
}
