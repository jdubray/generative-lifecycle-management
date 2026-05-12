/**
 * Vibe Mode scripted scenarios (spec §5.10).
 *
 * Each scenario is a list of "cards" + console streams. The frontend renders
 * cards one at a time; when the user clicks a clarifier / gate / choice
 * button, the appropriate continuation is fetched and appended. Cards that
 * end in `action: "...api..."` correspond to a real REST call the frontend
 * makes against the regular backend — Vibe never bypasses a gate (see
 * `formalGateInvariants` below).
 */

export type ScenarioKey = 'archive' | 'multi' | 'drift' | 'promote';

export type CardKind =
  | 'agent_text'
  | 'plan'
  | 'console'
  | 'clarifier'
  | 'scr_draft'
  | 'drift_card'
  | 'choice'
  | 'gate'
  | 'resolution_card'
  | 'result';

export interface PlanStep {
  id: string;
  proc: string;
  text: string;
  status: 'pending' | 'running' | 'done';
}

export interface ScrDraftCard {
  kind: 'scr_draft';
  scrId: string;
  scrClass: 'I' | 'II';
  title: string;
  targets: string[];
  diff: Array<{ line: string; kind: 'add' | 'del' | 'hunk' | 'context' }>;
  impact: { variants: number; tokens: number; cacheMisses: number };
}

export interface GateCard {
  kind: 'gate';
  label: string;
  detail?: string;
  actions: Array<{ id: string; label: string; variant: 'primary' | 'default' | 'ghost' }>;
}

export interface ClarifierCard {
  kind: 'clarifier';
  question: string;
  options: Array<{ id: string; label: string }>;
}

export interface ChoiceCard {
  kind: 'choice';
  options: Array<{ id: string; label: string; subtitle: string }>;
}

export interface ConsoleCard {
  kind: 'console';
  stream: string[];
}

export interface AgentTextCard {
  kind: 'agent_text';
  body: string;
}

export interface PlanCard {
  kind: 'plan';
  title: string;
  steps: PlanStep[];
  tone?: 'info' | 'warn';
}

export interface DriftSummaryCard {
  kind: 'drift_card';
  node: string;
  file: string;
  detail: string;
}

export interface ResolutionCard {
  kind: 'resolution_card';
  target: string;
  ok: boolean;
  designHash: string;
  generationHash: string;
  pins: number;
  misses: number;
}

export interface ResultCard {
  kind: 'result';
  title: string;
  lines: string[];
  link?: { label: string; tab: 'changes' | 'drift' | 'variants' | 'reuse' | 'provenance' };
}

export type Card =
  | AgentTextCard
  | PlanCard
  | ConsoleCard
  | ClarifierCard
  | ScrDraftCard
  | GateCard
  | ChoiceCard
  | DriftSummaryCard
  | ResolutionCard
  | ResultCard;

export const SUGGESTIONS = [
  {
    key: 'archive' as ScenarioKey,
    text: 'Add a way to archive todos instead of deleting them',
    hint: 'Class I SCR · adds new interaction + spec',
  },
  {
    key: 'multi' as ScenarioKey,
    text: 'Spin up a team variant with multi-user + Postgres',
    hint: 'Variant resolution · derives-from override',
  },
  {
    key: 'drift' as ScenarioKey,
    text: 'Reconcile the live-state drift on todo_rest_api',
    hint: 'Drift reconciliation · capture as SCR',
  },
  {
    key: 'promote' as ScenarioKey,
    text: 'Promote the filter engine subtree to a shared library',
    hint: 'Reuse · Candidate → Promoted',
  },
];

/**
 * Formal gate invariants that the agent MUST respect. The server enforces
 * them via the existing endpoints (SCR FSM, drift waiver duration, etc.);
 * the agent never has a path to bypass them.
 */
