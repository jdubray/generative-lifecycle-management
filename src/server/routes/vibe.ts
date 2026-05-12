import { Hono } from 'hono';
import { classifyIntent } from '../../agent/intent.ts';
import {
  archiveClarifier,
  archiveSubmitted,
  driftHealed,
  driftPromote,
  FORMAL_GATE_INVARIANTS,
  multiRun,
  SCRIPTS,
  SUGGESTIONS,
  type Card,
  type ScenarioKey,
} from '../../agent/scripts.ts';
import { type AppEnv, requirePrincipal } from '../middleware/auth.ts';
import { httpError } from '../middleware/error.ts';

/**
 * Vibe Mode endpoints (spec §5.10).
 *
 *   GET  /vibe/scripts        → full scenario catalog + suggestions + invariants
 *   POST /vibe/intent         → { message } → { scenario, reason }
 *   POST /vibe/continue       → { scenario, kind, payload } → next set of cards
 *   POST /vibe/llm-fallback   → freeform `{ message }` → text reply (or canned
 *                                "model unreachable" message per AC-40)
 *
 * No endpoint here *executes* any gate. Cards may carry `link.tab` / `gate`
 * actions that the frontend turns into regular REST calls — those endpoints
 * (POST /scrs, PUT /drift/.../resolve, etc.) own gate enforcement.
 */
export function vibeRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/vibe/scripts', (c) => {
    requirePrincipal(c);
    return c.json({
      suggestions: SUGGESTIONS,
      scripts: SCRIPTS,
      invariants: FORMAL_GATE_INVARIANTS,
    });
  });

  app.post('/vibe/intent', async (c) => {
    requirePrincipal(c);
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };
    if (typeof body.message !== 'string') throw httpError(400, 'message is required');
    return c.json(classifyIntent(body.message));
  });

  app.post('/vibe/continue', async (c) => {
    requirePrincipal(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      scenario?: ScenarioKey;
      kind?: 'clarifier' | 'gate' | 'choice';
      payload?: Record<string, unknown>;
    };
    if (!body.scenario) throw httpError(400, 'scenario is required');
    if (!body.kind) throw httpError(400, 'kind is required');
    let cards: Card[];
    try {
      cards = continueScenario(body.scenario, body.kind, body.payload ?? {});
    } catch (err) {
      throw httpError(400, (err as Error).message);
    }
    return c.json({ cards });
  });

  app.post('/vibe/llm-fallback', async (c) => {
    requirePrincipal(c);
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };
    if (typeof body.message !== 'string') throw httpError(400, 'message is required');

    const llm = c.var.deps.llm;
    if (!llm) {
      // AC-40: graceful degradation — return a canned reply, don't crash.
      return c.json({
        text: "I can't reach the model right now. Try one of the scripted suggestions to see the full flow.",
        reachable: false,
      });
    }
    try {
      const reply = await llm.generate({
        system:
          'You are the Puffin GLM agent. Respond in 2-3 short sentences. Name the relevant lifecycle process and the next step. Never claim to execute — only describe.',
        prompt: body.message,
        maxTokens: 256,
      });
      return c.json({ text: reply.text.trim(), reachable: true });
    } catch (err) {
      return c.json({
        text: "I can't reach the model right now. Try one of the scripted suggestions to see the full flow.",
        reachable: false,
        error: (err as Error).message,
      });
    }
  });

  return app;
}

/**
 * Continuation dispatcher — pure function with no I/O. Returns the next
 * batch of cards for a scenario based on which control the user clicked.
 */
function continueScenario(
  scenario: ScenarioKey,
  kind: 'clarifier' | 'gate' | 'choice',
  payload: Record<string, unknown>,
): Card[] {
  if (scenario === 'archive') {
    if (kind === 'clarifier') {
      const choice = String(payload.choice ?? 'a');
      if (choice !== 'a' && choice !== 'b' && choice !== 'c') {
        throw new Error(`unknown archive choice '${choice}'`);
      }
      return archiveClarifier(choice);
    }
    if (kind === 'gate') {
      const action = String(payload.action ?? '');
      if (action === 'submit') {
        const scrId = String(payload.scrId ?? 'SCR-2090');
        return archiveSubmitted({ id: scrId });
      }
      return [
        {
          kind: 'agent_text',
          body:
            action === 'cancel'
              ? 'Cancelled. Nothing was written.'
              : "Holding — I'll wait for you to make adjustments. Re-run the suggestion when you're ready.",
        },
      ];
    }
  }
  if (scenario === 'multi') {
    if (kind === 'gate') {
      const action = String(payload.action ?? '');
      if (action === 'run') return multiRun();
      return [
        {
          kind: 'agent_text',
          body:
            action === 'window'
              ? "Scheduled for the next deploy window. I'll emit provenance when it lands."
              : 'Holding. The lock has been written but no regen will run.',
        },
      ];
    }
  }
  if (scenario === 'drift') {
    if (kind === 'choice') {
      const optId = String(payload.choice ?? '');
      const scrId = String(payload.scrId ?? 'SCR-2091');
      if (optId === 'promote') return driftPromote({ id: scrId });
      if (optId === 'heal') return driftHealed();
      return [
        {
          kind: 'agent_text',
          body:
            'Waiver issued. The sweep will skip this file until the duration elapses. Audit logged.',
        },
      ];
    }
  }
  if (scenario === 'promote') {
    if (kind === 'gate') {
      const action = String(payload.action ?? '');
      if (action === 'open') {
        return [
          {
            kind: 'result',
            title: 'Promotion SCR drafted',
            lines: [
              'I\'ve opened a Class I SCR pre-filled with the subtree root.',
              'Approval still goes through platform-review (AC-30).',
            ],
            link: { label: 'Open in Change Management →', tab: 'changes' },
          },
        ];
      }
      return [{ kind: 'agent_text', body: 'Cancelled. Nothing was written.' }];
    }
  }
  return [
    { kind: 'agent_text', body: 'Nothing to continue for that combination.' },
  ];
}
