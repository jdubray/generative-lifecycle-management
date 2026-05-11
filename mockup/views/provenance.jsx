/* ----------------------------------------------------------------------------
   08 — Provenance & Audit
   Per generation event, an in-toto Statement (DSSE signed) is emitted.
   Predicate: https://puffin.dev/glm/v1/generation
---------------------------------------------------------------------------- */

function ProvenanceView() {
  const [selectedId, setSelectedId] = useState(PROVENANCE[0].id);
  const [cacheFilter, setCacheFilter] = useState("all");
  const filtered = PROVENANCE.filter(p => cacheFilter==="all" || p.cache===cacheFilter);
  const sel = PROVENANCE.find(p => p.id === selectedId) || PROVENANCE[0];

  const totalTokens = PROVENANCE.reduce((s,p)=>s + p.tokens_in + p.tokens_out, 0);
  const hits = PROVENANCE.filter(p => p.cache === "hit").length;
  const misses = PROVENANCE.filter(p => p.cache === "miss").length;

  return (
    <>
      <div className="view-header">
        <div>
          <h1>Provenance & Audit</h1>
          <div className="sub">
            One signed in-toto Statement per generation event. Subject = artifact digest; predicate <span className="mono">https://puffin.dev/glm/v1/generation</span> records sekkei revision, parameter binding, generator identity, and cache result.
          </div>
        </div>
        <div className="actions">
          <button className="btn">Export DSSE bundle</button>
          <button className="btn">Verify signatures</button>
        </div>
      </div>

      <div className="toolbar">
        <div className="row gap-16">
          <Stat label="Generation events (30d)" value={PROVENANCE.length}/>
          <Stat label="Cache hits / misses" value={<span className="mono" style={{fontSize:13}}>{hits} / {misses}</span>}/>
          <Stat label="Tokens consumed (30d)" value={totalTokens.toLocaleString()}/>
          <Stat label="Signature coverage" value={<span className="pill released"><span className="dot"></span>100%</span>}/>
        </div>
        <div className="grow"></div>
        <div className="seg">
          {[["all","All"],["miss","Cache miss"],["hit","Cache hit"]].map(([k,l])=>(
            <button key={k} className={cacheFilter===k?"on":""} onClick={()=>setCacheFilter(k)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="split s-420" style={{height:"calc(100% - 73px - 41px)"}}>
        <div className="pane">
          <table className="tbl">
            <thead><tr>
              <th>Event</th><th>Artifact</th><th>Cache</th><th>Tokens</th>
            </tr></thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id} className={p.id===selectedId?"selected":""} onClick={()=>setSelectedId(p.id)}>
                  <td>
                    <div className="mono">{p.id}</div>
                    <div className="muted mono" style={{fontSize:10.5}}>{fmtDate(p.when)}</div>
                  </td>
                  <td className="mono">{p.subject_file}</td>
                  <td>
                    {p.cache === "hit"
                      ? <span className="pill released"><span className="dot"></span>hit</span>
                      : <span className="pill in_review"><span className="dot"></span>miss</span>}
                  </td>
                  <td className="mono">
                    <span style={{color:"var(--ink-3)"}}>{p.tokens_in.toLocaleString()}</span>
                    <span className="muted2"> → </span>
                    <span>{p.tokens_out.toLocaleString()}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="pane" style={{padding:16}}>
          <div style={{maxWidth: 880, margin: "0 auto"}}>
            <div className="row" style={{gap:8, marginBottom:6}}>
              <span className="mono muted" style={{fontSize:12}}>{sel.id}</span>
              {sel.cache === "hit"
                ? <span className="pill released"><span className="dot"></span>cache hit · no LLM call</span>
                : <span className="pill in_review"><span className="dot"></span>cache miss · regenerated</span>}
              {sel.signed && <span className="pill released"><span className="dot"></span>DSSE signed</span>}
            </div>
            <h2 style={{margin:"0 0 4px",fontSize:17,fontWeight:600}}>{sel.subject_file}</h2>
            <div className="mono muted" style={{fontSize:11.5,marginBottom:12}}>{fmtDate(sel.when)} · subject <Hash value={sel.subject_digest}/></div>

            {sel.note && <div className="callout" style={{marginBottom:12}}>{sel.note}</div>}

            <Section title="Sekkei">
              <KV rows={[
                ["root", <span className="linkish mono" onClick={()=>{window.__glm?.setSelectedNodeId(sel.sekkei.root);window.__glm?.goto("sekkei");}}>{sel.sekkei.root}</span>],
                ["revision", <span className="mono">{sel.sekkei.rev}</span>],
                ["lock digest", <Hash value={sel.sekkei.lock}/>]
              ]}/>
            </Section>

            <Section title="Binding">
              <KV rows={[
                ["parameter hash", <Hash value={sel.binding_hash}/>]
              ]}/>
            </Section>

            <Section title="Generator">
              <KV rows={[
                ["llm",            <span className="mono">{sel.generator.llm}</span>],
                ["prompt version", <Hash value={sel.generator.prompt_version}/>],
                ["tool chain",     <Hash value={hash("toolchain","bun-1.1")}/>],
                ["duration",       <span className="mono">{sel.duration_ms} ms</span>],
                ["tokens",         <span className="mono">{sel.tokens_in.toLocaleString()} in → {sel.tokens_out.toLocaleString()} out</span>],
                ["cache",          sel.cache === "hit"
                  ? <span className="pill released"><span className="dot"></span>hit</span>
                  : <span className="pill in_review"><span className="dot"></span>miss</span>]
              ]}/>
            </Section>

            <Section title="in-toto Statement (predicate body)" right={<button className="btn ghost sm">Copy JSON</button>}>
              <YamlBlock src={
`{\n  "_type": "https://in-toto.io/Statement/v1",\n  "subject": [{\n    "name": "${sel.subject_file}",\n    "digest": { "sha256": "${sel.subject_digest.replace(/^sha256:/,"")}" }\n  }],\n  "predicateType": "https://puffin.dev/glm/v1/generation",\n  "predicate": {\n    "sekkei": {\n      "root_id": "${sel.sekkei.root}",\n      "revision": "${sel.sekkei.rev}",\n      "lock_digest": "${sel.sekkei.lock}"\n    },\n    "binding":   { "parameter_hash": "${sel.binding_hash}" },\n    "generator": {\n      "llm":            "${sel.generator.llm}",\n      "prompt_version": "${sel.generator.prompt_version}",\n      "tool_chain":     "${hash("toolchain","bun-1.1")}"\n    },\n    "metrics":   {\n      "tokens_in":  ${sel.tokens_in},\n      "tokens_out": ${sel.tokens_out},\n      "duration_ms": ${sel.duration_ms},\n      "cache": "${sel.cache}"\n    }\n  }\n}`}/>
            </Section>

            <Section title="DSSE envelope">
              <KV rows={[
                ["payload type", <span className="mono">application/vnd.in-toto+json</span>],
                ["signing key",  <Hash value={hash("kms","key-id-glm-prod")}/>],
                ["fulcio cert",  <Hash value={hash("fulcio","cert-2026-05")}/>],
                ["transparency log entry", <span className="mono">rekor.sigstore.dev/index/{djb2("entry-"+sel.id)}</span>]
              ]}/>
            </Section>
          </div>
        </div>
      </div>
    </>
  );
}

window.ProvenanceView = ProvenanceView;
