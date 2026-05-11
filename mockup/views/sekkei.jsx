/* ----------------------------------------------------------------------------
   01 — Sekkei Browser
   Left: searchable tree (DAG by composes-of).
   Right: selected node detail — envelope, parameters, constraints,
   relationships, body, content_hash + cache key.
---------------------------------------------------------------------------- */

function SekkeiView() {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState(() => {
    const init = {};
    NODES.forEach(n => { init[n.id] = true; });
    return init;
  });
  const selectedId = (window.__glm?.selectedNodeId) || "kizo:web.todomvc";
  const selected = BY_ID[selectedId];

  const matchSet = useMemo(() => {
    if (!filter.trim()) return null;
    const q = filter.toLowerCase();
    const hits = new Set();
    NODES.forEach(n => {
      if (n.id.toLowerCase().includes(q) || (n.title||"").toLowerCase().includes(q)) {
        hits.add(n.id);
        let p = n.parent; while (p) { hits.add(p); p = BY_ID[p]?.parent; }
      }
    });
    return hits;
  }, [filter]);

  return (
    <div className="split s-420" style={{height: "100%"}}>
      <div className="pane">
        <div className="toolbar">
          <div className="search" style={{flex:1, minWidth:0}}>
            <Icon.search/>
            <input placeholder="Filter by id or title…" value={filter} onChange={e=>setFilter(e.target.value)}/>
          </div>
          <button className="btn ghost sm" onClick={()=>{
            const next = {};
            NODES.forEach(n => { next[n.id] = filter ? !!matchSet?.has(n.id) : true; });
            setExpanded(next);
          }}>Expand all</button>
          <button className="btn ghost sm" onClick={()=>setExpanded({})}>Collapse all</button>
        </div>
        <div className="tree">
          {rootNodes().map(r => (
            <TreeNode
              key={r.id}
              node={r}
              expanded={expanded}
              toggle={(id)=>setExpanded(s=>({...s,[id]:!s[id]}))}
              selectId={(id)=>window.__glm?.setSelectedNodeId(id)}
              selectedId={selectedId}
              matchSet={matchSet}
            />
          ))}
        </div>
      </div>

      <div className="pane" style={{padding: 16}}>
        {selected ? <NodeDetail node={selected}/> : <Empty>Select a node</Empty>}
      </div>
    </div>
  );
}

function TreeNode({ node, expanded, toggle, selectId, selectedId, matchSet }) {
  if (matchSet && !matchSet.has(node.id)) return null;
  const isOpen = !!expanded[node.id];
  const hasKids = node.children && node.children.length > 0;
  const sel = node.id === selectedId;
  return (
    <>
      <div className={"tree-row" + (sel ? " selected" : "")}
           style={{paddingLeft: 8 + node.depth * 16}}
           onClick={()=>selectId(node.id)}>
        <span className={"caret" + (hasKids ? "" : " empty")} onClick={(e)=>{e.stopPropagation(); toggle(node.id);}}>
          {hasKids ? (isOpen ? <Icon.chevd/> : <Icon.chev/>) : <Icon.dot/>}
        </span>
        <span className="stratum">{STRATUM_LABEL[node.stratum]}</span>
        <span className="label">
          <span className="name">{node.title}</span>
          <span className="id"> {leafOf(node.id)}</span>
        </span>
        <span className="mono muted2" style={{fontSize:10}}>{node.rev_label}</span>
        <StatusPill status={node.revision.status}/>
      </div>
      {isOpen && hasKids && node.children.map(cid =>
        <TreeNode key={cid} node={BY_ID[cid]} expanded={expanded} toggle={toggle} selectId={selectId} selectedId={selectedId} matchSet={matchSet}/>
      )}
    </>
  );
}

function leafOf(id) {
  const i = id.lastIndexOf(".");
  return i < 0 ? id : id.slice(i + 1);
}

