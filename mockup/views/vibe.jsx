/* ----------------------------------------------------------------------------
   ✦ Vibe Mode — conversational GLM agent
   
   The user describes intent in natural language; the GLM agent interprets it
   against the live sekkei graph, drafts a lifecycle plan, asks for approval
   at every formal gate, and executes the seven processes itself.
   
   Two panes:
     - Left: chat transcript w/ rich action cards
     - Right: Process Console — streaming log of every operation the agent runs
   
   The agent's behavior is scripted across three canonical scenarios that
   exercise different lifecycle paths. A free-form fallback uses claude.complete.
---------------------------------------------------------------------------- */

const VIBE_SUGGESTIONS = [
  { key: "archive",  text: "Add a way to archive todos instead of deleting them",
    hint: "Class I SCR · adds new interaction + spec" },
  { key: "multi",    text: "Spin up a team variant with multi-user + Postgres",
    hint: "Variant resolution · derives-from override" },
  { key: "drift",    text: "Reconcile the live-state drift on todo_rest_api",
    hint: "Drift reconciliation · capture as SCR" },
  { key: "promote",  text: "Promote the filter engine subtree to a shared library",
    hint: "Reuse · Candidate → Promoted" }
];

const SCENARIOS = {
  /* ----- Scenario 1: ARCHIVE — Class I structural change ----- */
  archive: [
    { kind: "agent_text",
      body: (
        <>
          Got it. <b>&ldquo;Archive instead of delete&rdquo;</b> is a contract change — it adds state to a todo and changes how list filters behave. I&rsquo;ll need to:
        </>
      )},
    { kind: "plan",
      title: "Proposed lifecycle path",
      steps: [
        { id: "1", proc: "Where-Used",  text: "Locate consumers of todo_management — find every contract that mentions deletion",         status: "pending" },
        { id: "2", proc: "Sekkei edit", text: "Add archive state to todo_management.todo_data + an interaction for archive/unarchive",   status: "pending" },
        { id: "3", proc: "Change Mgmt", text: "Open Class I SCR (contract change) targeting the new interaction + filter_engine update", status: "pending" },
        { id: "4", proc: "Variant Res.", text: "Re-resolve kizo:web.todomvc and kizo:web.todomvc.team — confirm constraints still hold", status: "pending" },
        { id: "5", proc: "Provenance",  text: "Emit signed Statement once the artifact regenerates",                                     status: "pending" }
      ],
      tone: "info" },
    { kind: "agent_text", body: "Before I proceed, one question:" },
    { kind: "clarifier",
      question: "Should archived todos still count toward the &ldquo;active&rdquo; filter? My read of the existing filter_engine constraint is no — but this is a contract decision.",
      options: [
        { id: "a", label: "Hidden from all filters except &lsquo;archived&rsquo;" },
        { id: "b", label: "Visible in &lsquo;all&rsquo;, hidden everywhere else" },
        { id: "c", label: "Always visible, dimmed" }
      ]},
    /* After user picks an option, the agent continues — handled in onClarifierAnswer below */
  ],

  /* ----- Scenario 2: MULTI-USER variant ----- */
  multi: [
    { kind: "agent_text",
      body: (
        <>
          That&rsquo;s a <b>variant resolution</b>, not a sekkei edit. The <span className="mono">.team</span> variant already exists with <span className="mono">multi_user=true, persistence=postgres_pool</span>. Let me re-resolve it against the current sekkei revisions.
        </>
      )},
    { kind: "console",
      stream: [
        "vibe › intent = variant_resolution(target=kizo:web.todomvc.team)",
        "graph › loading variant binding…",
        "graph › derives-from chain: kizo:web.todomvc.team → kizo:web.todomvc @ A.0",
        "binding › multi_user=true, persistence=postgres_pool, undo_seconds=10",
      ]},
    { kind: "plan",
      title: "Re-resolving variant kizo:web.todomvc.team",
      steps: [
        { id: "1", proc: "Closure walk", text: "Walk composes-of from root + apply 2 overrides (todo_persistence, todo_rest_api)", status: "pending" },
        { id: "2", proc: "Parameter binding", text: "Bind 6 parameters along the path", status: "pending" },
        { id: "3", proc: "Constraint val.", text: "Evaluate 4 constraints — including the postgres-only invariant on todo_persistence", status: "pending" },
        { id: "4", proc: "Cache check",  text: "Probe generation cache by (design-hash, binding-hash, generator)", status: "pending" },
        { id: "5", proc: "Lock emit",    text: "Write sekkei.lock + propose dBOM update", status: "pending" }
      ]},
  ],

  /* ----- Scenario 3: DRIFT — live edit reconciliation ----- */
  drift: [
    { kind: "agent_text",
      body: (
        <>
          Pulling the latest drift sweep. <span className="mono">todo_rest_api</span> shows <b>live-state drift</b>: someone hand-edited <span className="mono">apps/todomvc/src/routes/todos.ts</span> to add request-ID logging that isn&rsquo;t in the sekkei.
        </>
      )},
    { kind: "drift_card",
      node: "kizo:web.todomvc.todo_management.todo_rest_api",
      file: "apps/todomvc/src/routes/todos.ts",
      detail: "Three lines added in handler chain — middleware that stamps an x-request-id and logs it. Not malicious; looks like a 2am debug session that survived."
    },
    { kind: "agent_text",
      body: (
        <>
          You have three legitimate paths. The policy on this node is currently <span className="mono">alert</span>, not <span className="mono">auto-heal</span>, so I won&rsquo;t overwrite without your call:
        </>
      )},
    { kind: "choice",
      options: [
        { id: "promote", label: "Capture the edit as a new SCR",
          subtitle: "Promote the hand-edit into the sekkei. Becomes a Class II change to todo_rest_api. Future regens preserve it." },
        { id: "heal", label: "Auto-heal (overwrite the file)",
          subtitle: "Drop the live edit; regenerate from the current sekkei. Loses the logging." },
        { id: "waiver", label: "Issue a deviation/waiver",
          subtitle: "Suspend reconciliation on this file for a stated period. Audited." }
      ]},
  ]
};

