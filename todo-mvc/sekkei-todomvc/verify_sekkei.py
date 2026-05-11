#!/usr/bin/env python3
"""
Verify the kizo:web.todomvc @ A.0 sekkei.

Checks:
  1. Schema validity — every node has the common envelope (id, stratum,
     title, revision, provenance) and stratum is a known value.
  2. Stratum hierarchy — System contains System|Capability;
     Capability contains Component|Interaction|Spec; Component contains
     Interaction|Spec; Interaction contains Spec; Spec is a leaf.
  3. Closure completeness — every composes-of / depends-on / derives-from
     target id resolves to an authored node (or a known external dep).
  4. Brief coverage — every brief-named target is present:
       Capabilities: todo_management, web_ui
       Components (8): todo_repository, todo_filter_engine, todo_rest_api,
                       todo_pwa_shell, add_todo_input, todo_list_view,
                       footer_view, todo_filter_router
       Interactions (4): todo_schema, rest_api_contract, edit_mode_fsm,
                        url_hash_event_flow
  5. Spec coverage — every Component has spec.functional, spec.technical,
     spec.acceptance, and spec.prompt at minimum.
  6. Acceptance/prompt sanity — every spec.acceptance has deliverables
     and a verifier; every spec.prompt has context_bundle, outputs, and
     verifier.
"""
import os, sys, re, json
from pathlib import Path

import yaml

SEKKEI_ROOT = Path("/sessions/gifted-epic-cannon/mnt/glm/sekkei-todomvc")

VALID_STRATA = {"system", "capability", "component", "interaction", "spec"}
VALID_OVERRIDE_KIND = {"as_is", "with_override", "extend", "net_new"}
VALID_STATUS = {"in_work", "in_review", "released", "superseded", "obsolete"}
VALID_SPEC_KINDS = {"functional", "technical", "schema", "business_rule", "acceptance", "prompt"}

# §C.1 amendment hierarchy
ALLOWED_CHILDREN = {
    "system":      {"system", "capability"},
    "capability":  {"component", "interaction", "spec"},
    "component":   {"interaction", "spec"},
    "interaction": {"spec"},
    "spec":        set(),
}

REQUIRED_NODES = {
    # Capabilities
    "kizo:web.todomvc.todo_management": ("capability", "Cap: Todo Management"),
    "kizo:web.todomvc.web_ui":          ("capability", "Cap: Web UI"),

    # 8 Components
    "kizo:web.todomvc.todo_management.todo_repository":     ("component", "Comp: Todo Repository"),
    "kizo:web.todomvc.todo_management.todo_filter_engine":  ("component", "Comp: Todo Filter Engine"),
    "kizo:web.todomvc.todo_management.todo_rest_api":       ("component", "Comp: Todo REST API"),
    "kizo:web.todomvc.web_ui.todo_pwa_shell":               ("component", "Comp: TodoMVC PWA Shell"),
    "kizo:web.todomvc.web_ui.add_todo_input":               ("component", "Comp: Add Todo Input"),
    "kizo:web.todomvc.web_ui.todo_list_view":               ("component", "Comp: Todo List View"),
    "kizo:web.todomvc.web_ui.footer_view":                  ("component", "Comp: Footer View"),
    "kizo:web.todomvc.web_ui.todo_filter_router":           ("component", "Comp: Todo Filter Router"),

    # 4 Interactions
    "kizo:web.todomvc.todo_management.todo_repository.todo_schema":             ("interaction", "Int: Todo Schema (DDL)"),
    "kizo:web.todomvc.todo_management.todo_rest_api.rest_api_contract":         ("interaction", "Int: REST API Contract"),
    "kizo:web.todomvc.web_ui.todo_list_view.edit_mode_fsm":                     ("interaction", "Int: Edit Mode FSM"),
    "kizo:web.todomvc.web_ui.todo_filter_router.url_hash_event_flow":           ("interaction", "Int: URL Hash Event Flow"),
}

# Components every spec set must cover
COMPONENTS_FOR_SPEC_COVERAGE = [
    "kizo:web.todomvc.todo_management.todo_repository",
    "kizo:web.todomvc.todo_management.todo_filter_engine",
    "kizo:web.todomvc.todo_management.todo_rest_api",
    "kizo:web.todomvc.web_ui.todo_pwa_shell",
    "kizo:web.todomvc.web_ui.add_todo_input",
    "kizo:web.todomvc.web_ui.todo_list_view",
    "kizo:web.todomvc.web_ui.footer_view",
    "kizo:web.todomvc.web_ui.todo_filter_router",
]
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
        with open(yaml_path) as f:
            try:
                docs = list(yaml.safe_load_all(f))
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
            errors.append(f"  [{src}] {node.get('id')}: revision.major != 'A' (got {rev.get('major')})")
        if rev.get("status") not in VALID_STATUS:
            errors.append(f"  [{src}] {node.get('id')}: revision.status '{rev.get('status')}' not in {VALID_STATUS}")
    prov = node.get("provenance", {})
    if isinstance(prov, dict) and prov.get("override_kind") not in VALID_OVERRIDE_KIND:
        errors.append(f"  [{src}] {node.get('id')}: provenance.override_kind '{prov.get('override_kind')}' invalid")
    if node.get("stratum") == "spec":
        sk = node.get("spec_kind")
        if sk not in VALID_SPEC_KINDS:
            errors.append(f"  [{src}] {node.get('id')}: spec_kind '{sk}' not in {VALID_SPEC_KINDS}")
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
                errors.append(f"  STRATUM VIOLATION: {parent_id} ({parent_stratum}) composes-of {child_id} ({child_stratum}); allowed: {allowed}")
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
                missing.append(f"  STRATUM MISMATCH for {label} ({required_id}): expected {required_stratum}, got {actual}")
    return missing


