/* ----------------------------------------------------------------------------
   00 — Dashboard
   System-wide pulse: graph size, SCRs by state, drift, reuse health, gen costs.
---------------------------------------------------------------------------- */

function DashboardView() {
  const counts = {
    nodes: NODES.length,
    system: NODES.filter(n=>n.stratum==="system").length,
    capability: NODES.filter(n=>n.stratum==="capability").length,
    component: NODES.filter(n=>n.stratum==="component").length,
    interaction: NODES.filter(n=>n.stratum==="interaction").length,
    spec: NODES.filter(n=>n.stratum==="spec").length,
    overrides: NODES.filter(n=>n.override_kind!=="net_new").length
  };
  const scrCounts = {
    draft: SCRS.filter(s=>s.status==="Draft").length,
    inrev: SCRS.filter(s=>s.status==="Submitted"||s.status==="Under Review").length,
    appr:  SCRS.filter(s=>s.status==="Approved").length,
    impl:  SCRS.filter(s=>s.status==="Implemented").length,
    rel:   SCRS.filter(s=>s.status==="Released").length,
    ret:   SCRS.filter(s=>s.status==="Returned"||s.status==="Rejected").length,
  };
  const driftCounts = {
    synced: DRIFT.filter(d=>d.status==="Synced").length,
    hash:   DRIFT.filter(d=>d.status==="Hash-Drifted").length,
    live:   DRIFT.filter(d=>d.status==="Live-Drifted").length,
    susp:   DRIFT.filter(d=>d.status==="Suspended").length
  };
  const totalTokens = PROVENANCE.reduce((s,p)=>s + p.tokens_in + p.tokens_out, 0);
  const hits = PROVENANCE.filter(p => p.cache === "hit").length;

  return (
    <>
      <div className="view-header">
        <div>
          <h1>Generative Lifecycle Management</h1>
          <div className="sub">
            Manages the <span className="mono">Sekkei</span> (the bill-of-materials for Claude-Code-generated artifacts) and the seven processes that surround it: <i>Change</i>, <i>Variant Resolution</i>, <i>Where-Used</i>, <i>Effectivity</i>, <i>Drift</i>, <i>Reuse</i>, <i>Provenance</i>.
          </div>
        </div>
        <div className="actions">
          <button className="btn"><Icon.search/> Search across sekkei</button>
          <button className="btn primary"><Icon.plus/> Propose change</button>
        </div>
      </div>

      <div style={{padding:16, height:"calc(100% - 73px)", overflowY:"auto"}}>
        <div style={{maxWidth:1240, margin:"0 auto"}}>

          {/* Top row — system pulse */}
          <div className="grid-3" style={{marginBottom:16}}>
            <Card title="Sekkei graph" right={<span className="mono muted2" style={{fontSize:10}}>5 strata · derives-from + composes-of</span>}>
              <div className="bignum">{counts.nodes}<span className="bignum-unit"> nodes</span></div>
              <StratumDistribution counts={counts}/>
              <div className="row gap-12" style={{marginTop:10,fontSize:11.5}} className="muted">
                <span><b>{counts.overrides}</b> overrides (derives-from)</span>
                <span style={{marginLeft:"auto"}} className="muted2">1 root system</span>
              </div>
            </Card>

            <Card title="Change requests" right={<span className="mono muted2" style={{fontSize:10}}>{SCRS.length} open · 30d</span>}>
              <div className="bignum">{scrCounts.inrev + scrCounts.appr}<span className="bignum-unit"> active</span></div>
              <div className="bar-stack" style={{marginTop:8}}>
                <span style={{flex:scrCounts.draft, background:"oklch(0.85 0.005 95)"}} title={`Draft ${scrCounts.draft}`}></span>
                <span style={{flex:scrCounts.inrev, background:"oklch(0.78 0.12 245)"}} title={`In review ${scrCounts.inrev}`}></span>
                <span style={{flex:scrCounts.appr, background:"oklch(0.78 0.11 70)"}} title={`Approved ${scrCounts.appr}`}></span>
                <span style={{flex:scrCounts.impl, background:"oklch(0.78 0.10 200)"}} title={`Implemented ${scrCounts.impl}`}></span>
                <span style={{flex:scrCounts.rel, background:"oklch(0.78 0.11 150)"}} title={`Released ${scrCounts.rel}`}></span>
                <span style={{flex:scrCounts.ret, background:"oklch(0.78 0.13 28)"}} title={`Returned ${scrCounts.ret}`}></span>
              </div>
              <Legend items={[
                ["Draft", scrCounts.draft, "oklch(0.85 0.005 95)"],
                ["In review", scrCounts.inrev, "oklch(0.78 0.12 245)"],
                ["Approved", scrCounts.appr, "oklch(0.78 0.11 70)"],
                ["Implemented", scrCounts.impl, "oklch(0.78 0.10 200)"],
                ["Released", scrCounts.rel, "oklch(0.78 0.11 150)"],
                ["Returned", scrCounts.ret, "oklch(0.78 0.13 28)"]
              ]}/>
            </Card>

            <Card title="Drift" right={<span className="mono muted2" style={{fontSize:10}}>last sweep 08:00Z</span>}>
              <div className="bignum">{driftCounts.hash + driftCounts.live}<span className="bignum-unit"> drifted nodes</span></div>
              <div className="col" style={{gap:6, marginTop:8}}>
                <DriftBar label="Synced" v={driftCounts.synced} t={DRIFT.length} color="oklch(0.78 0.11 150)"/>
                <DriftBar label="Hash drift" v={driftCounts.hash} t={DRIFT.length} color="oklch(0.78 0.13 28)"/>
                <DriftBar label="Live-state drift" v={driftCounts.live} t={DRIFT.length} color="oklch(0.78 0.13 50)"/>
                <DriftBar label="Suspended" v={driftCounts.susp} t={DRIFT.length} color="oklch(0.80 0.02 95)"/>
              </div>
            </Card>
          </div>

          {/* Middle row */}
          <div className="grid-2" style={{marginBottom:16}}>
            <Card title="Variants" right={<span className="mono muted2" style={{fontSize:10}}>3 active · 1 experimental</span>}>
              <table className="tbl">
                <thead><tr><th>Variant</th><th>Channel</th><th>Status</th><th>Pinned nodes</th></tr></thead>
                <tbody>
                  {VARIANTS.map(v=>(
                    <tr key={v.id} style={{cursor:"default"}}>
                      <td>
                        <div style={{fontWeight:500}}>{v.label}</div>
                        <div className="mono muted2" style={{fontSize:10.5}}>{v.id}</div>
                      </td>
                      <td><span className="tag">{v.channel}</span></td>
                      <td>
                        {v.rollout.every(r=>r.state==="Deployed-to-dBOM")
                          ? <span className="pill released"><span className="dot"></span>healthy</span>
                          : <span className="pill in_review"><span className="dot"></span>{v.rollout.filter(r=>r.state!=="Deployed-to-dBOM").length} pending</span>}
                      </td>
                      <td className="mono">{v.rollout.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card title="Generation cost (30d)" right={<span className="mono muted2" style={{fontSize:10}}>{PROVENANCE.length} events · cache hit {Math.round(hits/PROVENANCE.length*100)}%</span>}>
              <div className="bignum">{(totalTokens/1000).toFixed(1)}k<span className="bignum-unit"> tokens</span></div>
              <Sparkline series={[18,22,19,28,31,26,35,30,42,38,29,33,27,40,36,44,38,48,46,52,49,41,55,50,58,53,61,57,63,60]}/>
              <div className="row gap-12" style={{marginTop:8,fontSize:11.5}}>
                <span><span className="muted2">cache hit ratio</span> <span className="mono">{Math.round(hits/PROVENANCE.length*100)}%</span></span>
                <span><span className="muted2">tokens saved by cache</span> <span className="mono">~{Math.round(totalTokens * (hits/PROVENANCE.length)).toLocaleString()}</span></span>
              </div>
            </Card>
          </div>

          {/* Bottom — activity */}
          <Card title="Recent activity" right={<a className="linkish" onClick={()=>window.__glm?.goto("provenance")}>see all provenance →</a>}>
            <table className="tbl">
              <thead><tr><th>When</th><th>Event</th><th>Subject</th><th>Actor</th></tr></thead>
              <tbody>
                <tr style={{cursor:"default"}}><td className="mono muted">2026-05-10 08:32Z</td><td><span className="tag">sekkei.edit</span></td><td>filter_engine — add &quot;archived&quot; filter</td><td className="mono">han.junseo</td></tr>
                <tr style={{cursor:"default"}}><td className="mono muted">2026-05-10 08:00Z</td><td><span className="tag">drift.sweep</span></td><td>3 drift records · 1 new</td><td className="mono">reconciler</td></tr>
                <tr style={{cursor:"default"}}><td className="mono muted">2026-05-10 07:14Z</td><td><span className="tag">scr.submit</span></td><td>SCR-2089 — Bulk operations</td><td className="mono">han.junseo</td></tr>
                <tr style={{cursor:"default"}}><td className="mono muted">2026-05-10 03:18Z</td><td><span className="tag">artifact.deploy</span></td><td>todo_filter_engine → kizo:web.todomvc</td><td className="mono">deploy-bot</td></tr>
                <tr style={{cursor:"default"}}><td className="mono muted">2026-05-09 22:41Z</td><td><span className="tag">scr.approve</span></td><td>SCR-2087 — Filter persistence</td><td className="mono">platform-review</td></tr>
                <tr style={{cursor:"default"}}><td className="mono muted">2026-05-09 19:08Z</td><td><span className="tag">variant.release</span></td><td>todomvc.team — A.0 to canary</td><td className="mono">han.junseo</td></tr>
              </tbody>
            </table>
          </Card>

        </div>
      </div>
    </>
  );
}

/* ---------- Cards / charts ---------- */

function Card({ title, right, children }) {
  return (
    <div className="card">
      <div className="card-h">
        <h3>{title}</h3>
        {right || null}
      </div>
      <div className="card-b">{children}</div>
    </div>
  );
}

function StratumDistribution({ counts }) {
  const items = [
    ["S", counts.system,     STRATUM_COLOR.system],
    ["C", counts.capability, STRATUM_COLOR.capability],
    ["O", counts.component,  STRATUM_COLOR.component],
    ["I", counts.interaction,STRATUM_COLOR.interaction],
    ["P", counts.spec,       STRATUM_COLOR.spec]
  ];
  return (
    <>
      <div className="bar-stack" style={{marginTop:8}}>
        {items.map(([k,v,c]) => <span key={k} style={{flex:v, background:c}} title={`${k} ${v}`}></span>)}
      </div>
      <Legend items={items.map(([k,v,c]) => [STRATUM_LABEL_FULL[k], v, c])}/>
    </>
  );
}

function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((it,i)=>(
        <span key={i} className="legend-item">
          <span className="swatch" style={{background:it[2]}}></span>
          <span className="muted2" style={{fontSize:11}}>{it[0]}</span>
          <span className="mono" style={{fontSize:11}}>{it[1]}</span>
        </span>
      ))}
    </div>
  );
}

function DriftBar({ label, v, t, color }) {
  const pct = t === 0 ? 0 : Math.round(v/t * 100);
  return (
    <div>
      <div className="row" style={{fontSize:11.5, justifyContent:"space-between"}}>
        <span className="muted">{label}</span>
        <span className="mono">{v} <span className="muted2">({pct}%)</span></span>
      </div>
      <span className="bar"><i style={{width: pct+"%", background: color}}></i></span>
    </div>
  );
}

function Sparkline({ series }) {
  const w = 480, h = 56;
  const max = Math.max(...series), min = Math.min(...series);
  const xs = series.map((_,i) => (i/(series.length-1)) * w);
  const ys = series.map(v => h - ((v - min) / (max - min || 1)) * (h - 4) - 2);
  const path = "M" + xs.map((x,i)=>`${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(" L");
  const fillPath = path + ` L${w} ${h} L0 ${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",height:64,marginTop:8,display:"block"}}>
      <path d={fillPath} fill="oklch(0.93 0.02 95)" opacity="0.7"/>
      <path d={path} fill="none" stroke="var(--ink-2)" strokeWidth="1.4"/>
      {xs.map((x,i)=>i % 5 === 0 ? <circle key={i} cx={x} cy={ys[i]} r="1.6" fill="var(--ink-1)"/> : null)}
    </svg>
  );
}

const STRATUM_LABEL_FULL = {
  S: "System", C: "Capability", O: "Component", I: "Interaction", P: "Spec"
};
const STRATUM_COLOR = {
  system:      "oklch(0.78 0.04 280)",
  capability:  "oklch(0.78 0.10 245)",
  component:   "oklch(0.78 0.10 200)",
  interaction: "oklch(0.78 0.10 150)",
  spec:        "oklch(0.78 0.08 70)"
};

window.DashboardView = DashboardView;
window.STRATUM_COLOR = STRATUM_COLOR;