/* Continuations for each scenario when the user responds */
const CONTINUATIONS = {
  archive_clarifier: (choice) => ([
    { kind: "agent_text", body: <>Good. I&rsquo;ll encode that as a constraint on filter_engine and proceed.</> },
    { kind: "console",
      stream: [
        "vibe › clarifier resolved: archive_visibility = " + choice,
        "graph › where-used(todo_management.todo_data) → 3 direct + 4 transitive consumers",
        "edit › drafting new interaction kizo:web.todomvc.todo_management.todo_archive",
        "edit › body.contract_kind = fsm",
        "edit › states = [active, archived]",
        "edit › transitions = [archive: active→archived, restore: archived→active]",
        "edit › drafting new spec todo_archive.code_recipe",
        "edit › patching filter_engine.todo_filter_spec — add 'archived' to filter_value enum",
        "hash › computed content-hash for 3 new/changed nodes",
      ]},
    { kind: "scr_draft",
      id: "SCR-2090",
      cls: "I",
      title: "Add archive lifecycle to todos",
      targets: [
        "kizo:web.todomvc.todo_management.todo_data",
        "kizo:web.todomvc.todo_management.todo_archive  (new)",
        "kizo:web.todomvc.todo_management.todo_filter_engine"
      ],
      diff: [
        { line: "@@ kizo:web.todomvc.todo_management.todo_data:body", k: "hunk" },
        { line: " title: string", k: "" },
        { line: " completed: boolean", k: "" },
        { line: "+archived: boolean = false", k: "add" },
        { line: "+archived_at: timestamp? = null", k: "add" },
        { line: "@@ + new kizo:web.todomvc.todo_management.todo_archive", k: "hunk" },
        { line: "+stratum: interaction", k: "add" },
        { line: "+contract_kind: fsm", k: "add" },
        { line: "+states: [active, archived]", k: "add" },
        { line: "+transitions:", k: "add" },
        { line: "+  - archive: active → archived (sets archived_at = now())", k: "add" },
        { line: "+  - restore: archived → active (clears archived_at)", k: "add" },
        { line: "@@ kizo:web.todomvc.todo_management.todo_filter_engine.params", k: "hunk" },
        { line: " filter_value: enum", k: "" },
        { line: "-  options: [all, active, completed]", k: "del" },
        { line: "+  options: [all, active, completed, archived]", k: "add" },
        { line: choice === "a"
            ? "+constraint: archived_excluded_unless_filter_eq_archived"
            : choice === "b"
            ? "+constraint: archived_visible_only_when_filter_eq_all_or_archived"
            : "+constraint: archived_always_visible_dimmed_in_ui",
          k: "add" }
      ],
      impact: { variants: 2, tokens: 7400, cache_misses: 5 }
    },
    { kind: "agent_text",
      body: (
        <>
          Impact summary: <b>2 variants affected</b> (web.todomvc, web.todomvc.team), <b>~7,400 tokens</b> to regenerate, <b>5 cache misses</b>. The team variant inherits the change cleanly — its overrides on persistence don&rsquo;t conflict.
          <br/><br/>
          This SCR is <b>Class I</b> (contract changes — adds state, adds an interaction). Required approver: <span className="mono">platform-review</span>.
        </>
      )},
    { kind: "gate",
      label: "Submit SCR-2090 for review?",
      detail: "I'll create the draft, attach the diff + impact, and submit it. The actual approve/reject is on platform-review — I won't bypass that gate.",
      actions: [
        { id: "submit",  label: "Submit",  variant: "primary" },
        { id: "modify",  label: "Modify diff first", variant: "default" },
        { id: "cancel",  label: "Cancel",  variant: "ghost" }
      ]}
  ]),

  archive_submit: () => ([
    { kind: "console",
      stream: [
        "scr › created SCR-2090 (Class I, Draft)",
        "scr › attached diff, impact closure, target_nodes",
        "scr › transitioning Draft → Submitted",
        "audit › emitted scr-attest attestation",
        "notify › @platform-review",
      ]},
    { kind: "result",
      title: "SCR-2090 submitted",
      lines: [
        "Status: Submitted → awaiting platform-review",
        "Once approved, I'll re-resolve both variants and trigger regeneration.",
        "I'll ping you in here when it lands."
      ],
      link: { label: "Open SCR-2090 in Change Management →", tab: "changes" }
    }
  ]),

  multi_run: () => ([
    { kind: "console",
      stream: [
        "closure › 6 nodes (system, capability, 4× component/interaction/spec)",
        "binding › 6 params bound (3 from team variant overrides, 3 defaults)",
        "constraint › evaluating 4 invariants…",
        "constraint › multi_user==true ⇒ todo_persistence != sqlite_wal  ✓",
        "constraint › persistence==postgres_pool ⇒ pool_size ≥ 4  ✓",
        "constraint › filter_value ∈ {all, active, completed}  ✓",
        "constraint › todo.title.length > 0 trimmed  ✓",
        "cache › design-hash = sha256:…a18c · binding-hash = …b224",
        "cache › generation cache: MISS (last gen was A.0 sqlite variant)",
        "lock › emitting sekkei.lock with 6 pins…",
      ]},
    { kind: "resolution_card",
      target: "kizo:web.todomvc.team",
      ok: true,
      design_hash: "sha256:a18c4f7b3e2d9c81…",
      generation_hash: "sha256:7d8e2a5f1b9c4e63…",
      pins: 6,
      misses: 6 },
    { kind: "agent_text",
      body: (
        <>
          Resolution succeeded. All four constraints passed under the team binding. Generation cache is empty for this combination so regeneration will cost ~<b>11,200 tokens</b>. Should I queue it now or schedule for the next deploy window (Sun 02:00Z)?
        </>
      )},
    { kind: "gate",
      label: "Schedule regeneration",
      actions: [
        { id: "now",      label: "Run now",        variant: "primary" },
        { id: "window",   label: "Next window",    variant: "default" },
        { id: "stop",     label: "Hold for review", variant: "ghost" }
      ]}
  ]),

  drift_promote: () => ([
    { kind: "console",
      stream: [
        "drift › promoting live edit on todos.ts to sekkei",
        "edit › capturing diff against current sekkei body",
        "edit › drafting middleware addition on todo_rest_api.body",
        "scr  › created SCR-2091 (Class II, Draft)",
        "scr  › transitioning Draft → Submitted",
      ]},
    { kind: "scr_draft",
      id: "SCR-2091",
      cls: "II",
      title: "Add request-ID logging middleware to todo_rest_api",
      targets: ["kizo:web.todomvc.todo_management.todo_rest_api"],
      diff: [
        { line: "@@ todo_rest_api.body.middleware", k: "hunk" },
        { line: " - cors", k: "" },
        { line: " - validation", k: "" },
        { line: "+- request_id_logger  (origin: live_state_drift_capture, 2026-05-09)", k: "add" }
      ],
      impact: { variants: 2, tokens: 1800, cache_misses: 2 }
    },
    { kind: "result",
      title: "Hand-edit promoted to SCR-2091",
      lines: [
        "Class II (internal — no contract change). Reviewer: solo-dev approval is sufficient.",
        "Once approved, the sekkei matches the live state — drift on this file clears.",
        "Future regens will preserve the middleware."
      ],
      link: { label: "Open SCR-2091 →", tab: "changes" }
    }
  ]),

  drift_heal: () => ([
    { kind: "console",
      stream: [
        "drift › auto-heal requested on todos.ts",
        "gen   › regenerating from sekkei kizo:web.todomvc.todo_management.todo_rest_api @ A.0",
        "gen   › cache miss · 1,800 tokens",
        "deploy› replacing apps/todomvc/src/routes/todos.ts",
        "drift › status Synced (was Live-Drifted)",
      ]},
    { kind: "result",
      title: "Drift healed",
      lines: [
        "todo_rest_api now matches the deployed artifact byte-for-byte.",
        "The hand-edit (request-id logger) was discarded. If it should come back, open a fresh SCR.",
      ],
      link: { label: "View drift sweep →", tab: "drift" }
    }
  ])
};

