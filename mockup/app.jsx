/* ----------------------------------------------------------------------------
   Puffin GLM — main shell
---------------------------------------------------------------------------- */
const NAV = [
  { id: "vibe",        n: "✦",  label: "Vibe Mode",             badge: null,         comp: () => <VibeView/> },
  { id: "dashboard",   n: "00", label: "Dashboard",            badge: null,         comp: () => <DashboardView/> },
  { id: "sekkei",      n: "01", label: "Sekkei Browser",       badge: NODES.length, comp: () => <SekkeiView/> },
  { id: "changes",     n: "02", label: "Change Management",    badge: SCRS.length,  comp: () => <ChangesView/> },
  { id: "variants",    n: "03", label: "Variant Resolution",   badge: VARIANTS.length, comp: () => <VariantsView/> },
  { id: "whereused",   n: "04", label: "Where-Used",           badge: null,         comp: () => <WhereUsedView/> },
  { id: "effectivity", n: "05", label: "Effectivity & Rollout", badge: VARIANTS.length, comp: () => <EffectivityView/> },
  { id: "drift",       n: "06", label: "Drift Reconciliation",
    badge: DRIFT.filter(d => d.status !== "Synced").length, comp: () => <DriftView/> },
  { id: "reuse",       n: "07", label: "Reuse & Inheritance",  badge: REUSE.length, comp: () => <ReuseView/> },
  { id: "provenance",  n: "08", label: "Provenance & Audit",   badge: PROVENANCE.length, comp: () => <ProvenanceView/> }
];

function App() {
  const [tab, setTab] = useState("dashboard");
  // shared cross-view state — selecting a node from one view jumps to another
  const [selectedNodeId, setSelectedNodeId] = useState("kizo:web.todomvc.todo_management.todo_rest_api");
  const [whereUsedTarget, setWhereUsedTarget] = useState("kizo:web.todomvc.todo_management.todo_filter_engine");

  // expose to children via window so each view file can import without prop drilling
  useEffect(() => {
    window.__glm = {
      selectedNodeId, setSelectedNodeId,
      whereUsedTarget, setWhereUsedTarget,
      goto: (t) => setTab(t)
    };
  });

  const active = NAV.find(n => n.id === tab) || NAV[0];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark"></span>
          Puffin GLM
          <small>generative lifecycle management</small>
        </div>
        <div className="divider"></div>
        <div className="proj">
          <span className="id">kizo:web.todomvc</span>
          <span className="rev">@ A.0</span>
          <StatusPill status="in_review"/>
        </div>
        <div className="lock">
          <span className="dot"></span>
          sekkei.lock <Hash value={hash("sekkei.lock", "kizo:web.todomvc@A.0")}/>
        </div>
        <div className="grow"></div>
        <div className="lock">
          <span className="muted">generation cache</span>
          <Hash value={hash("gen.lock", "kizo:web.todomvc@A.0")}/>
          <span className="muted2">· 47 hits · 12 misses</span>
        </div>
        <div className="divider"></div>
        <span className="muted2 mono" style={{fontSize:11}}>han.junseo@kizo.dev</span>
      </header>

      <div className="body">
        <nav className="rail">
          <div className="group">Overview</div>
          {NAV.slice(0, 2).map(it => (
            <NavItem key={it.id} it={it} active={tab===it.id} onClick={()=>setTab(it.id)} />
          ))}
          <div className="group">Design</div>
          {NAV.slice(2, 3).map(it => (
            <NavItem key={it.id} it={it} active={tab===it.id} onClick={()=>setTab(it.id)} />
          ))}
          <div className="group">Lifecycle processes</div>
          {NAV.slice(3).map(it => (
            <NavItem key={it.id} it={it} active={tab===it.id} onClick={()=>setTab(it.id)} />
          ))}
          <div style={{height:24}}></div>
          <div className="group">Variants</div>
          {VARIANTS.map(v => (
            <div key={v.id} className="item" style={{paddingTop:4,paddingBottom:4,cursor:"default"}}>
              <span style={{display:"flex",flexDirection:"column",gap:1}}>
                <span style={{fontSize:11.5}}>{v.label}</span>
                <span className="mono muted2" style={{fontSize:10}}>{v.instance} · {v.channel}</span>
              </span>
            </div>
          ))}
        </nav>

        <main className="main">
          <div className="viewport">
            {active.comp()}
          </div>
        </main>
      </div>
    </div>
  );
}

function NavItem({ it, active, onClick }) {
  return (
    <div className={"item" + (active ? " active" : "")} onClick={onClick}>
      <span className="num">{it.n}</span>
      <span>{it.label}</span>
      {it.badge != null && it.badge > 0 ? <span className="badge">{it.badge}</span> : null}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
