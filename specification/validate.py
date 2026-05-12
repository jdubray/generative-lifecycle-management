#!/usr/bin/env python3
"""
Validate a sekkei tree against specification/sekkei.schema.json (v1.1).

Usage:
  python3 specification/validate.py <sekkei_root_dir>

Pipeline: YAML safe-load → JSON normalization (datetime → ISO-8601 string)
→ jsonschema Draft 2020-12 validation against the normative schema.
"""
import argparse, json, sys
from datetime import datetime, date
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator

SPEC_DIR = Path(__file__).parent
SCHEMA_PATH = SPEC_DIR / "sekkei.schema.json"


def normalize_for_json(o):
    """Coerce YAML-native datetime/date objects to ISO-8601 strings."""
    if isinstance(o, datetime):
        s = o.isoformat()
        return s.replace("+00:00", "Z") if "+00:00" in s else s
    if isinstance(o, date):
        return o.isoformat()
    if isinstance(o, dict):
        return {k: normalize_for_json(v) for k, v in o.items()}
    if isinstance(o, list):
        return [normalize_for_json(x) for x in o]
    return o


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sekkei_root", help="Path to a sekkei root directory")
    ap.add_argument("--show", type=int, default=10, help="How many failing nodes to show")
    args = ap.parse_args()

    schema = json.load(open(SCHEMA_PATH, encoding="utf-8"))
    validator = Draft202012Validator(schema)

    root = Path(args.sekkei_root)
    if not root.is_dir():
        print(f"ERROR: not a directory: {root}", file=sys.stderr)
        return 2

    total = 0
    errors_total = 0
    by_stratum = {}
    failures = []

    for yaml_path in sorted(root.rglob("*.yaml")):
        rel = yaml_path.relative_to(root)
        # Skip the dependencies file (different schema)
        if str(rel) == "nodes/dependencies/external_deps.yaml":
            continue
        try:
            docs = list(yaml.safe_load_all(open(yaml_path, encoding="utf-8")))
        except yaml.YAMLError as e:
            print(f"YAML PARSE ERROR in {rel}: {e}", file=sys.stderr)
            continue
        for doc in docs:
            if not doc or not isinstance(doc, dict) or "id" not in doc:
                continue
            total += 1
            stratum = doc.get("stratum", "<unknown>")
            by_stratum[stratum] = by_stratum.get(stratum, 0) + 1
            errs = list(validator.iter_errors(normalize_for_json(doc)))
            if errs:
                errors_total += 1
                failures.append((doc["id"], rel, errs))

    print(f"Validated {total} nodes from {root}")
    for s in ("system", "capability", "component", "interaction", "spec"):
        print(f"  {s+':':<13s} {by_stratum.get(s, 0):3d}")
    print(f"\nFailures: {errors_total} of {total} ({(total-errors_total)/max(total,1)*100:.1f}% pass rate)")

    for nid, rel, errs in failures[:args.show]:
        print(f"\n  FAIL: {nid}  ({rel})")
        for e in errs[:2]:
            print(f"    - path={list(e.absolute_path)}")
            print(f"      msg={e.message[:200]}")
    if len(failures) > args.show:
        print(f"\n  ... and {len(failures) - args.show} more failures")

    return 0 if errors_total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
== "__main__":
    sys.exit(main())