export const FORMAL_GATE_INVARIANTS = [
  'Class I SCRs always route to platform-review for approval; the agent cannot self-approve.',
  'auto-heal on live-state drift is only executed if the node\'s configured policy is auto-heal.',
  'Waivers always carry a positive duration and produce an audit_event.',
  'The agent may draft, propose, and submit — but never transition Under Review → Approved unilaterally.',
];

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export const SCRIPTS: Record<ScenarioKey, Card[]> = {
  archive: [
    {
      kind: 'agent_text',
      body:
        '"Archive instead of delete" is a contract change — it adds state to a todo and changes how list filters behave. Here\'s the plan:',
    },
    {
      kind: 'plan',
      title: 'Proposed lifecycle path',
      tone: 'info',
      steps: [
        { id: '1', proc: 'Where-Used', text: 'Locate consumers of todo_management', status: 'pending' },
        { id: '2', proc: 'Sekkei edit', text: 'Add archive state + an interaction for archive/unarchive', status: 'pending' },
        { id: '3', proc: 'Change Mgmt', text: 'Open Class I SCR targeting the new interaction + filter_engine', status: 'pending' },
        { id: '4', proc: 'Variant Res.', text: 'Re-resolve glm:web.todomvc and glm:web.todomvc.team', status: 'pending' },
        { id: '5', proc: 'Provenance', text: 'Emit signed Statement once the artifact regenerates', status: 'pending' },
      ],
    },
    { kind: 'agent_text', body: 'Before I proceed, one question:' },
    {
      kind: 'clarifier',
      question:
        'Should archived todos count toward the "active" filter? My read of the existing filter_engine constraint is no — but this is a contract decision.',
      options: [
        { id: 'a', label: 'Hidden from all filters except "archived"' },
        { id: 'b', label: 'Visible in "all", hidden everywhere else' },
        { id: 'c', label: 'Always visible, dimmed' },
      ],
    },
  ],

  multi: [
    {
      kind: 'agent_text',
      body:
        'That\'s a variant resolution, not a sekkei edit. The .team variant already exists with multi_user=true, persistence=postgres_pool. Let me re-resolve it.',
    },
    {
      kind: 'console',
      stream: [
        'vibe › intent = variant_resolution(target=glm:web.todomvc.team)',
        'graph › loading variant binding…',
        'graph › derives-from chain: glm:web.todomvc.team → glm:web.todomvc @ A.0',
        'binding › multi_user=true, persistence=postgres_pool, undo_seconds=10',
      ],
    },
    {
      kind: 'plan',
      title: 'Re-resolving variant glm:web.todomvc.team',
      steps: [
        { id: '1', proc: 'Closure walk', text: 'Walk composes-of from root + apply overrides', status: 'pending' },
        { id: '2', proc: 'Parameter binding', text: 'Bind 6 parameters along the path', status: 'pending' },
        { id: '3', proc: 'Constraint val.', text: 'Evaluate 4 constraints', status: 'pending' },
        { id: '4', proc: 'Cache check', text: 'Probe generation cache', status: 'pending' },
        { id: '5', proc: 'Lock emit', text: 'Write sekkei.lock + propose dBOM update', status: 'pending' },
      ],
    },
    {
      kind: 'gate',
      label: 'Run the resolve now?',
      actions: [
        { id: 'run', label: 'Run resolve', variant: 'primary' },
        { id: 'cancel', label: 'Cancel', variant: 'ghost' },
      ],
    },
  ],

  drift: [
    {
      kind: 'agent_text',
      body:
        'Pulling the latest drift sweep. todo_rest_api shows live-state drift: someone hand-edited apps/todomvc/src/routes/todos.ts to add request-id logging that isn\'t in the sekkei.',
    },
    {
      kind: 'drift_card',
      node: 'glm:web.todomvc.todo_management.todo_rest_api',
      file: 'apps/todomvc/src/routes/todos.ts',
      detail:
        'Three lines added in handler chain — middleware that stamps an x-request-id and logs it. Not malicious; looks like a 2am debug session that survived.',
    },
    {
      kind: 'agent_text',
      body:
        'You have three legitimate paths. The policy on this node is currently alert (not auto-heal), so I won\'t overwrite without your call:',
    },
    {
      kind: 'choice',
      options: [
        {
          id: 'promote',
          label: 'Capture the edit as a new SCR',
          subtitle:
            'Promote the hand-edit into the sekkei. Becomes a Class II change. Future regens preserve it.',
        },
        {
          id: 'heal',
          label: 'Auto-heal (overwrite the file)',
          subtitle: 'Drop the live edit; regenerate from the current sekkei. Loses the logging.',
        },
        {
          id: 'waiver',
          label: 'Issue a deviation/waiver',
          subtitle: 'Suspend reconciliation on this file for a stated period. Audited.',
        },
      ],
    },
  ],

  promote: [
    {
      kind: 'agent_text',
      body:
        'Promotion is a reuse-stage transition. The subtree must already be at Candidate-for-Promotion and have a named steward (AC-30 enforces this server-side).',
    },
    {
      kind: 'plan',
      title: 'Promotion lifecycle',
      steps: [
        { id: '1', proc: 'Where-Used', text: 'Confirm subtree has ≥ 2 adopters', status: 'pending' },
        { id: '2', proc: 'Reuse', text: 'Assign a steward', status: 'pending' },
        { id: '3', proc: 'Change Mgmt', text: 'Open a Class I promotion SCR', status: 'pending' },
        { id: '4', proc: 'Reuse', text: 'Advance stage to Promoted-to-Library', status: 'pending' },
      ],
    },
    {
      kind: 'gate',
      label: 'Open promotion SCR?',
      detail: 'I\'ll pre-fill a Class I SCR targeting the subtree root. Approval is still on platform-review.',
      actions: [
        { id: 'open', label: 'Open promotion SCR', variant: 'primary' },
        { id: 'cancel', label: 'Cancel', variant: 'ghost' },
      ],
    },
  ],
};

