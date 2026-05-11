/* ----------------------------------------------------------------------------
   07 — Reuse & Inheritance
   Variant-Local → Candidate-for-Promotion → Promoted-to-Library → Stewarded
---------------------------------------------------------------------------- */

const REUSE_STAGES = ["Variant-Local", "Candidate-for-Promotion", "Promoted-to-Library", "Stewarded-by-Owner"];

function ReuseView() {
  const [selectedId, setSelectedId] = useState(REUSE[0].id);
  const sel = REUSE.find(r => r.id === selectedId) || REUSE[0];
  const node = BY_ID[sel.subtree];

  return (
    <>
      <div className="view-header">
        <div>
          <h1>Reuse & Inheritance</h1>
          <div className="sub">
            Promotes sekkei subtrees from variant-local to community-shared. Discovery is <i>structural</i>: a Where-Used query against the live sekkei graph, not a catalog lookup.
          </div>
        </div>
        <div className="actions">
          <button className="btn"><Icon.search/> Find candidates</button>
          <button className="btn primary"><Icon.plus/> Manual promotion</button>
        </div>
      </div>

      <div className="split s-420" style={{height:"calc(100% - 73px)"}}>
        <div className="pane">
          <table className="tbl">
            <thead><tr>
              <th>Subtree</th><th>Stage</th><th>Usages</th>
            </tr></thead>
            <tbody>
              {REUSE.map(r => {
                const n = BY_ID[r.subtree];
                return (
                  <tr key={r.id} className={r.id===selectedId?"selected":""} onClick={()=>setSelectedId(r.id)}>
                    <td>
                      <div style={{fontWeight:500}}>{n?.title || r.subtree}</div>
                      <div className="mono muted2" style={{fontSize:10.5}}>{r.subtree}</div>
                    </td>
                    <td><ReuseStagePill stage={r.stage}/></td>
                    <td className="mono">{r.usages}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="pane" style={{padding:16}}>
          <div style={{maxWidth: 880, margin:"0 auto"}}>
            <div className="row" style={{gap:8,marginBottom:6}}>
              <ReuseStagePill stage={sel.stage}/>
              {node && <StratumTag s={node.stratum}/>}
              {node && <StatusPill status={node.revision.status}/>}
            </div>
            <h2 style={{margin:"0 0 4px",fontSize:17,fontWeight:600}}>{sel.title}</h2>
            <div className="mono muted" style={{fontSize:11.5,marginBottom:12}}>{sel.subtree}</div>

            <Section title="Promotion lifecycle">
              <div className="steps">
                {REUSE_STAGES.map((s, i) => {
                  const cur = REUSE_STAGES.indexOf(sel.stage);
                  const cls = i < cur ? "done" : i === cur ? "on" : "";
                  return <div key={s} className={"step " + cls}><span className="n">{i+1}</span> {s}</div>;
                })}
              </div>
            </Section>

            <Section title="Rationale">
              <p style={{margin:0,fontSize:12.5,lineHeight:1.55}}>{sel.rationale}</p>
            </Section>

            <Section title="Where-used signal (current)">
              <div className="row gap-16" style={{flexWrap:"wrap"}}>
                <Stat label="Live usages" value={sel.usages}/>
                <Stat label="Variants holding invariants" value={sel.invariants_held_in}/>
                <Stat label="Promotion threshold" value={<span style={{fontSize:13}} className="mono">≥ 2 deployed + ≥ 1 steward</span>}/>
              </div>
            </Section>

            <Section title="Steward">
              {sel.steward ? (
                <KV rows={[
                  ["owner",   <span className="mono">{sel.steward}</span>],
                  ["on-call", <span className="mono">platform-data@kizo.dev</span>],
                  ["maintenance SLA", "next-business-day for invariant breaks"]
                ]}/>
              ) : (
                <div className="callout">
                  No steward yet. Promotion to <span className="mono">Promoted-to-Library</span> requires a named owner who accepts ongoing maintenance.
                  <div style={{marginTop:8}}><button className="btn primary sm">Accept stewardship</button></div>
                </div>
              )}
            </Section>

            <Section title="Action">
              {sel.stage === "Variant-Local" && (
                <>
                  <p className="muted" style={{margin:"0 0 8px",fontSize:12}}>Subtree is held in a single variant. Promotion needs a second adopter.</p>
                  <button className="btn">Mark as candidate</button>
                </>
              )}
              {sel.stage === "Candidate-for-Promotion" && (
                <>
                  <p className="muted" style={{margin:"0 0 8px",fontSize:12}}>Open the promotion SCR. This is a Class I change to the ancestor sekkei surface.</p>
                  <div className="row" style={{gap:8}}>
                    <button className="btn primary">Open promotion SCR (Class I)</button>
                    <button className="btn">Reject candidate</button>
                  </div>
                </>
              )}
              {sel.stage === "Promoted-to-Library" && (
                <p className="muted" style={{margin:0,fontSize:12}}>Promoted. Consumers inherit by <span className="mono">derives-from</span> against the library id.</p>
              )}
            </Section>

            <Section title="Inheritance proof">
              <YamlBlock src={`# regenerating the same subtree from the variant and from the library\n# must produce byte-identical artifacts under the same binding.\n\nlibrary_id: kizo:web.shared.filter_engine\nrevision: A.0\ncontent_hash: ${hash("lib",sel.id)}\nadopters:\n  - kizo:web.todomvc\n  - kizo:web.todomvc.team\nproof:\n  - regenerated 2026-05-10T06:00Z\n  - artifact_digest matches across adopters\n`}/>
            </Section>
          </div>
        </div>
      </div>
    </>
  );
}

function ReuseStagePill({ stage }) {
  const map = {
    "Variant-Local": "outline",
    "Candidate-for-Promotion": "in_review",
    "Promoted-to-Library": "released",
    "Stewarded-by-Owner": "released"
  };
  return <span className={"pill " + (map[stage]||"outline")}><span className="dot"></span>{stage}</span>;
}

window.ReuseView = ReuseView;
