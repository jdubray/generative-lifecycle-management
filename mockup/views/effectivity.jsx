/* ----------------------------------------------------------------------------
   05 — Effectivity & Rollout
   When does an approved sekkei change reach each consuming variant?
   - Date / variant / channel / pin-policy effective
   - Rollout state machine: Released → Available-on-Channel → Pinned-by-Variant
     → Generated-for-Instance → Deployed-to-dBOM
---------------------------------------------------------------------------- */

const ROLLOUT_STATES = ["Released", "Available-on-Channel", "Pinned-by-Variant", "Generated-for-Instance", "Deployed-to-dBOM"];
const PIN_POLICIES = ["pin-on-release", "track-latest", "frozen"];

function EffectivityView() {
  const [variantId, setVariantId] = useState(VARIANTS[0].id);
  const [policyOverride, setPolicyOverride] = useState({});
  const v = VARIANTS.find(x => x.id === variantId);

  return (
    <>
      <div className="view-header">
        <div>
          <h1>Effectivity & Rollout</h1>
          <div className="sub">
            Released revisions reach an instance only after they pass the four orthogonal effectivity gates: <span className="mono">date</span>, <span className="mono">variant</span>, <span className="mono">channel</span>, <span className="mono">pin-policy</span>. Each advance triggers regeneration via the Generation Pipeline.
          </div>
        </div>
        <div className="actions">
          <button className="btn">Pause channel</button>
          <button className="btn primary">Promote canary → stable</button>
        </div>
      </div>

      <div className="toolbar">
        <span className="muted2" style={{fontSize:11}}>VARIANT</span>
        <select className="btn" value={variantId} onChange={e=>setVariantId(e.target.value)} style={{padding:5}}>
          {VARIANTS.map(v => <option key={v.id} value={v.id}>{v.label} — {v.instance}</option>)}
        </select>
        <span className="muted2" style={{fontSize:11,marginLeft:12}}>CHANNEL</span>
        <span className="pill outline">{v.channel}</span>
        <span className="muted2" style={{fontSize:11,marginLeft:12}}>DEFAULT PIN POLICY</span>
        <span className="pill outline">{v.pin_policy_default}</span>
        <div className="grow"></div>
        <span className="muted2 mono" style={{fontSize:11}}>dbom: {v.instance}</span>
      </div>

      <div style={{padding: 16, overflowY:"auto", height: "calc(100% - 73px - 41px)"}}>
        <div style={{maxWidth: 1080, margin: "0 auto"}}>
          <div className="row gap-12" style={{flexWrap:"wrap", marginBottom: 12}}>
            <Stat label="Nodes pinned" value={v.rollout.length}/>
            <Stat label="Advanceable" value={v.rollout.filter(r => r.available !== r.pin).length}/>
            <Stat label="Released → not yet pinned" value={v.rollout.filter(r => r.available !== r.pin && BY_ID[r.node]?.revision.status === "released").length}/>
            <Stat label="Last rollout" value={<span className="mono" style={{fontSize:13}}>2026-05-10 03:18Z</span>}/>
          </div>

          <Section title="Rollout state per node" right={<span className="muted2 mono" style={{fontSize:10}}>Released → Available → Pinned → Generated → Deployed</span>} tight>
            <table className="tbl">
              <thead><tr>
                <th>Node</th><th>Available rev</th><th>Pin policy</th><th>Pinned rev</th><th>Rollout state</th><th></th>
              </tr></thead>
              <tbody>
                {v.rollout.map((r, i) => {
                  const n = BY_ID[r.node];
                  const policy = policyOverride[r.node] || v.pin_policy_default;
                  const stateIdx = ROLLOUT_STATES.indexOf(r.state);
                  const canAdvance = r.available !== r.pin;
                  return (
                    <tr key={i} style={{cursor:"default"}}>
                      <td>
                        <div className="row" style={{gap:8}}>
                          <StratumTag s={n.stratum}/>
                          <span className="linkish mono" onClick={()=>{window.__glm?.setSelectedNodeId(n.id);window.__glm?.goto("sekkei");}}>{n.title}</span>
                        </div>
                        <div className="mono muted2" style={{fontSize:10.5,marginTop:2}}>{n.id}</div>
                      </td>
                      <td className="mono">{r.available}</td>
                      <td>
                        <select value={policy} onChange={e=>setPolicyOverride(p=>({...p,[r.node]:e.target.value}))}
                                className="btn" style={{padding:"3px 6px",fontSize:11}}>
                          {PIN_POLICIES.map(p => <option key={p}>{p}</option>)}
                        </select>
                      </td>
                      <td className="mono">{r.pin}</td>
                      <td>
                        <div className="steps" style={{maxWidth: 360}}>
                          {ROLLOUT_STATES.map((s, j)=>(
                            <div key={s} className={"step " + (j < stateIdx ? "done" : j === stateIdx ? "on" : "")}>
                              <span className="n">{j+1}</span>
                            </div>
                          ))}
                        </div>
                        <div className="mono muted2" style={{fontSize:10.5, marginTop:4}}>{r.state}</div>
                      </td>
                      <td>
                        {canAdvance ? (
                          <button className="btn primary sm">Advance →</button>
                        ) : <span className="muted2">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Section>

          <Section title="Effectivity rules">
            <div className="col" style={{gap:6,fontSize:12}}>
              <div className="row"><span className="tag">date</span><span className="mono">activate_at &lt;= now()</span><span className="muted">— set per release</span></div>
              <div className="row"><span className="tag">variant</span><span className="mono">predicate(variant.parameters)</span><span className="muted">— e.g. multi_user==true</span></div>
              <div className="row"><span className="tag">channel</span><span className="mono">channel == &quot;{v.channel}&quot;</span></div>
              <div className="row"><span className="tag">pin-policy</span><span className="mono">{v.pin_policy_default}</span><span className="muted">— per-node override available</span></div>
            </div>
          </Section>

          <Section title="Recent rollout events">
            <table className="tbl">
              <thead><tr><th>When</th><th>Node</th><th>Transition</th><th>Actor</th></tr></thead>
              <tbody>
                <tr style={{cursor:"default"}}><td className="mono">2026-05-10 03:18Z</td><td className="mono">todo_filter_engine</td><td>Pinned-by-Variant → Generated-for-Instance</td><td className="mono">scheduler</td></tr>
                <tr style={{cursor:"default"}}><td className="mono">2026-05-10 03:18Z</td><td className="mono">todo_filter_engine</td><td>Generated-for-Instance → Deployed-to-dBOM</td><td className="mono">deploy-bot</td></tr>
                <tr style={{cursor:"default"}}><td className="mono">2026-05-09 19:08Z</td><td className="mono">todo_rest_api</td><td>Released → Available-on-Channel (canary)</td><td className="mono">han.junseo</td></tr>
                <tr style={{cursor:"default"}}><td className="mono">2026-04-22 15:14Z</td><td className="mono">kizo:web.todomvc</td><td>Available → Pinned (hono_logger_enabled=false)</td><td className="mono">han.junseo</td></tr>
              </tbody>
            </table>
          </Section>
        </div>
      </div>
    </>
  );
}

window.EffectivityView = EffectivityView;
