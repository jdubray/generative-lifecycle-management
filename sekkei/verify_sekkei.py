#!/usr/bin/env python3
"""
Verify the kizo:dev.glm @ A.1 sekkei.

Six gates (matches todo-mvc/sekkei-todomvc/verify_sekkei.py):
  1. Envelope: id, stratum, title, revision, provenance present + valid spec_kind on specs
  2. Stratum hierarchy (§C.1 amendment): composes-of edges respect AllowedChildren
  3. Closure completeness: every kizo: target on composes-of/depends-on resolves
  4. Brief coverage: required brief-named nodes present
  5. Spec coverage: every Component has functional+technical+acceptance+prompt
  6. Spec quality: acceptance has deliverables+verifier; prompt has context_bundle+outputs+verifier
"""
import sys
from pathlib import Path
import yaml

SEKKEI_ROOT = Path(__file__).parent

VALID_STRATA = {"system", "capability", "component", "interaction", "spec"}
VALID_OVERRIDE_KIND = {"as_is", "with_override", "extend", "net_new"}
VALID_STATUS = {"in_work", "in_review", "released", "superseded", "obsolete"}

ALLOWED_CHILDREN = {
    "system":      {"system", "capability"},
    "capability":  {"component", "interaction", "spec"},
    "component":   {"interaction", "spec"},
    "interaction": {"spec"},
    "spec":        set(),
}

REQUIRED_NODES = {
    # Capabilities (16)
    "kizo:dev.glm.identity":             ("capability", "Cap: Identity & Access"),
    "kizo:dev.glm.authoring":            ("capability", "Cap: Sekkei Authoring"),
    "kizo:dev.glm.collaboration":        ("capability", "Cap: Real-time Collaboration"),
    "kizo:dev.glm.change_management":    ("capability", "Cap: Change Management (SCR)"),
    "kizo:dev.glm.variant_resolution":   ("capability", "Cap: Variant Resolution"),
    "kizo:dev.glm.generation":           ("capability", "Cap: Generation Pipeline"),
    "kizo:dev.glm.provenance":           ("capability", "Cap: Provenance & Attestation"),
    "kizo:dev.glm.drift_reconciliation": ("capability", "Cap: Drift Reconciliation"),
    "kizo:dev.glm.reuse_management":     ("capability", "Cap: Reuse Management"),
    "kizo:dev.glm.verification":         ("capability", "Cap: Sekkei Verification"),
    "kizo:dev.glm.agent_orchestration":  ("capability", "Cap: Agent Orchestration (Vibe Mode)"),
    "kizo:dev.glm.git":                  ("capability", "Cap: Git Integration"),
    "kizo:dev.glm.persistence":          ("capability", "Cap: Persistence Foundation"),
    "kizo:dev.glm.runtime":              ("capability", "Cap: Runtime & Middleware"),
    "kizo:dev.glm.observability":        ("capability", "Cap: Observability"),
    "kizo:dev.glm.distribution":         ("capability", "Cap: Distribution"),

    # Brief-named Components (load-bearing pure-function / FSM modules)
    "kizo:dev.glm.change_management.scr_fsm":                       ("component", "Comp: SCR FSM"),
    "kizo:dev.glm.change_management.scr_implementer":               ("component", "Comp: SCR Implementer"),
    "kizo:dev.glm.variant_resolution.resolver":                     ("component", "Comp: Variant Resolver"),
    "kizo:dev.glm.variant_resolution.sekkei_lock":                  ("component", "Comp: sekkei.lock Serializer"),
    "kizo:dev.glm.generation.pipeline":                             ("component", "Comp: Generation Pipeline"),
    "kizo:dev.glm.generation.artifact_cache":                       ("component", "Comp: Artifact Cache"),
    "kizo:dev.glm.generation.llm_client":                           ("component", "Comp: LLM Client"),
    "kizo:dev.glm.provenance.attestation_builder":                  ("component", "Comp: Attestation Builder"),
    "kizo:dev.glm.drift_reconciliation.drift_classifier":           ("component", "Comp: Drift Classifier"),
    "kizo:dev.glm.verification.gates":                              ("component", "Comp: Verifier Gates"),
    "kizo:dev.glm.collaboration.edit_lock_repository":              ("component", "Comp: Edit-Lock Repository"),
    "kizo:dev.glm.collaboration.event_bus":                         ("component", "Comp: Workspace Event Bus"),
    "kizo:dev.glm.agent_orchestration.intent_classifier":           ("component", "Comp: Intent Classifier"),
    "kizo:dev.glm.agent_orchestration.vibe_scripts":                ("component", "Comp: Vibe Mode Scripts"),
    "kizo:dev.glm.git.ecn_commit":                                  ("component", "Comp: ECN Commit Grammar"),
    "kizo:dev.glm.git.yaml_store":                                  ("component", "Comp: YAML Node Store"),
    "kizo:dev.glm.persistence.content_hash":                        ("component", "Comp: Content Hash"),
    "kizo:dev.glm.persistence.db_bootstrap":                        ("component", "Comp: DB Bootstrap"),
    "kizo:dev.glm.authoring.cel_evaluator":                         ("component", "Comp: CEL Evaluator"),

    # Brief-named Interactions (FSMs / event flows)
    "kizo:dev.glm.change_management.scr_fsm.scr_lifecycle_fsm":                       ("interaction", "Int: SCR Lifecycle FSM"),
    "kizo:dev.glm.drift_reconciliation.drift_classifier.drift_status_fsm":           ("interaction", "Int: Drift Status FSM"),
    "kizo:dev.glm.variant_resolution.variant_routes.variant_rollout_fsm":            ("interaction", "Int: Variant Rollout FSM"),
    "kizo:dev.glm.reuse_management.reuse_routes.reuse_stage_fsm":                    ("interaction", "Int: Reuse Stage FSM"),
    "kizo:dev.glm.collaboration.event_bus.workspace_event_flow":                     ("interaction", "Int: Workspace Event Flow"),
    "kizo:dev.glm.agent_orchestration.vibe_scripts.formal_gate_invariants":          ("interaction", "Int: Vibe FORMAL_GATE_INVARIANTS"),
}
REQUIRED_SPEC_KINDS_PER_COMPONENT = {"functional", "technical", "acceptance", "prompt"}
EXTERNAL_PREFIXES = ("pkg:", "dep:", "svc:", "hw:")


