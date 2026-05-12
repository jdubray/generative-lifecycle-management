import type { User, UserRole, WorkspaceMemberRole } from '../types.ts';

/**
 * Role-based authorization gates.
 *
 * Two layers:
 *
 *   - **User role** (org-global) governs admin features (issuing tokens, viewing
 *     audit log across workspaces, etc.).
 *   - **Workspace member role** governs per-workspace actions (write nodes,
 *     approve SCRs, etc.). A user can be `editor` org-wide and still
 *     `viewer` within a particular workspace.
 *
 * Helpers below throw `ForbiddenError` so the error middleware can map it
 * straight to HTTP 403. They are deliberately verbose — the route handler
 * names the action it is gating, which makes audit logs and unit tests
 * easier to read.
 */

export class ForbiddenError extends Error {
  public readonly action: string;
  constructor(action: string) {
    super(`forbidden: ${action}`);
    this.name = 'ForbiddenError';
    this.action = action;
  }
}

const USER_ROLE_RANK: Record<UserRole, number> = {
  viewer: 0,
  reviewer: 1,
  editor: 2,
  admin: 3,
};

const MEMBER_ROLE_RANK: Record<WorkspaceMemberRole, number> = {
  viewer: 0,
  reviewer: 1,
  editor: 2,
  maintainer: 3,
  owner: 4,
};

/** True if `user.role` is at or above `min`. */
export function hasUserRole(user: User, min: UserRole): boolean {
  return USER_ROLE_RANK[user.role] >= USER_ROLE_RANK[min];
}

/** True if `member.role` is at or above `min`. */
export function hasMemberRole(role: WorkspaceMemberRole | null, min: WorkspaceMemberRole): boolean {
  if (role === null) return false;
  return MEMBER_ROLE_RANK[role] >= MEMBER_ROLE_RANK[min];
}

/** Throw `ForbiddenError(action)` unless `user` has at least `min` org role. */
export function requireUserRole(user: User, min: UserRole, action: string): void {
  if (!hasUserRole(user, min)) throw new ForbiddenError(action);
}

/** Throw `ForbiddenError(action)` unless the workspace member is at least `min`. */
export function requireMemberRole(
  memberRole: WorkspaceMemberRole | null,
  min: WorkspaceMemberRole,
  action: string,
): void {
  if (!hasMemberRole(memberRole, min)) throw new ForbiddenError(action);
}
