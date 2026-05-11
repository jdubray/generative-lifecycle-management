/* ----------------------------------------------------------------------------
   06 — Drift Reconciliation
   Two drift kinds:
     1. Hash drift  — sekkei advanced, deployed artifact still on old gen.lock
     2. Live-state drift — runtime hash diverged from gen.lock (hand-edit etc.)
---------------------------------------------------------------------------- */

function DriftView() {
  const [filter, setFilter] = useState("all");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const filtered = DRIFT.filter(d => filter==="all" || d.status===filter);
  const sel = filtered[selectedIdx] || filtered[0];

  const counts = {
    synced: DRIFT.filter(d => d.status === "Synced").length,
    hash:   DRIFT.filter(d => d.status === "Hash-Drifted").length,
    live:   DRIFT.filter(d => d.status === "Live-Drifted").length,
    susp:   DRIFT.filter(d => d.status === "Suspended").length
  };

  return (
    <>
      <div className="view-header">
        <div>
          <h1>Drift Reconciliation</h1>
          <div className="sub">Reconciles <span className="mono">Desired</span> (sekkei content-hash), <span className="mono">Observed</span> (deployed runtime hash), and <span className="mono">Reported</span> (last status). Hash drift triggers regeneration; live-state drift triggers policy (auto-heal / alert / suspend).</div>
        </div>
        <div className="actions">
          <button className="btn">Run full sweep</button>
          <button className="btn primary">Reconcile all auto-heal</button>
        </div>
      </div>

      <div className="toolbar">
        <div className="seg">
          {[
            ["all","All",DRIFT.length],
            ["Synced","Synced",counts.synced],
            ["Hash-Drifted","Hash drift",counts.hash],
            ["Live-Drifted","Live-state drift",counts.live],
            ["Suspended","Suspended",counts.susp]
          ].map(([k,label,c])=>(
            <button key={k} className={filter===k?"on":""} onClick={()=>{setFilter(k);setSelectedIdx(0);}}>
              {label} <span className="muted2 mono" style={{marginLeft:4,fontSize:10}}>{c}</span>
            </button>
          ))}
        </div>
        <div className="grow"></div>
        <span className="muted2 mono" style={{fontSize:11}}>last sweep 2026-05-10 08:00Z · every 5m</span>
      </div>

      <div className="split s-420" style={{height:"calc(100% - 73px - 41px)"}}>
        <div className="pane">
          <table className="tbl">
            <thead><tr>
              <th>Node</th><th>File</th><th>Status</th><th>Policy</th>
            </tr></thead>
            <tbody>
              {filtered.map((d, i) => {
                const n = BY_ID[d.node_id];
                return (
                  <tr key={i} className={i===selectedIdx?"selected":""} onClick={()=>setSelectedIdx(i)}>
                    <td>
                      <div style={{fontWeight:500}}>{n?.title || d.node_id}</div>
                      <div className="mono muted2" style={{fontSize:10.5}}>{d.node_id}</div>
                    </td>
                    <td className="mono">{d.file}</td>
                    <td><DriftPill status={d.status}/></td>
                    <td><span className="tag">{d.policy}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="pane" style={{padding:16}}>
          {!sel ? <Empty>No drift records.</Empty> :
            <div style={{maxWidth: 880, margin:"0 auto"}}>
              <div className="row" style={{gap:8, marginBottom:6}}>
                <DriftPill status={sel.status}/>
                <span className="tag">{sel.kind === "none" ? "—" : sel.kind} drift</span>
                <span className="muted2 mono" style={{fontSize:11}}>detected {fmtDate(sel.detected_at)}</span>
              </div>
              <h2 style={{margin:"0 0 4px",fontSize:17,fontWeight:600}}>{BY_ID[sel.node_id]?.title || sel.node_id}</h2>
              <div className="mono muted" style={{fontSize:11.5,marginBottom:10}}>{sel.node_id} → {sel.file}</div>

              <Section title="Reconciliation triplet">
                <KV rows={[
                  ["desired (sekkei)",   <Hash value={sel.desired_hash}/>],
                  ["observed (runtime)", <Hash value={sel.observed_hash}/>],
                  ["reported", <DriftPill status={sel.status}/>],
                  ["drift kind", <span className="tag">{sel.kind}</span>],
                  ["policy",     <span className="tag">{sel.policy}</span>]
                ]}/>
              </Section>

              <Section title="Detail">
                <p style={{margin:0,fontSize:12.5,lineHeight:1.55}}>{sel.detail}</p>
              </Section>

              {sel.kind === "hash" && (
                <Section title="Resolution" right={<span className="muted2 mono" style={{fontSize:10}}>hash drift</span>}>
                  <p style={{fontSize:12.5,marginTop:0}}>
                    The sekkei advanced; the deployed artifact has not been regenerated. <b>Auto-heal:</b> the Generation Pipeline will re-run for this node, producing a new artifact hash, then the deployer will swap.
                  </p>
                  <div className="row" style={{gap:8}}>
                    <button className="btn primary">Regenerate & deploy</button>
                    <button className="btn">Schedule next window</button>
                  </div>
                </Section>
              )}

              {sel.kind === "live_state" && (
                <Section title="Resolution" right={<span className="muted2 mono" style={{fontSize:10}}>live-state drift</span>}>
                  <p style={{fontSize:12.5,marginTop:0}}>
                    The deployed artifact has been modified outside the sekkei. Three responses are available; the configured policy is <span className="tag">{sel.policy}</span>.
                  </p>
                  <div className="row" style={{gap:8, flexWrap:"wrap"}}>
                    <button className="btn primary">Auto-heal (overwrite)</button>
                    <button className="btn">Capture as net-new SCR</button>
                    <button className="btn">Issue deviation/waiver</button>
                    <button className="btn">Suspend reconciliation</button>
                  </div>
                  <div className="callout" style={{marginTop:10}}>
                    Capturing the live edit as an SCR is the formal path to <i>promote a hand-edit back into the sekkei</i>. Used when the operator decides the change is good and should propagate to variants.
                  </div>
                </Section>
              )}

              <Section title="Sweep history (last 7d)">
                <table className="tbl">
                  <thead><tr><th>When</th><th>Status</th><th>Desired</th><th>Observed</th></tr></thead>
                  <tbody>
                    <tr style={{cursor:"default"}}><td className="mono">2026-05-10 08:00Z</td><td><DriftPill status={sel.status}/></td><td><Hash value={sel.desired_hash}/></td><td><Hash value={sel.observed_hash}/></td></tr>
                    <tr style={{cursor:"default"}}><td className="mono">2026-05-10 03:30Z</td><td><DriftPill status="Synced"/></td><td><Hash value={sel.desired_hash}/></td><td><Hash value={sel.desired_hash}/></td></tr>
                    <tr style={{cursor:"default"}}><td className="mono">2026-05-09 22:00Z</td><td><DriftPill status="Synced"/></td><td><Hash value={sel.desired_hash}/></td><td><Hash value={sel.desired_hash}/></td></tr>
                  </tbody>
                </table>
              </Section>
            </div>
          }
        </div>
      </div>
    </>
  );
}

function DriftPill({ status }) {
  const map = {
    "Synced": "synced",
    "Hash-Drifted": "drift",
    "Live-Drifted": "drift",
    "Stalled": "warn",
    "Suspended": "suspended"
  };
  return <span className={"pill " + (map[status]||"outline")}><span className="dot"></span>{status}</span>;
}

window.DriftView = DriftView;