def load_all_nodes():
    nodes_by_id = {}
    files_seen = []
    for yaml_path in sorted(SEKKEI_ROOT.rglob("*.yaml")):
        rel = yaml_path.relative_to(SEKKEI_ROOT)
        if str(rel) == "nodes/dependencies/external_deps.yaml":
            continue
        files_seen.append(str(rel))
        try:
            docs = list(yaml.safe_load_all(open(yaml_path)))
        except yaml.YAMLError as e:
            print(f"YAML PARSE ERROR in {rel}: {e}", file=sys.stderr)
            continue
        for doc in docs:
            if not doc or not isinstance(doc, dict):
                continue
            if "id" not in doc or "stratum" not in doc:
                continue
            node_id = doc["id"]
            if node_id in nodes_by_id:
                print(f"DUPLICATE ID {node_id} in {rel}", file=sys.stderr)
            nodes_by_id[node_id] = (doc, str(rel))
    return nodes_by_id, files_seen


def check_envelope(node, src):
    errors = []
    for required in ("id", "stratum", "title", "revision", "provenance"):
        if required not in node:
            errors.append(f"  [{src}] {node.get('id','<no-id>')}: missing '{required}'")
    if node.get("stratum") not in VALID_STRATA:
        errors.append(f"  [{src}] {node.get('id')}: stratum '{node.get('stratum')}' not in {VALID_STRATA}")
    rev = node.get("revision", {})
    if isinstance(rev, dict):
        if rev.get("major") != "A":
            errors.append(f"  [{src}] {node.get('id')}: revision.major != 'A'")
        if rev.get("status") not in VALID_STATUS:
            errors.append(f"  [{src}] {node.get('id')}: revision.status '{rev.get('status')}' invalid")
    prov = node.get("provenance", {})
    if isinstance(prov, dict) and prov.get("override_kind") not in VALID_OVERRIDE_KIND:
        errors.append(f"  [{src}] {node.get('id')}: provenance.override_kind '{prov.get('override_kind')}' invalid")
    if node.get("stratum") == "spec":
        sk = node.get("spec_kind") or (node.get("body") or {}).get("spec_kind")
        if sk not in {"functional","technical","schema","business_rule","acceptance","prompt"}:
            errors.append(f"  [{src}] {node.get('id')}: invalid spec_kind '{sk}'")
    return errors


def check_stratum_hierarchy(nodes_by_id):
    errors = []
    for parent_id, (parent_node, src) in nodes_by_id.items():
        parent_stratum = parent_node.get("stratum")
        for rel in parent_node.get("relationships", []) or []:
            if rel.get("kind") != "composes-of":
                continue
            child_id = rel.get("target")
            if child_id not in nodes_by_id:
                continue
            child_stratum = nodes_by_id[child_id][0].get("stratum")
            allowed = ALLOWED_CHILDREN.get(parent_stratum, set())
            if child_stratum not in allowed:
                errors.append(f"  STRATUM VIOLATION: {parent_id} ({parent_stratum}) -> {child_id} ({child_stratum}); allowed: {allowed}")
    return errors


