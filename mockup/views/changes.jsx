/* ----------------------------------------------------------------------------
   02 — Change Management
   Left: SCR list with filters. Right: SCR detail w/ diff, impact, workflow.
---------------------------------------------------------------------------- */

const SCR_STATES = ["Draft", "Submitted", "Under Review", "Approved", "Returned", "Rejected", "Implemented", "Released"];
const SCR_STATE_LIVE = ["Draft", "Submitted", "Under Review", "Approved", "Implemented", "Released"];

function ChangesView() {
  const [selectedId, setSelectedId] = useState(SCRS[0].id);
  const [filterClass, setFilterClass] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const filtered = SCRS.filter(s =>
    (filterClass==="all" || s.class===filterClass) &&
    (filterStatus==="all" || s.status===filterStatus)
  );
  const scr = SCRS.find(s => s.id === selectedId) || SCRS[0];

  return (
    <>
      <div className="view-header">
        <div>
          <h1>Change Management</h1>
          <div className="sub">SCR (Sekkei Change Request) → SCO (Sekkei Change Order). Class I changes alter contracts; Class II are internal. Approved SCOs mutate nodes, increment iteration, and trigger downstream regeneration per effectivity.</div>
        </div>
        <div className="actions">
          <button className="btn"><Icon.search/> Search</button>
          <button className="btn primary"><Icon.plus/> New SCR</button>
        </div>
      </div>

      <div className="split s-420" style={{height:"calc(100% - 73px)"}}>
        <div className="pane">
          <div className="toolbar">
            <div className="seg">
              {["all","I","II"].map(c=>(
                <button key={c} className={filterClass===c?"on":""} onClick={()=>setFilterClass(c)}>{c==="all"?"All classes":"Class "+c}</button>
              ))}
            </div>
            <select className="btn" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} style={{paddingTop:5,paddingBottom:5}}>
              <option value="all">All states</option>
              {SCR_STATES.map(s=><option key={s}>{s}</option>)}
            </select>
            <div className="grow"></div>
            <span className="muted2 mono" style={{fontSize:11}}>{filtered.length} of {SCRS.length}</span>
          </div>
          <table className="tbl">
            <thead><tr>
              <th>ID</th><th>Title</th><th>Class</th><th>Status</th>
            </tr></thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id} className={s.id===selectedId?"selected":""} onClick={()=>setSelectedId(s.id)}>
                  <td className="mono num">{s.id}</td>
                  <td>
                    <div style={{fontWeight:500}}>{s.title}</div>
                    <div className="mono muted2" style={{fontSize:10.5}}>{s.proposer} · {fmtDate(s.proposed_at)}</div>
                  </td>
                  <td><ClassBadge cls={s.class}/></td>
                  <td><ScrStatus status={s.status}/></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="pane" style={{padding:16}}>
          <ScrDetail scr={scr}/>
        </div>
      </div>
    </>
  );
}

function ScrStatus({ status }) {
  const map = {
    "Draft": "outline",
    "Submitted": "in_review",
    "Under Review": "in_review",
    "Approved": "warn",
    "Implemented": "in_review",
    "Released": "released",
    "Returned": "drift",
    "Rejected": "drift",
    "Superseded": "superseded"
  };
  return <span className={"pill " + (map[status]||"outline")}><span className="dot"></span>{status}</span>;
}

