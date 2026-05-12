import { InvalidApiTokenError, readBearer, validateApiToken } from '../auth/api-token.ts';
import {
  generateSecret,
  InvalidSessionError,
  readSessionCookie,
  verifySession,
} from '../auth/session.ts';
import { openDb } from '../repository/db.ts';
import { makeWebSocketHandler, type SocketContext } from '../ws/workspace-socket.ts';
import { createApp } from './app.ts';
import { syncFromRemote } from '../git/sekkei-git-service.ts';
import { GitClient } from '../git/git-client.ts';

const port = Number(process.env.PORT ?? 3000);
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) {
  console.warn('[glm] SESSION_SECRET is missing or short; generating an ephemeral secret');
}

const db = openDb();
const { app, deps } = createApp({
  db,
  sessionSecret: sessionSecret && sessionSecret.length >= 32 ? sessionSecret : generateSecret(),
});

const wsHandler = makeWebSocketHandler({
  events: deps.events,
  changeLog: deps.repos.changeLog,
});

/**
 * Authenticate a WS upgrade request the same way `identify()` does for HTTP:
 *   Bearer token → session cookie → x-test-user-id (when allowed).
 * Returns the (workspaceId, userId) socket context on success, or null
 * when the caller isn't authorized for that workspace.
 */
function authorizeUpgrade(req: Request, workspaceId: string): SocketContext | null {
  const workspace = deps.repos.workspaces.findById(workspaceId);
  if (!workspace) return null;

  const bearer = readBearer(req.headers.get('authorization'));
  if (bearer) {
    try {
      const row = validateApiToken(deps.repos.apiTokens, bearer, deps.clock());
      return { workspaceId, userId: row.userId };
    } catch (err) {
      if (!(err instanceof InvalidApiTokenError)) throw err;
    }
  }

  const cookie = readSessionCookie(req.headers.get('cookie'));
  if (cookie) {
    try {
      const payload = verifySession(cookie, deps.sessionSecret, deps.clock().getTime());
      return { workspaceId, userId: payload.userId };
    } catch (err) {
      if (!(err instanceof InvalidSessionError)) throw err;
    }
  }

  if (deps.allowTestAuthHeader) {
    const id = req.headers.get('x-test-user-id');
    if (id && deps.repos.users.findById(id)) return { workspaceId, userId: id };
  }
  return null;
}

const server = Bun.serve<SocketContext>({
  port,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/ws/')) {
      const workspaceId = decodeURIComponent(url.pathname.slice('/ws/'.length));
      const ctx = authorizeUpgrade(req, workspaceId);
      if (!ctx) return new Response('unauthorized', { status: 401 });
      const ok = srv.upgrade(req, { data: ctx });
      return ok ? undefined : new Response('upgrade failed', { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: wsHandler,
});

console.log(`[glm] listening on http://${server.hostname}:${server.port}`);

// Startup reconciliation: for each workspace with a git remote, check whether
// the local clone's HEAD matches the recorded commit. If not, run a sync.
// Runs synchronously after the server starts; blocking is acceptable here
// since it completes before the first user request is processed in practice.
(function reconcileGitWorkspacesOnStartup() {
  const attached = deps.repos.workspaces.listAttached();
  for (const ws of attached) {
    if (!ws.gitCloneDir || !ws.gitCommit) continue;
    try {
      const git = new GitClient({ repoPath: ws.gitCloneDir });
      const head = git.revParse('HEAD');
      if (head === ws.gitCommit) continue;
      console.log(`[glm] workspace ${ws.slug}: local HEAD diverged from recorded commit — running sync`);
      syncFromRemote(
        {
          workspaces: deps.repos.workspaces,
          workspaceConflicts: deps.repos.workspaceConflicts,
          nodes: deps.repos.nodes,
          changeLog: deps.repos.changeLog,
        },
        deps.events,
        { workspaceId: ws.id, knownCommit: ws.gitCommit, gitCloneDir: ws.gitCloneDir },
      );
    } catch (err) {
      console.warn(`[glm] startup reconciliation failed for workspace ${ws.slug}:`, err);
    }
  }
})();