def check_spec_coverage(nodes_by_id):
    """For each Component, verify required spec_kinds exist."""
    issues = []
    for comp_id in COMPONENTS_FOR_SPEC_COVERAGE:
        if comp_id not in nodes_by_id:
            issues.append(f"  COMPONENT MISSING: {comp_id} — cannot check spec coverage")
            continue
        present = set()
        for nid, (node, src) in nodes_by_id.items():
            if node.get("stratum") == "spec" and nid.startswith(comp_id + ".spec."):
                present.add(node.get("spec_kind"))
        missing_kinds = REQUIRED_SPEC_KINDS_PER_COMPONENT - present
        if missing_kinds:
            issues.append(f"  {comp_id}: missing spec_kinds {sorted(missing_kinds)} (have {sorted(present)})")
    return issues


def check_spec_quality(nodes_by_id):
    """Acceptance specs must have deliverables + verifier; prompts must have context_bundle + outputs + verifier."""
    issues = []
    for nid, (node, src) in nodes_by_id.items():
        if node.get("stratum") != "spec":
            continue
        sk = node.get("spec_kind")
        body = node.get("body") or {}
        if sk == "acceptance":
            if "deliverables" not in body:
                issues.append(f"  [{src}] {nid}: spec.acceptance missing body.deliverables")
            if "verifier" not in body:
                issues.append(f"  [{src}] {nid}: spec.acceptance missing body.verifier")
        if sk == "prompt":
            for key in ("context_bundle", "outputs", "verifier"):
                if key not in body:
                    issues.append(f"  [{src}] {nid}: spec.prompt missing body.{key}")
    return issues


def summarize(nodes_by_id, files_seen):
    by_stratum = {}
    for nid, (node, src) in nodes_by_id.items():
        s = node.get("stratum", "<unknown>")
        by_stratum.setdefault(s, []).append(nid)
    print("\n=== Sekkei summary ===")
    print(f"  YAML files scanned: {len(files_seen)}")
    print(f"  Total nodes:        {len(nodes_by_id)}")
    for s in ("system", "capability", "component", "interaction", "spec"):
        print(f"  {s+':':<13s} {len(by_stratum.get(s, [])):3d}")
    # Spec-kind breakdown
    spec_kind_counts = {}
    for nid, (node, src) in nodes_by_id.items():
        if node.get("stratum") == "spec":
            sk = node.get("spec_kind", "<none>")
            spec_kind_counts[sk] = spec_kind_counts.get(sk, 0) + 1
    if spec_kind_counts:
        print("  spec_kind breakdown:")
        for sk in sorted(spec_kind_counts):
            print(f"    {sk:15s} {spec_kind_counts[sk]:3d}")
    return by_stratum


def main():
    nodes_by_id, files_seen = load_all_nodes()
    print(f"Loaded {len(nodes_by_id)} nodes from {len(files_seen)} YAML files.")

    envelope_errors = []
    for nid, (node, src) in nodes_by_id.items():
        envelope_errors.extend(check_envelope(node, src))
    hierarchy_errors = check_stratum_hierarchy(nodes_by_id)
    dangling         = check_closure(nodes_by_id)
    missing_brief    = check_brief_coverage(nodes_by_id)
    spec_coverage    = check_spec_coverage(nodes_by_id)
    spec_quality     = check_spec_quality(nodes_by_id)

    summarize(nodes_by_id, files_seen)

    def report(label, errors):
        print(f"\n=== {label} ===")
        if errors:
            print(f"  {len(errors)} issue(s):")
            for e in errors[:30]:
                print(e)
            if len(errors) > 30:
                print(f"  ...and {len(errors) - 30} more")
        else:
            print("  PASS")

    report("1. Envelope checks", envelope_errors)
    report("2. Stratum hierarchy (§C.1 amendment)", hierarchy_errors)
    report("3. Closure completeness (composes-of / depends-on targets)", dangling)
    report("4. Brief coverage", missing_brief)
    report("5. Spec coverage (functional+technical+acceptance+prompt per Component)", spec_coverage)
    report("6. Spec quality (acceptance has deliverables+verifier; prompt has context_bundle+outputs+verifier)", spec_quality)

    overall_ok = not (envelope_errors or hierarchy_errors or missing_brief or spec_coverage or spec_quality)
    print("\n=== Overall A.0 acceptance gate ===")
    print(f"  {'PASS' if overall_ok else 'FAIL'} (dangling references treated as warnings; review report)")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