export function archiveClarifier(choice: 'a' | 'b' | 'c'): Card[] {
  const constraint =
    choice === 'a'
      ? '+constraint: archived_excluded_unless_filter_eq_archived'
      : choice === 'b'
        ? '+constraint: archived_visible_only_when_filter_eq_all_or_archived'
        : '+constraint: archived_always_visible_dimmed_in_ui';
  return [
    { kind: 'agent_text', body: 'Good. I\'ll encode that as a constraint on filter_engine and proceed.' },
    {
      kind: 'console',
      stream: [
        `vibe › clarifier resolved: archive_visibility = ${choice}`,
        'graph › where-used(todo_management.todo_data) → 3 direct + 4 transitive consumers',
        'edit › drafting new interaction glm:web.todomvc.todo_management.todo_archive',
        'edit › drafting new spec todo_archive.code_recipe',
        'edit › patching filter_engine.todo_filter_spec — add archived to filter_value enum',
        'hash › computed content-hash for 3 new/changed nodes',
      ],
    },
    {
      kind: 'scr_draft',
      scrId: 'SCR-2090',
      scrClass: 'I',
      title: 'Add archive lifecycle to todos',
      targets: [
        'glm:web.todomvc.todo_management.todo_data',
        'glm:web.todomvc.todo_management.todo_archive  (new)',
        'glm:web.todomvc.todo_management.todo_filter_engine',
      ],
      diff: [
        { line: '@@ glm:web.todomvc.todo_management.todo_data:body', kind: 'hunk' },
        { line: ' title: string', kind: 'context' },
        { line: ' completed: boolean', kind: 'context' },
        { line: '+archived: boolean = false', kind: 'add' },
        { line: '+archived_at: timestamp? = null', kind: 'add' },
        { line: '@@ + new glm:web.todomvc.todo_management.todo_archive', kind: 'hunk' },
        { line: '+stratum: interaction', kind: 'add' },
        { line: '+contract_kind: fsm', kind: 'add' },
        { line: '+states: [active, archived]', kind: 'add' },
        { line: '@@ glm:web.todomvc.todo_management.todo_filter_engine.params', kind: 'hunk' },
        { line: '-  options: [all, active, completed]', kind: 'del' },
        { line: '+  options: [all, active, completed, archived]', kind: 'add' },
        { line: constraint, kind: 'add' },
      ],
      impact: { variants: 2, tokens: 7400, cacheMisses: 5 },
    },
    {
      kind: 'agent_text',
      body:
        'This SCR is Class I (adds state, adds an interaction). Required approver: platform-review.',
    },
    {
      kind: 'gate',
      label: 'Submit SCR-2090 for review?',
      detail:
        "I'll create the draft, attach the diff + impact, and submit it. The actual approve/reject is on platform-review — I won't bypass that gate.",
      actions: [
        { id: 'submit', label: 'Submit', variant: 'primary' },
        { id: 'modify', label: 'Modify diff first', variant: 'default' },
        { id: 'cancel', label: 'Cancel', variant: 'ghost' },
      ],
    },
  ];
}

