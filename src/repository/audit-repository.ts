import type { Database, Statement } from 'bun:sqlite';
import type { AuditEvent } from '../types.ts';

export interface AuditEventInsert {
  id: string;
  workspaceId: string;
  userId: string;
  eventType: string;
  payload: Record<string, unknown>;
  ts?: string;
}

/** Workspace-scoped audit feed. Every state-changing endpoint emits one row. */
export class AuditRepository {
  private readonly stInsert: Statement;
  private readonly stList: Statement;
  private readonly stListByType: Statement;

  constructor(db: Database) {
    this.stInsert = db.prepare(
      `INSERT INTO audit_events (id, workspace_id, user_id, event_type, payload_json, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stList = db.prepare(
      `SELECT id, workspace_id, user_id, event_type, payload_json, ts
       FROM audit_events WHERE workspace_id = ? ORDER BY ts DESC LIMIT ?`,
    );
    this.stListByType = db.prepare(
      `SELECT id, workspace_id, user_id, event_type, payload_json, ts
       FROM audit_events WHERE workspace_id = ? AND event_type = ? ORDER BY ts DESC LIMIT ?`,
    );
  }

  append(input: AuditEventInsert): AuditEvent {
    const ts = input.ts ?? new Date().toISOString();
    this.stInsert.run(
      input.id,
      input.workspaceId,
      input.userId,
      input.eventType,
      JSON.stringify(input.payload),
      ts,
    );
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      userId: input.userId,
      eventType: input.eventType,
      payload: input.payload,
      ts,
    };
  }

  list(workspaceId: string, limit = 100): AuditEvent[] {
    return (this.stList.all(workspaceId, limit) as AuditRow[]).map(rowToEvent);
  }

  listByType(workspaceId: string, eventType: string, limit = 100): AuditEvent[] {
    return (this.stListByType.all(workspaceId, eventType, limit) as AuditRow[]).map(rowToEvent);
  }
}

interface AuditRow {
  id: string;
  workspace_id: string;
  user_id: string;
  event_type: string;
  payload_json: string;
  ts: string;
}

function rowToEvent(r: AuditRow): AuditEvent {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    userId: r.user_id,
    eventType: r.event_type,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    ts: r.ts,
  };
}
