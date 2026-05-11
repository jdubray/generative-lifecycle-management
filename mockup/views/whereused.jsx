/* ----------------------------------------------------------------------------
   04 — Where-Used Analysis
   Pick a node; show direct + transitive consumers, with impact scoring.
---------------------------------------------------------------------------- */

function WhereUsedView() {
  const targetId = (window.__glm?.whereUsedTarget) || "kizo:web.todomvc.todo_management.todo_filter_engine";
  const target = BY_ID[targetId];
  const [query, setQuery] = useState("");

  const nodes = useMemo(() =>
    NODES.filter(n =>
      !query || n.id.toLowerCase().includes(query.toLowerCase()) || n.title.toLowerCase().includes(query.toLowerCase())
    ), [query]
  );

  const direct = whoUses(targetId);
  const trans  = whoDependsTransitive(targetId);

  // Add the structural "composes-of parent" as an additional use
  const parent = target?.parent ? [{ kind: "composes-of", source: target.parent, source_node: BY_ID[target.parent] }] : [];
  const allDirect = [...parent, ...direct];

  // Compute impact rows for variants
  const variantImpact = VARIANTS.map(v => ({
    variant: v,
    impact: estimateImpact(targetId, v)
  }));

  return (
    <>
      <div className="view-header">
        <div>
          <h1>Where-Used Analysis</h1>
          <div className="sub">Reverse traversal across <span className="mono">composes-of</span>, <span className="mono">depends-on</span>, <span className="mono">derives-from</span>, <span className="mono">implements</span>, <span className="mono">varies-from</span>. Surfaces both <i>structural</i> ancestry and <i>impact-cost</i> for SCR scoping.</div>
        </div>
        <div className="actions">
          <button className="btn">Export CSV</button>
        </div>
      </div>

      <div className="split s-340" style={{height:"calc(100% - 73px)"}}>
        <div className="pane">
          <div className="toolbar">
            <div className="search" style={{flex:1}}>
              <Icon.search/>
              <input placeholder="Pick a node…" value={query} onChange={e=>setQuery(e.target.value)}/>
            </div>
          </div>
          <div className="tree">
            {nodes.map(n => (
              <div key={n.id} className={"tree-row" + (n.id===targetId?" selected":"")}
                   onClick={()=>window.__glm?.setWhereUsedTarget(n.id)}
                   style={{paddingLeft: 12}}>
                <StratumTag s={n.stratum}/>
                <span className="label">
                  <span className="name">{n.title}</span>
                  <span className="id"> {leafOf(n.id)}</span>
                </span>
                <span className="mono muted2" style={{fontSize:10}}>{n.rev_label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="pane" style={{padding:16}}>
          {!target ? <Empty>Pick a node.</Empty> : (
            <div style={{maxWidth: 920, margin: "0 auto"}}>
              <div className="row" style={{gap:8, marginBottom:6}}>
                <StratumTag s={target.stratum}/>
                <StatusPill status={target.revision.status}/>
                <span className="mono muted" style={{fontSize:11}}>rev {target.rev_label}</span>
              </div>
              <h2 style={{margin:"0 0 4px",fontSize:18,fontWeight:600}}>{target.title}</h2>
              <div className="muted mono" style={{fontSize:11.5,marginBottom:14}}>{target.id}</div>

              <Section title={`Direct dependents (${allDirect.length})`}>
                <div className="col" style={{gap:6}}>
                  {allDirect.length === 0 && <div className="muted">No direct dependents.</div>}
                  {allDirect.map((r,i)=>(
                    <div key={i} className="row" style={{gap:8,fontSize:12}}>
                      <span className="tag">{r.kind}</span>
                      {r.source_node && (
                        <>
                          <StratumTag s={r.source_node.stratum}/>
                          <span className="linkish mono" onClick={()=>window.__glm?.setWhereUsedTarget(r.source)}>{r.source_node.title}</span>
                          <span className="muted2 mono" style={{fontSize:11}}>· {r.source_node.rev_label}</span>
                          <StatusPill status={r.source_node.revision.status}/>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </Section>

              <Section title={`Transitive (${trans.length}) — depth-indented`}>
                <div className="col" style={{gap:2}}>
                  {trans.length === 0 && <div className="muted">No transitive consumers.</div>}
                  {trans.map((r,i)=>{
                    const n = BY_ID[r.source]; if (!n) return null;
                    return (
                      <div key={i} className="row" style={{gap:8,fontSize:12,paddingLeft: 12 + r.depth*16}}>
                        <span className="muted2 mono" style={{fontSize:10}}>{"└".padStart(r.depth ? 1 : 0, " ")}</span>
                        <span className="tag">{r.kind}</span>
                        <StratumTag s={n.stratum}/>
                        <span className="linkish mono" onClick={()=>window.__glm?.setWhereUsedTarget(r.source)}>{n.title}</span>
                        <span className="muted2 mono" style={{fontSize:11}}>· {n.rev_label}</span>
                      </div>
                    );
                  })}
                </div>
              </Section>

              <Section title="Variant impact" right={<span className="muted2 mono" style={{fontSize:10}}>per-instance token-cost estimate</span>}>
                <table className="tbl">
                  <thead><tr>
                    <th>Variant</th><th>Override mode</th><th>Generations affected</th><th>Cache miss prob.</th><th>Token cost</th>
                  </tr></thead>
                  <tbody>
                    {variantImpact.map((v,i)=>(
                      <tr key={i} style={{cursor:"default"}}>
                        <td>
                          <div style={{fontWeight:500}}>{v.variant.label}</div>
                          <div className="mono muted2" style={{fontSize:10.5}}>{v.variant.id}</div>
                        </td>
                        <td><span className="tag">{v.impact.mode}</span></td>
                        <td className="mono">{v.impact.files}</td>
                        <td>
                          <span className="mono">{Math.round(v.impact.cache_miss * 100)}%</span>
                          <span className="bar" style={{width: 80, marginTop: 4}}><i style={{width: (v.impact.cache_miss*100)+"%"}}></i></span>
                        </td>
                        <td className="mono">{v.impact.tokens.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>

              <Section title="Open SCRs touching this node">
                <div className="col" style={{gap:6}}>
                  {SCRS.filter(s => s.target_nodes.some(t => t===targetId || isAncestor(t, targetId))).map(s => (
                    <div key={s.id} className="row" style={{gap:8,fontSize:12}}>
                      <span className="mono muted" style={{fontSize:11}}>{s.id}</span>
                      <ClassBadge cls={s.class}/>
                      <span style={{flex:1}}>{s.title}</span>
                      <span className="pill outline">{s.status}</span>
                    </div>
                  ))}
                  {SCRS.filter(s => s.target_nodes.some(t => t===targetId || isAncestor(t, targetId))).length === 0 && (
                    <div className="muted">No open SCRs touch this node.</div>
                  )}
                </div>
              </Section>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function isAncestor(ancestorId, nodeId) {
  let p = BY_ID[nodeId]?.parent;
  while (p) { if (p === ancestorId) return true; p = BY_ID[p]?.parent; }
  return false;
}

function estimateImpact(targetId, variant) {
  // Heuristic illustrative model. Reflects the data on the variant.
  const inRollout = variant.rollout.find(r => r.node === targetId || isAncestor(targetId, r.node) || isAncestor(r.node, targetId));
  const mode = inRollout ? (variant.id.includes(".team") ? "with_override" : "as_is") : "shadowed";
  const files = mode === "shadowed" ? 0 : (BY_ID[targetId]?.files?.length || 1);
  const cache_miss = mode === "shadowed" ? 0 : (variant.channel === "experimental" ? 0.7 : 0.35);
  const tokens = Math.round(files * 1800 * (1 - 0.4 * (1 - cache_miss)));
  return { mode, files, cache_miss, tokens };
}

window.WhereUsedView = WhereUsedView;