export function archiveSubmitted(scr: { id: string }): Card[] {
  return [
    {
      kind: 'console',
      stream: [
        `scr › created ${scr.id} (Class I, Draft)`,
        'scr › attached diff, impact closure, target_nodes',
        `scr › transitioning Draft → Submitted`,
        'audit › emitted scr.submit',
        'notify › @platform-review',
      ],
    },
    {
      kind: 'result',
      title: `${scr.id} submitted`,
      lines: [
        'Status: Submitted → awaiting platform-review',
        "Once approved, I'll re-resolve both variants and trigger regeneration.",
      ],
      link: { label: `Open ${scr.id} in Change Management →`, tab: 'changes' },
    },
  ];
}

export function multiRun(): Card[] {
  return [
    {
      kind: 'console',
      stream: [
        'closure › 6 nodes (system, capability, 4× component/interaction/spec)',
        'binding › 6 params bound (3 from team variant overrides, 3 defaults)',
        'constraint › evaluating 4 invariants…',
        'constraint › multi_user==true ⇒ todo_persistence != sqlite_wal ✓',
        'constraint › persistence==postgres_pool ⇒ pool_size ≥ 4 ✓',
        'cache › design-hash = sha256:…a18c · binding-hash = …b224',
        'cache › generation cache: MISS (last gen was A.0 sqlite variant)',
        'lock › emitting sekkei.lock with 6 pins…',
      ],
    },
    {
      kind: 'resolution_card',
      target: 'glm:web.todomvc.team',
      ok: true,
      designHash: 'sha256:a18c4f7b3e2d9c81',
      generationHash: 'sha256:7d8e2a5f1b9c4e63',
      pins: 6,
      misses: 6,
    },
    {
      kind: 'agent_text',
      body:
        'Resolution succeeded. All four constraints passed under the team binding. Generation cache is empty for this combination so regeneration will cost ~11,200 tokens.',
    },
    {
      kind: 'gate',
      label: 'Schedule regeneration',
      actions: [
        { id: 'now', label: 'Run now', variant: 'primary' },
        { id: 'window', label: 'Next window', variant: 'default' },
        { id: 'stop', label: 'Hold for review', variant: 'ghost' },
      ],
    },
  ];
}

export function driftPromote(scr: { id: string }): Card[] {
  return [
    {
      kind: 'console',
      stream: [
        'drift › promoting live edit on todos.ts to sekkei',
        'edit › capturing diff against current sekkei body',
        `scr  › created ${scr.id} (Class II, Draft)`,
        `scr  › transitioning Draft → Submitted`,
      ],
    },
    {
      kind: 'scr_draft',
      scrId: scr.id,
      scrClass: 'II',
      title: 'Add request-ID logging middleware to todo_rest_api',
      targets: ['glm:web.todomvc.todo_management.todo_rest_api'],
      diff: [
        { line: '@@ todo_rest_api.body.middleware', kind: 'hunk' },
        { line: ' - cors', kind: 'context' },
        { line: ' - validation', kind: 'context' },
        { line: '+- request_id_logger  (origin: live_state_drift_capture)', kind: 'add' },
      ],
      impact: { variants: 2, tokens: 1800, cacheMisses: 2 },
    },
    {
      kind: 'result',
      title: `Hand-edit promoted to ${scr.id}`,
      lines: [
        'Class II (internal — no contract change). Solo-dev approval is sufficient.',
        'Once approved, the sekkei matches the live state — drift on this file clears.',
      ],
      link: { label: `Open ${scr.id} →`, tab: 'changes' },
    },
  ];
}

export function driftHealed(): Card[] {
  return [
    {
      kind: 'console',
      stream: [
        'drift › auto-heal requested on todos.ts',
        'gen   › regenerating from sekkei',
        'gen   › cache miss · 1,800 tokens',
        'deploy› replacing apps/todomvc/src/routes/todos.ts',
        'drift › status Synced (was Live-Drifted)',
      ],
    },
    {
      kind: 'result',
      title: 'Drift healed',
      lines: [
        'todo_rest_api now matches the deployed artifact byte-for-byte.',
        'The hand-edit (request-id logger) was discarded.',
      ],
      link: { label: 'View drift sweep →', tab: 'drift' },
    },
  ];
}