def check_closure(nodes_by_id):
    dangling = []
    for node_id, (node, src) in nodes_by_id.items():
        for rel in node.get("relationships", []) or []:
            target = rel.get("target", "")
            if target.startswith(EXTERNAL_PREFIXES):
                continue
            if not target.startswith("kizo:"):
                continue
            if target not in nodes_by_id:
                dangling.append(f"  [{src}] {node_id} -> {rel.get('kind')} -> MISSING: {target}")
    return dangling


def check_brief_coverage(nodes_by_id):
    missing = []
    for required_id, (required_stratum, label) in REQUIRED_NODES.items():
        if required_id not in nodes_by_id:
            missing.append(f"  MISSING: {label}: {required_id}")
        else:
            actual = nodes_by_id[required_id][0].get("stratum")
            if actual != required_stratum:
                missing.append(f"  STRATUM MISMATCH for {label}: expected {required_stratum}, got {actual}")
    return missing


def check_role_consistency(nodes_by_id):
    """Gate 2.b (v1.1.9): system_role discriminator matches position.
       - exactly 1 root per graph
       - subsystems have dbom_ref=null
       - role matches structural position (root: not composed; subsystem: composed)"""
    issues = []
    systems = [(nid, n) for nid, (n, _) in nodes_by_id.items() if n.get("stratum") == "system"]
    composed_systems = set()
    for nid, (n, _) in nodes_by_id.items():
        for rel in n.get("relationships", []) or []:
            if rel.get("kind") == "composes-of":
                t = rel.get("target", "")
                if t in nodes_by_id and nodes_by_id[t][0].get("stratum") == "system":
                    composed_systems.add(t)
    root_count = 0
    for nid, n in systems:
        body = n.get("body") or {}
        role = body.get("system_role")
        is_composed = nid in composed_systems
        if role is None:
            issues.append(f"  {nid}: missing body.system_role (v1.1.9+ requires root|subsystem|platform)")
            continue
        if role == "root":
            root_count += 1
            if is_composed:
                issues.append(f"  {nid}: declares system_role=root but IS composed-of by another System")
            if "acceptance_gate" not in body:
                issues.append(f"  {nid}: system_role=root requires body.acceptance_gate")
        elif role == "subsystem":
            if not is_composed:
                issues.append(f"  {nid}: declares system_role=subsystem but is NOT composed-of by any System")
            if body.get("dbom_ref") is not None:
                issues.append(f"  {nid}: system_role=subsystem requires body.dbom_ref=null (got {body.get('dbom_ref')!r})")
        elif role == "platform":
            pass  # reserved; no checks yet
        else:
            issues.append(f"  {nid}: invalid body.system_role {role!r}")
    if root_count != 1:
        issues.append(f"  cardinality error: expected exactly 1 root System; found {root_count}")
    return issues


def check_spec_coverage(nodes_by_id):
    issues = []
    comps = sorted(nid for nid, (n, _) in nodes_by_id.items() if n.get("stratum") == "component")
    spec_kinds_for = {cid: set() for cid in comps}
    for nid, (node, src) in nodes_by_id.items():
        if node.get("stratum") != "spec":
            continue
        sk = node.get("spec_kind") or (node.get("body") or {}).get("spec_kind")
        if not sk:
            continue
        best = None
        for cid in comps:
            if (nid.startswith(cid + ".spec") or nid.startswith(cid + ".spec_")) \
               and (best is None or len(cid) > len(best)):
                best = cid
        if best:
            spec_kinds_for[best].add(sk)
    for cid in comps:
        present = spec_kinds_for[cid]
        missing_kinds = REQUIRED_SPEC_KINDS_PER_COMPONENT - present
        if missing_kinds:
            issues.append(f"  {cid}: missing {sorted(missing_kinds)} (have {sorted(present)})")
    return issues


def check_spec_quality(nodes_by_id):
    issues = []
    for nid, (node, src) in nodes_by_id.items():
        if node.get("stratum") != "spec":
            continue
        sk = node.get("spec_kind") or (node.get("body") or {}).get("spec_kind")
        body = node.get("body") or {}
        if sk == "acceptance":
            has_v11 = "deliverables" in body and "verifier" in body
            has_legacy = "inspection_assertions" in body
            if not (has_v11 or has_legacy):
                issues.append(f"  [{src}] {nid}: acceptance lacks both v1.1 (deliverables+verifier) and legacy (inspection_assertions)")
        if sk == "prompt":
            for key in ("context_bundle", "outputs", "verifier"):
                if key not in body:
                    issues.append(f"  [{src}] {nid}: prompt missing body.{key}")
    return issues


