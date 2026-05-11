/* ----------------------------------------------------------------------------
   Shared components
---------------------------------------------------------------------------- */
const { useState, useMemo, useEffect, useRef, Fragment } = React;

/* ---------- Pills ---------- */
function StatusPill({ status }) {
  const map = {
    in_work: "In Work",
    in_review: "In Review",
    released: "Released",
    superseded: "Superseded",
    obsolete: "Obsolete"
  };
  return (
    <span className={"pill " + status}>
      <span className="dot"></span>
      {map[status] || status}
    </span>
  );
}

function StratumTag({ s }) {
  return <span className="tag">{STRATUM_LABEL[s]}</span>;
}

function ClassBadge({ cls }) {
  return (
    <span className={"pill " + (cls === "I" ? "warn" : "outline")}>
      Class {cls}
    </span>
  );
}

function Hash({ value, len = 10 }) {
  if (!value) return <span className="muted2 mono">—</span>;
  const v = value.replace(/^sha256:/, "");
  return <span className="hash" title={value}>{v.slice(0, len)}</span>;
}

/* ---------- Section ---------- */
function Section({ title, right, children, tight }) {
  return (
    <div className="section">
      <div className="sec-head">
        <span>{title}</span>
        {right ? <span className="right">{right}</span> : null}
      </div>
      <div className={"sec-body" + (tight ? " tight" : "")}>{children}</div>
    </div>
  );
}

/* ---------- KV grid ---------- */
function KV({ rows }) {
  return (
    <dl className="kv">
      {rows.map((r, i) => (
        <Fragment key={i}>
          <dt>{r[0]}</dt>
          <dd>{r[1]}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/* ---------- Diff renderer ---------- */
function DiffBlock({ lines }) {
  return (
    <div className="diff">
      {lines.map((l, i) => (
        <div key={i} className={"line " + (l.kind === "add" ? "add" : l.kind === "del" ? "del" : l.kind === "hunk" ? "hunk" : "")}>
          {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : l.kind === "hunk" ? "" : "  "}{l.text}
        </div>
      ))}
    </div>
  );
}

/* ---------- YAML pretty-print (lightweight, color-by-line) ---------- */
function YamlBlock({ src }) {
  return (
    <pre className="yaml">
      {src.split("\n").map((line, i) => {
        if (/^\s*#/.test(line)) return <div key={i}><span className="c">{line}</span></div>;
        const m = line.match(/^(\s*[-]?\s*)([A-Za-z_][\w]*)(:\s*)(.*)$/);
        if (m) {
          const [, lead, key, sep, val] = m;
          const valNode =
            /^["'].*["']$/.test(val) ? <span className="s">{val}</span> :
            /^-?\d+(\.\d+)?$/.test(val) ? <span className="n">{val}</span> :
            <span>{val}</span>;
          return <div key={i}>{lead}<span className="k">{key}</span>{sep}{valNode}</div>;
        }
        return <div key={i}>{line}</div>;
      })}
    </pre>
  );
}

/* ---------- Empty state ---------- */
function Empty({ children }) { return <div className="empty">{children}</div>; }

/* ---------- Tiny SVG iconset (geometric) ---------- */
const Icon = {
  chev: (p) => <svg width="9" height="9" viewBox="0 0 9 9" {...p}><path d="M2 1.5 L6 4.5 L2 7.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  chevd: (p) => <svg width="9" height="9" viewBox="0 0 9 9" {...p}><path d="M1.5 3 L4.5 6.5 L7.5 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  dot: (p) => <svg width="6" height="6" viewBox="0 0 6 6" {...p}><circle cx="3" cy="3" r="2.4" fill="currentColor"/></svg>,
  search: (p) => <svg width="12" height="12" viewBox="0 0 12 12" {...p}><circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M7.5 7.5 L10.5 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  plus: (p) => <svg width="11" height="11" viewBox="0 0 11 11" {...p}><path d="M5.5 1.5 V9.5 M1.5 5.5 H9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  arrow: (p) => <svg width="11" height="11" viewBox="0 0 11 11" {...p}><path d="M2 5.5 H9 M6 2.5 L9 5.5 L6 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
};

Object.assign(window, { StatusPill, StratumTag, ClassBadge, Hash, Section, KV, DiffBlock, YamlBlock, Empty, Icon });