function ScrDetail({ scr }) {
  const reviewIdx = SCR_STATE_LIVE.indexOf(scr.status);
  return (
    <div style={{maxWidth: 880, margin:"0 auto"}}>
      <div className="row" style={{gap:12, marginBottom:12}}>
        <div style={{flex:1, minWidth:0}}>
          <div className="row" style={{gap:8, marginBottom:4}}>
            <span className="mono muted" style={{fontSize:12}}>{scr.id}</span>
            <ClassBadge cls={scr.class}/>
            <ScrStatus status={scr.status}/>
          </div>
          <h2 style={{margin:"0 0 2px",fontSize:17,fontWeight:600}}>{scr.title}</h2>
          <div className="muted" style={{fontSize:12}}>
            Proposed by <span className="mono">{scr.proposer}</span> on {fmtDate(scr.proposed_at)}
          </div>
        </div>
        <div className="row" style={{gap:6}}>
          {scr.status === "Under Review" && (
            <>
              <button className="btn danger">Return</button>
              <button className="btn">Reject</button>
              <button className="btn primary">Approve</button>
            </>
          )}
          {scr.status === "Approved" && (
            <button className="btn primary">Implement →</button>
          )}
          {scr.status === "Draft" && (
            <button className="btn primary">Submit</button>
          )}
        </div>
      </div>

      <Section title="Workflow">
        <div className="steps">
          {SCR_STATE_LIVE.map((s, i) => {
            const cls = i < reviewIdx ? "done" : (i === reviewIdx ? "on" : "");
            return (
              <div key={s} className={"step " + cls}>
                <span className="n">{String(i+1).padStart(2,"0")}</span>{" "}{s}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Problem statement">
        <p style={{margin:0,fontSize:12.5,lineHeight:1.55}}>{scr.problem}</p>
        {scr.return_reason && (
          <div className="callout" style={{marginTop:10,background:"var(--st-drift-bg)",borderColor:"oklch(0.85 0.10 28)"}}>
            <b>Returned:</b> {scr.return_reason}
          </div>
        )}
      </Section>

      <Section title="Target nodes">
        <div className="col" style={{gap:6}}>
          {scr.target_nodes.map(id => {
            const n = BY_ID[id];
            if (!n) return <div key={id} className="mono">{id}</div>;
            return (
              <div key={id} className="row" style={{gap:8,fontSize:12}}>
                <StratumTag s={n.stratum}/>
                <span className="linkish mono" onClick={()=>{window.__glm?.setSelectedNodeId(id);window.__glm?.goto("sekkei");}}>{n.title}</span>
                <span className="muted2 mono" style={{fontSize:11}}>· {n.rev_label}</span>
                <StatusPill status={n.revision.status}/>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Proposed delta" right={<span className="mono muted2" style={{fontSize:10}}>YAML diff (RFC-6902-equivalent)</span>}>
        <DiffBlock lines={scr.diff_yaml}/>
      </Section>

      <Section title="Impact closure">
        <div className="row gap-16" style={{flexWrap:"wrap"}}>
          <Stat label="Variants affected" value={scr.impact.variants_affected}/>
          <Stat label="Est. tokens to regenerate" value={fmtNum(scr.impact.tokens_est)}/>
          <Stat label="Generation cache misses" value={scr.impact.cache_miss_count}/>
          <Stat label="Effectivity"
            value={<span className="mono" style={{fontSize:11}}>{scr.effectivity}</span>}/>
        </div>
        <div style={{marginTop:10,fontSize:11.5}} className="muted">
          Cost estimate = sum over affected variants of (closure design-hash × generator identity × bound parameters) – generation cache hits.
        </div>
      </Section>

      <Section title="Approvals">
        <table className="tbl">
          <thead><tr><th>Reviewer</th><th>Decision</th><th>When</th></tr></thead>
          <tbody>
            {scr.approvals.length === 0 && (
              <tr style={{cursor:"default"}}><td colSpan="3" className="muted">No approvals yet — SCR still in Draft.</td></tr>
            )}
            {scr.approvals.map((a,i)=>(
              <tr key={i} style={{cursor:"default"}}>
                <td className="mono">{a.who}</td>
                <td>{a.decision==="approve" ? <span className="pill released"><span className="dot"></span>approve</span> :
                     a.decision==="return"  ? <span className="pill drift"><span className="dot"></span>return</span> :
                     a.decision==="reject"  ? <span className="pill drift"><span className="dot"></span>reject</span> :
                     <span className="pill outline">pending</span>}</td>
                <td className="mono muted" style={{fontSize:11}}>{a.when || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Provenance">
        <KV rows={[
          ["scr id", <span className="mono">{scr.id}</span>],
          ["created", <span className="mono">{scr.proposed_at}</span>],
          ["class", <ClassBadge cls={scr.class}/>],
          ["audit attestation", <Hash value={hash("scr-attest", scr.id)}/>]
        ]}/>
      </Section>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{minWidth:160}}>
      <div className="muted" style={{fontSize:10,textTransform:"uppercase",letterSpacing:"0.06em"}}>{label}</div>
      <div style={{fontSize:18,fontWeight:600,marginTop:2}}>{value}</div>
    </div>
  );
}

function fmtNum(n) { return n.toLocaleString("en-US"); }
function fmtDate(s) {
  const d = new Date(s); if (isNaN(+d)) return s;
  return d.toISOString().slice(0,16).replace("T"," ") + "Z";
}

window.ChangesView = ChangesView;