def summarize(nodes_by_id, files_seen):
    by_stratum = {}
    for nid, (node, src) in nodes_by_id.items():
        s = node.get("stratum", "<unknown>")
        by_stratum.setdefault(s, []).append(nid)
    print("\n=== Sekkei summary ===")
    print(f"  YAML files scanned: {len(files_seen)}")
    print(f"  Total nodes:        {len(nodes_by_id)}")
    # Distinguish root System from Sub-Systems (§C.1 amendment).
    # A Sub-System is any node with stratum=system that is composed-of by another System.
    composed_systems = set()
    for nid, (n, _) in nodes_by_id.items():
        if n.get("stratum") != "system":
            continue
        for rel in n.get("relationships", []) or []:
            if rel.get("kind") == "composes-of":
                tgt = rel.get("target", "")
                if tgt in nodes_by_id and nodes_by_id[tgt][0].get("stratum") == "system":
                    composed_systems.add(tgt)
    all_systems = set(by_stratum.get("system", []))
    root_systems = all_systems - composed_systems
    print(f"  {'root System:':<13s} {len(root_systems):3d}")
    print(f"  {'Sub-System:':<13s} {len(composed_systems):3d}")
    # Distinguish root-level Capabilities from Sub-System-local Capabilities
    root_caps = 0
    sub_caps = 0
    cap_set = set(by_stratum.get("capability", []))
    for nid, (n, _) in nodes_by_id.items():
        if n.get("stratum") != "system":
            continue
        for rel in n.get("relationships", []) or []:
            if rel.get("kind") != "composes-of":
                continue
            tgt = rel.get("target", "")
            if tgt in cap_set:
                if nid in root_systems:
                    root_caps += 1
                else:
                    sub_caps += 1
    print(f"  {'Capability:':<13s} {len(by_stratum.get('capability', [])):3d}   ({root_caps} cross-cutting at root + {sub_caps} Sub-System-local)")
    for s in ("component", "interaction", "spec"):
        print(f"  {s+':':<13s} {len(by_stratum.get(s, [])):3d}")
    sk_counts = {}
    for nid, (n, _) in nodes_by_id.items():
        if n.get("stratum") == "spec":
            sk = n.get("spec_kind") or (n.get("body") or {}).get("spec_kind") or "<none>"
            sk_counts[sk] = sk_counts.get(sk, 0) + 1
    if sk_counts:
        print("  spec_kind breakdown:")
        for sk in sorted(sk_counts):
            print(f"    {sk:15s} {sk_counts[sk]:3d}")
    return by_stratum


def main():
    nodes_by_id, files_seen = load_all_nodes()
    print(f"Loaded {len(nodes_by_id)} nodes from {len(files_seen)} YAML files.")

    envelope_errors  = []
    for nid, (node, src) in nodes_by_id.items():
        envelope_errors.extend(check_envelope(node, src))
    hierarchy_errors = check_stratum_hierarchy(nodes_by_id)
    dangling         = check_closure(nodes_by_id)
    missing          = check_brief_coverage(nodes_by_id)
    spec_cov         = check_spec_coverage(nodes_by_id)
    role_issues      = check_role_consistency(nodes_by_id)
    spec_qual        = check_spec_quality(nodes_by_id)

    summarize(nodes_by_id, files_seen)

    def report(label, errs, pass_msg):
        print(f"\n=== {label} ===")
        if errs:
            print(f"  {len(errs)} issue(s):")
            for e in errs[:30]:
                print(e)
            if len(errs) > 30:
                print(f"  ...and {len(errs) - 30} more")
        else:
            print(f"  {pass_msg}")

    report("1. Envelope checks", envelope_errors, "PASS")
    report("2. Stratum hierarchy (§C.1 amendment)", hierarchy_errors, "PASS")
    report("2.b Role consistency (§C.1.b — system_role discriminator)", role_issues, "PASS")
    report("3. Closure completeness", dangling, "PASS")
    report("4. Brief coverage", missing, "PASS")
    report("5. Spec coverage (functional+technical+acceptance+prompt per Component)", spec_cov,
           "PASS — all Components have the four required spec_kinds.")
    report("6. Spec quality (acceptance has deliverables+verifier; prompt has context_bundle+outputs+verifier)", spec_qual,
           "PASS — every acceptance and prompt body has the load-bearing fields.")

    overall_ok = not (envelope_errors or hierarchy_errors or role_issues or missing or spec_cov or spec_qual)
    print("\n=== Overall A.1 acceptance gate ===")
    print(f"  {'PASS' if overall_ok else 'FAIL'} (dangling refs treated as warnings)")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