/* ============================================================================
   Component
============================================================================ */
function VibeView() {
  const [messages, setMessages] = useState(() => [
    { kind: "agent_text",
      body: (
        <>
          <b>Vibe Mode.</b> Describe what you want to change — at any stratum, in plain language — and I&rsquo;ll run the lifecycle for you. I won&rsquo;t skip the formal gates (SCR approval, deviation/waiver, drift policy); I&rsquo;ll surface them and you decide. Try one of the suggestions below to see me work.
        </>
      )}
  ]);
  const [console_, setConsole] = useState([
    { t: nowStamp(), text: "vibe › session opened", level: "info" },
    { t: nowStamp(-1), text: "graph › indexing sekkei kizo:web.todomvc @ A.0", level: "info" },
    { t: nowStamp(-1), text: "graph › 9 nodes · 11 relationships indexed", level: "ok" },
    { t: nowStamp(-1), text: "graph › drift sweep last 08:00Z · 2 drifted nodes", level: "warn" }
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentScenario, setCurrentScenario] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  function appendMessages(items, scenarioName) {
    let i = 0;
    function step() {
      if (i >= items.length) { setBusy(false); return; }
      const item = items[i++];
      if (item.kind === "console") {
        // Stream into the right pane only
        let j = 0;
        function streamLine() {
          if (j >= item.stream.length) { step(); return; }
          setConsole(c => [...c, { t: nowStamp(), text: item.stream[j++], level: "info" }]);
          setTimeout(streamLine, 180);
        }
        streamLine();
      } else {
        setMessages(m => [...m, { ...item, scenarioName }]);
        setTimeout(step, 420);
      }
    }
    setBusy(true);
    step();
  }

  function runScenario(key) {
    const seq = SCENARIOS[key];
    if (!seq) return;
    setCurrentScenario(key);
    setConsole(c => [...c, { t: nowStamp(), text: `vibe › matched intent → ${key}`, level: "ok" }]);
    appendMessages(seq, key);
  }

  function send() {
    const v = input.trim(); if (!v || busy) return;
    setMessages(m => [...m, { kind: "user", body: v }]);
    setInput("");
    const lower = v.toLowerCase();
    let key = null;
    if (/archive|delete/.test(lower)) key = "archive";
    else if (/multi.?user|team|postgres/.test(lower)) key = "multi";
    else if (/drift|hand.?edit|reconcil/.test(lower)) key = "drift";
    if (key) setTimeout(() => runScenario(key), 280);
    else freeformReply(v);
  }

  async function freeformReply(text) {
    setBusy(true);
    setConsole(c => [...c, { t: nowStamp(), text: "vibe › no scripted scenario — invoking llm fallback", level: "warn" }]);
    try {
      const reply = await window.claude.complete({
        messages: [{ role: "user", content:
`You are the Puffin GLM agent. The user is operating a Generative Lifecycle Management system whose data model is a sekkei (bill of materials for AI-generated code), with seven processes: Change Management (SCR/SCO), Variant Resolution, Where-Used, Effectivity & Rollout, Drift Reconciliation, Reuse & Inheritance, Provenance & Audit.

Available sekkei root: kizo:web.todomvc @ A.0 (in_review). Variants: web.todomvc (canary), web.todomvc.team (canary), web.todomvc.experimental (experimental).

The user said: "${text}"

Respond in 2-3 short sentences as the GLM agent. State which lifecycle process is most likely needed and what you would do next. Do NOT execute — just describe the plan. Be terse, technical, no marketing tone.`}]
      });
      setMessages(m => [...m, { kind: "agent_text", body: reply }]);
    } catch (e) {
      setMessages(m => [...m, { kind: "agent_text",
        body: "I can't reach the model right now. Try one of the scripted suggestions to see the full flow." }]);
    }
    setBusy(false);
  }

  function onClarifierAnswer(choice) {
    setMessages(m => [...m, { kind: "user", body: `chose ${choice.label.replace(/&[a-z]+;/g,"")}` }]);
    appendMessages(CONTINUATIONS.archive_clarifier(choice.id), "archive");
  }
  function onGateAction(scenarioName, gateLabel, actionId) {
    setMessages(m => [...m, { kind: "user", body: actionId }]);
    if (scenarioName === "archive" && actionId === "submit") appendMessages(CONTINUATIONS.archive_submit(), "archive");
    else if (scenarioName === "archive") {
      setMessages(m => [...m, { kind: "agent_text", body: actionId === "cancel" ? "Cancelled. Nothing was written." : "Holding — I'll wait for you to make adjustments. Re-run the suggestion when you're ready." }]);
    }
    else if (scenarioName === "multi")    setMessages(m => [...m, { kind: "agent_text", body: actionId === "now" ? "Queued for immediate regeneration." : actionId === "window" ? "Scheduled for Sun 02:00Z. I'll emit provenance when it lands." : "Holding. The lock has been written but no regen will run." }]);
  }
  function onChoiceAction(scenarioName, optId) {
    setMessages(m => [...m, { kind: "user", body: optId }]);
    if (scenarioName === "drift" && optId === "promote") appendMessages(CONTINUATIONS.drift_promote(), "drift");
    else if (scenarioName === "drift" && optId === "heal") appendMessages(CONTINUATIONS.drift_heal(), "drift");
    else if (scenarioName === "drift") setMessages(m => [...m, { kind: "agent_text", body: "Waiver issued for 14d on apps/todomvc/src/routes/todos.ts. The sweep will skip this file until 2026-05-24. Audit logged." }]);
  }
  function continueScenario(name) {
    if (name === "multi") appendMessages(CONTINUATIONS.multi_run(), "multi");
  }

  return (
    <div className="vibe-shell">
      <div className="vibe-chat">
        <div className="vibe-transcript" ref={scrollRef}>
          {messages.map((m,i) => <VibeMessage key={i} m={m}
            onClarifierAnswer={onClarifierAnswer}
            onGateAction={onGateAction}
            onChoiceAction={onChoiceAction}
            continueScenario={continueScenario}
          />)}
          {busy && <div className="vibe-typing"><span></span><span></span><span></span></div>}
        </div>
        <div className="vibe-input-wrap">
          {messages.length <= 1 && (
            <div className="vibe-sugs">
              {VIBE_SUGGESTIONS.map(s => (
                <button key={s.key} className="vibe-sug" onClick={()=>{setInput("");setMessages(m=>[...m,{kind:"user",body:s.text}]);setTimeout(()=>runScenario(s.key),200);}}>
                  <div className="vibe-sug-text">{s.text}</div>
                  <div className="vibe-sug-hint">{s.hint}</div>
                </button>
              ))}
            </div>
          )}
          <div className="vibe-input">
            <textarea
              placeholder="Describe a change in plain language…"
              value={input}
              rows={1}
              onChange={e=>setInput(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}}
              disabled={busy}
            />
            <button className="btn primary" onClick={send} disabled={busy || !input.trim()}>
              {busy ? "Working…" : "Send"}
            </button>
          </div>
          <div className="vibe-foot muted2 mono">
            ⚠ Vibe Mode never bypasses approval gates. Class I SCRs still route to platform-review; drift policy still gates auto-heal.
          </div>
        </div>
      </div>

      <div className="vibe-console">
        <div className="vibe-console-h">
          <span className="mono" style={{fontSize:11, letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--ink-3)"}}>Process Console</span>
          <span className="mono muted2" style={{fontSize:10}}>{console_.length} events</span>
        </div>
        <div className="vibe-console-body">
          {console_.map((e,i)=>(
            <div key={i} className={"cons-line lvl-"+e.level}>
              <span className="cons-t">{e.t}</span>
              <span className="cons-x">{e.text}</span>
            </div>
          ))}
          {busy && <div className="cons-line lvl-info"><span className="cons-t">{nowStamp()}</span><span className="cons-x">› <span className="vibe-blink">▍</span></span></div>}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   Message renderer
============================================================================ */
function VibeMessage({ m, onClarifierAnswer, onGateAction, onChoiceAction, continueScenario }) {
  if (m.kind === "user") {
    return (
      <div className="vibe-row r-user">
        <div className="vibe-bubble b-user">{m.body}</div>
      </div>
    );
  }
  if (m.kind === "agent_text") {
    return (
      <div className="vibe-row r-agent">
        <div className="vibe-avatar"><span>✦</span></div>
        <div className="vibe-bubble b-agent">{m.body}</div>
      </div>
    );
  }
  if (m.kind === "plan") {
    return (
      <div className="vibe-row r-agent">
        <div className="vibe-avatar"><span>✦</span></div>
        <div className="vibe-bubble b-agent" style={{padding:0}}>
          <div className="vibe-card">
            <div className="vibe-card-h">
              <span className="vibe-card-title">{m.title}</span>
              <span className="mono muted2" style={{fontSize:10}}>{m.steps.length} steps</span>
            </div>
            <div className="vibe-plan">
              {m.steps.map((s,i)=>(
                <div key={s.id} className="vibe-plan-step">
                  <span className="vibe-plan-n">{i+1}</span>
                  <div style={{flex:1}}>
                    <div className="row" style={{gap:6, alignItems:"center"}}>
                      <span className="tag">{s.proc}</span>
                      <span style={{fontSize:12}}>{s.text}</span>
                    </div>
                  </div>
                  <span className="pill outline" style={{fontSize:10}}>{s.status}</span>
                </div>
              ))}
            </div>
            {m.scenarioName === "multi" && (
              <div style={{padding:"10px 12px", borderTop:"1px solid var(--border)", background:"var(--surface-2)"}}>
                <button className="btn primary sm" onClick={()=>continueScenario("multi")}>Run resolution →</button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === "clarifier") {
    return (
      <div className="vibe-row r-agent">
        <div className="vibe-avatar"><span>✦</span></div>
        <div className="vibe-bubble b-agent" style={{padding:0}}>
          <div className="vibe-card">
            <div className="vibe-card-h"><span className="vibe-card-title">Decision required</span><span className="tag">contract</span></div>
            <div style={{padding:"10px 12px"}}>
              <div style={{fontSize:12.5, marginBottom:10}} dangerouslySetInnerHTML={{__html: m.question}}></div>
              <div className="col" style={{gap:6}}>
                {m.options.map(o => (
                  <button key={o.id} className="vibe-choice" onClick={()=>onClarifierAnswer(o)}>
                    <span className="vibe-choice-k">{o.id.toUpperCase()}</span>
                    <span dangerouslySetInnerHTML={{__html: o.label}}></span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === "scr_draft") {
    return (
      <div className="vibe-row r-agent">
        <div className="vibe-avatar"><span>✦</span></div>
        <div className="vibe-bubble b-agent" style={{padding:0}}>
          <div className="vibe-card">
            <div className="vibe-card-h">
              <span className="vibe-card-title">{m.id} · {m.title}</span>
              <ClassBadge cls={m.cls}/>
            </div>
            <div style={{padding:"10px 12px"}}>
              <div className="muted" style={{fontSize:11, marginBottom:6, textTransform:"uppercase", letterSpacing:"0.06em"}}>Target nodes</div>
              <div className="col" style={{gap:3, marginBottom:10}}>
                {m.targets.map((t,i)=><div key={i} className="mono" style={{fontSize:11.5}}>{t}</div>)}
              </div>
              <div className="muted" style={{fontSize:11, marginBottom:6, textTransform:"uppercase", letterSpacing:"0.06em"}}>Diff</div>
              <DiffBlock lines={m.diff}/>
              <div className="row gap-16" style={{marginTop:10}}>
                <div><span className="muted2" style={{fontSize:10.5}}>variants </span><span className="mono">{m.impact.variants}</span></div>
                <div><span className="muted2" style={{fontSize:10.5}}>tokens </span><span className="mono">{m.impact.tokens.toLocaleString()}</span></div>
                <div><span className="muted2" style={{fontSize:10.5}}>cache misses </span><span className="mono">{m.impact.cache_misses}</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === "drift_card") {
    const n = BY_ID[m.node];
    return (
      <div className="vibe-row r-agent">
        <div className="vibe-avatar"><span>✦</span></div>
        <div className="vibe-bubble b-agent" style={{padding:0}}>
          <div className="vibe-card">
            <div className="vibe-card-h">
              <span className="vibe-card-title">Live-state drift</span>
              <span className="pill drift"><span className="dot"></span>Live-Drifted</span>
            </div>
            <div style={{padding:"10px 12px"}}>
              <div className="row" style={{gap:8, marginBottom:6}}>
                <StratumTag s={n.stratum}/>
                <span className="mono" style={{fontSize:12}}>{n.title}</span>
              </div>
              <div className="mono muted" style={{fontSize:11, marginBottom:8}}>{m.file}</div>
              <div style={{fontSize:12.5, lineHeight:1.55}}>{m.detail}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === "choice") {
    return (
      <div className="vibe-row r-agent">
        <div className="vibe-avatar"><span>✦</span></div>
        <div className="vibe-bubble b-agent" style={{padding:0}}>
          <div className="vibe-card">
            <div style={{padding:"10px 12px"}}>
              <div className="col" style={{gap:6}}>
                {m.options.map(o => (
                  <button key={o.id} className="vibe-choice fat" onClick={()=>onChoiceAction(m.scenarioName, o.id)}>
                    <div style={{display:"flex", alignItems:"center", gap:8}}>
                      <span className="vibe-choice-k">{o.id}</span>
                      <span style={{fontWeight:500}}>{o.label}</span>
                    </div>
                    <div className="muted" style={{fontSize:11.5, marginTop:4, marginLeft:32}}>{o.subtitle}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === "gate") {
    return (
      <div className="vibe-row r-agent">
        <div className="vibe-avatar"><span>✦</span></div>
        <div className="vibe-bubble b-agent" style={{padding:0}}>
          <div className="vibe-card gate">
            <div className="vibe-card-h">
              <span className="vibe-card-title">{m.label}</span>
              <span className="tag">approval gate</span>
            </div>
            {m.detail && <div style={{padding:"10px 12px", borderBottom:"1px solid var(--border)", fontSize:12, lineHeight:1.55}}>{m.detail}</div>}
            <div style={{padding:"10px 12px", display:"flex", gap:8, justifyContent:"flex-end"}}>
              {m.actions.map(a => (
                <button key={a.id} className={"btn " + (a.variant || "default")} onClick={()=>onGateAction(m.scenarioName, m.label, a.id)}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === "resolution_card") {
    return (
      <div className="vibe-row r-agent">
        <div className="vibe-avatar"><span>✦</span></div>
        <div className="vibe-bubble b-agent" style={{padding:0}}>
          <div className="vibe-card">
            <div className="vibe-card-h">
              <span className="vibe-card-title">Variant resolved · {m.target}</span>
              {m.ok ? <span className="pill released"><span className="dot"></span>OK</span>
                    : <span className="pill drift"><span className="dot"></span>FAIL</span>}
            </div>
            <div style={{padding:"10px 12px"}}>
              <table className="tbl" style={{margin:0}}>
                <tbody>
                  <tr style={{cursor:"default"}}><td className="muted">design hash</td><td><Hash value={m.design_hash}/></td></tr>
                  <tr style={{cursor:"default"}}><td className="muted">generation hash</td><td><Hash value={m.generation_hash}/></td></tr>
                  <tr style={{cursor:"default"}}><td className="muted">pins</td><td className="mono">{m.pins}</td></tr>
                  <tr style={{cursor:"default"}}><td className="muted">cache misses</td><td className="mono">{m.misses}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === "result") {
    return (
      <div className="vibe-row r-agent">
        <div className="vibe-avatar"><span>✦</span></div>
        <div className="vibe-bubble b-agent" style={{padding:0}}>
          <div className="vibe-card success">
            <div className="vibe-card-h">
              <span className="vibe-card-title">{m.title}</span>
              <span className="pill released"><span className="dot"></span>done</span>
            </div>
            <div style={{padding:"10px 12px"}}>
              <ul style={{margin:0, paddingLeft:18, fontSize:12.5, lineHeight:1.6}}>
                {m.lines.map((l,i)=><li key={i}>{l}</li>)}
              </ul>
              {m.link && (
                <div style={{marginTop:10}}>
                  <a className="linkish" onClick={()=>window.__glm?.goto(m.link.tab)} style={{fontSize:12}}>{m.link.label}</a>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

function nowStamp(offsetSec) {
  const d = new Date();
  if (offsetSec) d.setSeconds(d.getSeconds() + offsetSec);
  return d.toISOString().slice(11,19);
}

window.VibeView = VibeView;
