/* ----------------------------------------------------------------------------
   03 — Variant Resolution
   Given (sekkei_root, parameter_binding) → walk closure, bind parameters,
   validate constraints, close over deps, compute cache keys, emit lock file.
---------------------------------------------------------------------------- */

function VariantsView() {
  const roots = NODES.filter(n => !n.parent);
  const [rootId, setRootId] = useState(roots[0].id);
  const root = BY_ID[rootId];

  // Collect parameters along path
  const allParams = useMemo(() => collectParams(rootId), [rootId]);
  const [binding, setBinding] = useState(() => Object.fromEntries(allParams.map(p => [p.name, p.default])));
  useEffect(() => {
    setBinding(Object.fromEntries(allParams.map(p => [p.name, p.default])));
  }, [rootId]);

  const [resolved, setResolved] = useState(null);
  const [running, setRunning] = useState(false);

  function resolve() {
    setRunning(true);
    setResolved(null);
    const steps = [];
    const closure = [];
    function walk(id, depth) {
      const n = BY_ID[id]; if (!n) return;
      closure.push({ id, rev: n.rev_label, hash: n.content_hash, depth, ok: true });
      (n.children || []).forEach(c => walk(c, depth + 1));
    }
    walk(rootId, 0);
    steps.push({ name: "1. Closure walk", detail: `Visited ${closure.length} node(s) via composes-of + derives-from.`, ok: true });

    // Parameter binding
    const missing = allParams.filter(p => binding[p.name] === undefined || binding[p.name] === "");
    steps.push({
      name: "2. Parameter binding",
      detail: missing.length === 0 ? `${allParams.length} parameter(s) bound; defaults applied where omitted.` : `Unbound: ${missing.map(m=>m.name).join(", ")}`,
      ok: missing.length === 0
    });

    // Constraint validation
    const cs = collectConstraints(rootId);
    const validatedCs = cs.map(c => ({ ...c, passed: evalConstraint(c, binding) }));
    const failed = validatedCs.filter(c => !c.passed && c.severity === "error");
    steps.push({
      name: "3. Constraint validation",
      detail: failed.length === 0 ? `Evaluated ${cs.length} constraint(s). All passed.` : `${failed.length} failed.`,
      ok: failed.length === 0,
      detail_rows: validatedCs
    });

    // Dependency closure
    const deps = collectDeps(rootId);
    steps.push({
      name: "4. External dependency closure",
      detail: `${deps.length} external dependency pin(s) resolved; all carry content digests.`,
      ok: true,
      detail_rows: deps
    });

    // Cache key computation
    const closureHash = hash("closure", rootId, ...closure.map(c=>c.hash));
    const bindingHash = hash("binding", JSON.stringify(binding));
    const designHash = closureHash;
    const generator = "claude-sonnet-4.5@2026-04";
    const genHash = hash("gen", designHash, bindingHash, generator);
    steps.push({
      name: "5. Cache key computation",
      detail: `design-hash + binding-hash + generator-id → generation-hash`,
      ok: true,
      hashes: { closureHash, bindingHash, designHash, genHash, generator }
    });

    // Lock emission
    steps.push({
      name: "6. sekkei.lock emission",
      detail: `Pinned ${closure.length} node(s) by (logical-id, revision, content-hash).`,
      ok: true,
      lockfile: closure.map(c => ({ id: c.id, rev: c.rev, hash: c.hash }))
    });

    setTimeout(() => {
      setResolved({ steps, deps, validatedCs, closure, hashes: steps.find(s=>s.hashes)?.hashes });
      setRunning(false);
    }, 380);
  }

  return (
    <>
      <div className="view-header">
        <div>
          <h1>Variant Resolution</h1>
          <div className="sub">Lazy, single-shot evaluator. No SAT solver, no 150% feature-model expansion: a single candidate variant is validated against the constraints declared along its path, then content-addressed and emitted as <span className="mono">sekkei.lock</span>.</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={()=>{setResolved(null);setBinding(Object.fromEntries(allParams.map(p => [p.name, p.default])));}}>Reset</button>
          <button className="btn primary" onClick={resolve} disabled={running}>{running ? "Resolving…" : "Resolve variant"}</button>
        </div>
      </div>

      <div className="split s-420" style={{height:"calc(100% - 73px)"}}>
        <div className="pane" style={{padding:16}}>
          <Section title="Sekkei root">
            <select className="btn" value={rootId} onChange={e=>setRootId(e.target.value)} style={{width:"100%",padding:6}}>
              {roots.map(r => <option key={r.id} value={r.id}>{r.title} — {r.id} @ {r.rev_label}</option>)}
            </select>
            {root.derives_from && (
              <div className="muted" style={{fontSize:11.5,marginTop:6}}>
                derives from <span className="mono">{root.derives_from.id} @ {root.derives_from.rev}</span> ({root.override_kind})
              </div>
            )}
          </Section>

          <Section title={`Parameter binding (${allParams.length})`}>
            <div className="col" style={{gap:8}}>
              {allParams.map(p => (
                <div key={p.name} className="field">
                  <label>
                    <span className="mono">{p.name}</span>
                    <span className="muted2" style={{marginLeft:6,fontSize:10.5}}>· {p.scope} · {p.type}{p.options?` ∈ {${p.options.join("|")}}`:""}</span>
                  </label>
                  {p.options ? (
                    <select value={binding[p.name] ?? ""} onChange={e=>setBinding(b=>({...b,[p.name]: e.target.value}))}>
                      {p.options.map(o=><option key={o}>{o}</option>)}
                    </select>
                  ) : p.type === "boolean" ? (
                    <select value={String(binding[p.name] ?? "")} onChange={e=>setBinding(b=>({...b,[p.name]: e.target.value==="true"}))}>
                      <option value="true">true</option><option value="false">false</option>
                    </select>
                  ) : (
                    <input value={binding[p.name] ?? ""} onChange={e=>setBinding(b=>({...b,[p.name]: castValue(p, e.target.value)}))}/>
                  )}
                  <div className="hint">default {JSON.stringify(p.default)}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Target environment">
            <KV rows={[
              ["generator", <span className="mono">claude-sonnet-4.5@2026-04</span>],
              ["prompt version", <Hash value={hash("prompt-v3")} len={8}/>],
              ["tool chain", <Hash value={hash("toolchain", "bun-1.1")} len={8}/>],
              ["env digest", <Hash value={hash("env", "linux-arm64")} len={8}/>]
            ]}/>
          </Section>
        </div>

        <div className="pane" style={{padding:16}}>
          {!resolved && !running && (
            <Empty>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:13,marginBottom:6}}>Bind parameters and resolve.</div>
                <div className="muted" style={{fontSize:11.5}}>Constraints are evaluated <i>at resolution time</i>, against this single candidate — never across the cross-product of all valid assignments.</div>
              </div>
            </Empty>
          )}
          {running && <Empty>Walking closure · binding · validating · closing deps · hashing · locking…</Empty>}
          {resolved && <ResolutionReport r={resolved}/>}
        </div>
      </div>
    </>
  );
}

function ResolutionReport({ r }) {
  const allOk = r.steps.every(s => s.ok);
  return (
    <div style={{maxWidth: 920, margin: "0 auto"}}>
      <div className={"callout"} style={{
        background: allOk ? "var(--st-released-bg)" : "var(--st-drift-bg)",
        borderColor: allOk ? "oklch(0.85 0.08 150)" : "oklch(0.85 0.10 28)",
        color: allOk ? "oklch(0.30 0.13 150)" : "oklch(0.35 0.15 28)",
        marginBottom: 12
      }}>
        <b>{allOk ? "Resolution complete." : "Resolution failed."}</b>{" "}
        {r.closure.length} node(s) walked · {r.validatedCs.length} constraint(s) checked · {r.deps.length} external dep(s) pinned · generation-hash <Hash value={r.hashes.genHash}/>.
      </div>

      <Section title="Pipeline">
        <div className="col" style={{gap:8}}>
          {r.steps.map((s,i)=>(
            <div key={i} className="row" style={{gap:8,alignItems:"flex-start"}}>
              <span className="pill" style={{
                background: s.ok ? "var(--st-released-bg)" : "var(--st-drift-bg)",
                color: s.ok ? "oklch(0.35 0.13 150)" : "oklch(0.40 0.15 28)"
              }}>{s.ok ? "OK" : "FAIL"}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:12.5}}>{s.name}</div>
                <div className="muted" style={{fontSize:11.5}}>{s.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Constraint evaluation">
        <table className="tbl">
          <thead><tr><th>Kind</th><th>Severity</th><th>Expression</th><th>Result</th></tr></thead>
          <tbody>
            {r.validatedCs.map((c,i)=>(
              <tr key={i} style={{cursor:"default"}}>
                <td><span className="tag">{c.kind}</span></td>
                <td><span className="tag">{c.severity}</span></td>
                <td className="mono">{c.expression}</td>
                <td>{c.passed ? <span className="pill released"><span className="dot"></span>pass</span> : <span className="pill drift"><span className="dot"></span>fail</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="External dependency pins">
        <table className="tbl">
          <thead><tr><th>PURL</th><th>Role</th><th>Digest</th></tr></thead>
          <tbody>
            {r.deps.map((d,i)=>(
              <tr key={i} style={{cursor:"default"}}>
                <td className="mono">{d.purl}</td>
                <td className="muted">{d.role}</td>
                <td><Hash value={d.digest}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Cache keys">
        <KV rows={[
          ["closure hash", <Hash value={r.hashes.closureHash}/>],
          ["binding hash", <Hash value={r.hashes.bindingHash}/>],
          ["design hash", <Hash value={r.hashes.designHash}/>],
          ["generator", <span className="mono">{r.hashes.generator}</span>],
          ["generation hash", <Hash value={r.hashes.genHash}/>]
        ]}/>
      </Section>

      <Section title="sekkei.lock" right={<button className="btn ghost sm">Copy</button>}>
        <YamlBlock src={
`# generated $(date) — do not edit\nfor_sekkei: ${r.steps[0] ? "—" : "—"}\npins:\n` +
r.steps.find(s=>s.lockfile).lockfile.map(p => `  - id: ${p.id}\n    revision: ${p.rev}\n    content_hash: ${p.hash}`).join("\n")
        }/>
      </Section>
    </div>
  );
}

/* ---------- helpers ---------- */
function collectParams(rootId) {
  const out = []; const seen = new Set();
  function walk(id) {
    const n = BY_ID[id]; if (!n) return;
    (n.params||[]).forEach(p => { if (!seen.has(p.name)) { out.push(p); seen.add(p.name); } });
    (n.children||[]).forEach(walk);
  }
  walk(rootId);
  return out;
}
function collectConstraints(rootId) {
  const out = [];
  function walk(id) {
    const n = BY_ID[id]; if (!n) return;
    (n.constraints||[]).forEach(c => out.push(c));
    (n.children||[]).forEach(walk);
  }
  walk(rootId);
  return out;
}
function collectDeps(rootId) {
  const out = []; const seen = new Set();
  function walk(id) {
    const n = BY_ID[id]; if (!n) return;
    (n.depends_on||[]).forEach(d => {
      if (!seen.has(d.purl)) { out.push(d); seen.add(d.purl); }
    });
    (n.children||[]).forEach(walk);
  }
  walk(rootId);
  return out;
}
function evalConstraint(c, binding) {
  // Heuristic / non-execution — these are illustrative for the demo.
  // Real GLM evaluates a CEL-like predicate. We simulate sensibly:
  const e = c.expression;
  if (e.includes("single_user == true")) return true;
  if (e.includes("persistence == sqlite_wal")) return true;
  if (e.includes("filter_value in")) return true;
  if (e.includes("todo.title.length > 0")) return !!binding.trim_input;
  if (e.includes("journal_mode == 'wal'")) return true;
  if (e.includes("foreign_keys == 1")) return true;
  return true;
}
function castValue(p, v) {
  if (p.type === "integer") return v === "" ? "" : (parseInt(v, 10) || 0);
  return v;
}

window.VariantsView = VariantsView;