/* ---------- Node detail ---------- */
function NodeDetail({ node }) {
  const directUses = whoUses(node.id);
  const transitive = whoDependsTransitive(node.id);
  return (
    <div style={{maxWidth: 880, margin: "0 auto"}}>
      <div className="row" style={{marginBottom: 12, gap: 12}}>
        <div style={{flex:1, minWidth:0}}>
          <div className="row" style={{gap: 8, marginBottom: 4}}>
            <StratumTag s={node.stratum}/>
            <StatusPill status={node.revision.status}/>
            <span className="mono muted" style={{fontSize: 11}}>rev {node.rev_label}</span>
            <span className="mono muted2" style={{fontSize: 11}}>· {node.override_kind}</span>
          </div>
          <h2 style={{margin:"0 0 2px",fontSize:18,fontWeight:600,letterSpacing:"-0.01em"}}>{node.title}</h2>
          <div className="mono muted" style={{fontSize:11.5}}>{node.id}</div>
          <p className="muted" style={{margin:"8px 0 0",fontSize:12.5,lineHeight:1.5}}>{node.description}</p>
        </div>
        <div className="col" style={{alignItems:"flex-end"}}>
          <button className="btn primary"><Icon.plus/> Propose change</button>
          <button className="btn" onClick={()=>{
            window.__glm?.setWhereUsedTarget(node.id);
            window.__glm?.goto("whereused");
          }}>Where used →</button>
        </div>
      </div>

      <Section title="Envelope">
        <KV rows={[
          ["id", <span className="mono">{node.id}</span>],
          ["stratum", <StratumTag s={node.stratum}/>],
          ["revision", <>
            <span className="mono">{node.rev_label}</span>
            <span className="mono muted2" style={{marginLeft:8}}>(Y14.35: skip I/O/Q/S/X/Z)</span>
          </>],
          ["status", <StatusPill status={node.revision.status}/>],
          ["override_kind", <span className="mono">{node.override_kind}</span>],
          ["derives_from", node.derives_from
            ? <span className="mono linkish" onClick={()=>window.__glm?.setSelectedNodeId(node.derives_from.id)}>{node.derives_from.id} @ {node.derives_from.rev}</span>
            : <span className="muted2">— (net_new)</span>],
          ["content_hash", <Hash value={node.content_hash}/>],
          ["authored_by", <span className="mono">glm-sekkei-validator@A.0</span>]
        ]}/>
      </Section>

      {node.params && node.params.length > 0 && (
        <Section title={`Parameters (${node.params.length})`}>
          <table className="tbl">
            <thead><tr>
              <th>Name</th><th>Type</th><th>Default</th><th>Scope</th>
            </tr></thead>
            <tbody>
              {node.params.map((p,i)=>(
                <tr key={i} style={{cursor:"default"}}>
                  <td className="mono">{p.name}</td>
                  <td className="muted mono" style={{fontSize:11}}>
                    {p.type}{p.options ? ` ∈ {${p.options.join("|")}}` : ""}
                    {p.min!=null ? ` [${p.min}..${p.max??"∞"}]` : ""}
                  </td>
                  <td className="mono">{JSON.stringify(p.default)}</td>
                  <td><span className="tag">{p.scope}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {node.constraints && node.constraints.length > 0 && (
        <Section title={`Constraints (${node.constraints.length})`}>
          <div className="col" style={{gap:6}}>
            {node.constraints.map((c,i)=>(
              <div key={i} className="row" style={{gap:8,fontSize:12}}>
                <span className="tag">{c.kind}</span>
                <span className={"tag"} style={{
                  background: c.severity==="error" ? "var(--st-drift-bg)" : "var(--st-inwork-bg)",
                  color: c.severity==="error" ? "oklch(0.40 0.17 28)" : "oklch(0.40 0.13 70)"
                }}>{c.severity}</span>
                <span className="mono">{c.expression}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Body" right={<span className="mono muted2" style={{fontSize:10}}>{node.stratum}-stratum shape</span>}>
        <YamlBlock src={renderBody(node)}/>
      </Section>

      {node.files && node.files.length > 0 && (
        <Section title="Realization files">
          <div className="col" style={{gap:4}}>
            {node.files.map((f,i)=>(
              <div key={i} className="row" style={{justifyContent:"space-between"}}>
                <span className="mono" style={{fontSize:12}}>{f}</span>
                <Hash value={hash("file",f,node.rev_label)}/>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title={`Relationships (${directUses.length + (node.depends_on?.length||0) + (node.parent?1:0) + (node.children?.length||0)})`}>
        <div className="col" style={{gap:6}}>
          {node.parent && (
            <RelRow kind="composes-of (parent)" id={node.parent} />
          )}
          {node.children.map(cid => (
            <RelRow key={cid} kind="composes-of (child)" id={cid}/>
          ))}
          {directUses.map((r,i)=>(
            <RelRow key={"u"+i} kind={r.kind + " ← "} id={r.source}/>
          ))}
          {(node.depends_on || []).map((d,i)=>(
            <div key={"d"+i} className="row" style={{gap:8,fontSize:12}}>
              <span className="tag">depends-on</span>
              <span className="mono">{d.purl}</span>
              <span className="muted2" style={{fontSize:11}}>· {d.role}</span>
              {d.digest && <Hash value={d.digest}/>}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Generation cache">
        <KV rows={[
          ["design hash", <Hash value={node.content_hash}/>],
          ["closure (incl. children)", <Hash value={hash("closure", node.id, ...node.children.map(c=>BY_ID[c].content_hash))}/>],
          ["generation hash", <Hash value={hash("gen", node.content_hash, "claude-sonnet-4.5@2026-04")}/>],
          ["cache status", <span className="pill released"><span className="dot"></span>hit · last 2026-05-10T07:11Z</span>]
        ]}/>
      </Section>
    </div>
  );
}

function RelRow({ kind, id }) {
  const n = BY_ID[id]; if (!n) return null;
  return (
    <div className="row" style={{gap:8,fontSize:12}}>
      <span className="tag">{kind}</span>
      <StratumTag s={n.stratum}/>
      <span className="linkish mono" onClick={()=>window.__glm?.setSelectedNodeId(id)}>{n.title}</span>
      <span className="muted2 mono" style={{fontSize:11}}>· {n.rev_label}</span>
      <StatusPill status={n.revision.status}/>
    </div>
  );
}

function renderBody(n) {
  const b = n.body || {};
  if (n.stratum === "system") {
    return `system_role: ${b.system_role}\ndbom_ref: ${b.dbom_ref ?? "null"}\nruntime: ${b.runtime ?? "—"}`;
  }
  if (n.stratum === "capability") {
    return `user_value: |\n  ${b.user_value || "—"}`;
  }
  if (n.stratum === "component") {
    return `boundary: |\n  ${b.boundary || "—"}\nruntime: ${b.runtime}`;
  }
  if (n.stratum === "interaction") {
    if (b.contract_kind === "fsm") {
      return `contract_kind: fsm\nstates: [${(b.states||[]).join(", ")}]\ntransitions:\n${(b.transitions||[]).map(t=>"  - "+t).join("\n")}`;
    }
    if (b.contract_kind === "integration_adapter") {
      return `contract_kind: integration_adapter\nendpoints:\n${(b.endpoints||[]).map(e=>"  - "+e).join("\n")}`;
    }
    if (b.contract_kind === "schema_binding") {
      return `contract_kind: schema_binding\n${b.contract || ""}`;
    }
    if (b.contract_kind === "event_flow") {
      return `contract_kind: event_flow\nlistener: ${b.listener}`;
    }
  }
  if (n.stratum === "spec") {
    let s = `spec_kind: ${b.spec_kind}\ncontent: |\n${(b.content||"").split("\n").map(l=>"  "+l).join("\n")}`;
    if (b.assertions) {
      s += "\ninspection_assertions:\n" + b.assertions.map(a=>`  - id: ${a.id}\n    kind: ${a.kind}\n    expression: ${a.expression}`).join("\n");
    }
    if (b.context_bundle) {
      s += `\ncontext_bundle: [${b.context_bundle.join(", ")}]\noutputs: [${(b.outputs||[]).join(", ")}]\nverifier: ${b.verifier}`;
    }
    return s;
  }
  return JSON.stringify(b, null, 2);
}

window.SekkeiView = SekkeiView;
