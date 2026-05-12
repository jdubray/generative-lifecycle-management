# GLM with Git

How Git supports the seven PLM-derived processes that operate on a sekkei.

This is a short, practical document. It maps each GLM process to a concrete Git primitive, gives the conventions that make the mapping work, and lists the anti-patterns that break it. It assumes the sekkei layout this project uses (`sekkei.yaml`, `nodes/`, `specification/`, `verify_sekkei.py`) and the v1.1.9 schema.

---

## 1. Why Git fits

PLM systems were built around design-as-asset before software had a need for the discipline. They invented engineering change orders, effectivity tables, where-used queries, drift detection, and signed provenance. Git already gives most of these primitives — they just weren't named with PLM vocabulary. A sekkei is a hierarchical, content-addressed graph of YAML files. Git is a content-addressed, hierarchical, branch-aware version-control system. The fit is almost free.

What Git does NOT give for free: pinning the closure of an evaluated sekkei (handled by a `sekkei.lock` file, analogous to `flake.lock`), tying a generated artifact to the design hash that produced it (handled by git notes plus in-toto attestations), and effectivity rules (handled by tags + branch policy).

---

## 2. The mapping at a glance

| GLM / PLM process              | Git primitive(s)                                        | Convention used here                                                           |
|--------------------------------|---------------------------------------------------------|--------------------------------------------------------------------------------|
| Sekkei Change Management       | commit + commit message + signed-off-by                 | One commit = one ECN; subject line names the affected node id(s)               |
| Variant Resolution             | branch + sekkei.lock                                    | Operator variant = long-lived branch; resolved closure pinned in `sekkei.lock` |
| Where-Used Analysis            | `git log -L` / `git grep` / pre-built graph index       | `make where-used ID=<node-id>` scans `composes-of`, `depends-on`, `derives-from` |
| Effectivity & Rollout          | tags + branch policy                                    | Major release = signed annotated tag `A.0`, `A.1`, `B.0`, …; pre-receive hook rejects mutations to released revisions |
| Drift Reconciliation           | git diff between sekkei and realization repo            | `realization_file` paths in each Component drive a recurring drift report      |
| Reuse & Inheritance            | branch + cherry-pick + git subtree (shared catalog)     | Catalog Components live in `glm-catalog` repo, pulled in as `git subtree`; sector forks branch off the parent sekkei |
| Provenance & Audit             | git notes + signed commits + SBOM emission              | Each generated artifact's content hash is attached to the originating sekkei commit via `git notes add --ref=refs/notes/generation` |
| Generation Pipeline            | post-commit / CI workflow + content-addressed cache     | CI dispatches per-Component prompts whose `context_bundle` hashes feed the generation cache |

---

## 3. Repository layout

Three repositories work together. Each has a different lifecycle and a different access policy.

```
glm-sekkei/                 # the sekkei itself — what this project is
  sekkei.yaml
  nodes/...
  specification/...
  sekkei.lock               # pinned (id, major, content_hash) closure
  verify_sekkei.py
  Makefile                  # where-used, drift, regen targets

glm-realization/            # the current generated code; treated as derived
  src/...
  test/...
  REGENERATED_FROM          # plain text: the sekkei commit + sekkei.lock content hash
  in_toto.attestation.json

glm-catalog/                # community-shared Components, pulled in via subtree
  payment/...
  scheduling/...
```

The realization repo is not committed back into the sekkei repo. The PLM analog: you don't store the machined steel BACK into the CAD model. The realization carries a single small file (`REGENERATED_FROM`) pointing at the sekkei commit it derived from; that's the inverse-of-`generates` link.

If you want a single-repo workflow for small projects, fold the realization under `glm-sekkei/realization/` and add it to `.gitignore` for production branches, untracked locally. The hash chain still flows through `REGENERATED_FROM`.

---

## 4. Per-process workflows

### 4.1 Sekkei Change Management (the ECN)

One commit = one engineering change. The commit subject names the affected node ids; the body explains *why* the change was made; the body lists impact (which downstream nodes need re-evaluation or regeneration).

```
ECN: tighten refund_engine.spec.business_rule to require WebAuthn step-up

Affected:
  - kizo:food.fullservicerestaurant.payment.refund_engine.spec.business_rule
  - kizo:food.fullservicerestaurant.payment.refund_engine.spec.acceptance

Why:
  Compliance team flagged that the existing rule is documented intent only —
  the code path doesn't enforce it. This is a real gap, not just a doc fix:
  refund_engine.spec.acceptance now adds a test case that requires a recent
  WebAuthn assertion in the request context.

Regen required:
  - v2/src/routes/dashboard-refunds.ts (re-emit; add WebAuthn check)
  - v2/test/refund-engine.test.ts (re-emit)

Signed-off-by: jjdub@hanuman.local
```

The Affected/Why/Regen blocks are conventional, not enforced. A pre-commit hook (§5) can validate that every commit touching a sekkei node carries an `Affected:` block, but it shouldn't be over-strict — small typo fixes warrant a shorter form.

### 4.2 Variant Resolution

A variant is a *long-lived branch* off the parent sekkei, with one commit that pins the operator-specific parameter values. The pin lives in `sekkei.lock`:

```yaml
# sekkei.lock — pinned by Variant Resolution
root_id: kizo:food.fullservicerestaurant
parameter_binding:
  currency: USD
  locale: en-US
  tax_jurisdiction: US-WA-King
  hardware_class: raspberrypi_5
  payment_processor_dine_in: finix
  payment_processor_counter: finix
  receipt_printer_class: star_tsp143iii
  course_2_auto_fire_after_min: 15
nodes:
  - id: kizo:food.fullservicerestaurant
    major: A
    content_hash: sha256:9a3f...
  - id: kizo:food.fullservicerestaurant.payment.payment_state_machine
    major: A
    content_hash: sha256:1bf2...
  # ... one entry per evaluated node
generator_identity:
  llm: claude-opus-4-7
  prompt_version: sha256:c2d1...
  tool_chain: sha256:88aa...
```

The branch name encodes the variant: `variants/hanuman-kirkland`, `variants/cosmetic-eastside`. Pulling the parent's improvements into a variant is a normal `git merge` (or `git rebase` if you want a linear history per variant).

### 4.3 Where-Used Analysis

Three tools cover the cases:

- **`git grep`** for finding every node that references a given id:
  ```bash
  git grep "kizo:food.fullservicerestaurant.payment.payment_state_machine"
  ```
- **`git log -L:<symbol>:<path>`** for finding the history of a specific structural slot (e.g., when did `dbom_ref` change on the root System?):
  ```bash
  git log -L:dbom_ref:sekkei.yaml
  ```
- **A pre-built index** for graph-walking the closure:
  ```bash
  make where-used ID=kizo:food.fullservicerestaurant.payment.payment_state_machine
  # Walks composes-of, depends-on, derives-from edges and prints
  # every variant branch whose sekkei.lock includes this node id at any revision.
  ```

The Makefile target is ~30 lines of Python over `git for-each-ref` + a YAML walk of the locks across branches.

### 4.4 Effectivity & Rollout Management

Major releases follow ASME Y14.35: signed annotated tags with letters A..Y (skip I/O/Q/S/X/Z). Iteration suffixes (`A.1`, `A.2`) are also tags but lightweight. Released revisions are immutable; a pre-receive hook on the origin enforces:

```bash
#!/bin/sh
# .git/hooks/pre-receive — paste into origin server hook
while read old new ref; do
  case "$ref" in
    refs/tags/[A-HJ-NPRTUV-WY])
      if [ "$old" != "0000000000000000000000000000000000000000" ]; then
        echo "Refusing to rewrite released tag $ref"
        exit 1
      fi
      ;;
  esac
done
```

Rollout is per-variant: a variant branch's commit timestamp answers "when did this operator move from A.0 → A.1?". A `effectivity.yaml` at the System root can attach more granular effectivity rules:

```yaml
effectivity:
  - rule: serial_number_range
    nodes: [kizo:food.fullservicerestaurant.payment.payment_state_machine]
    from: appliance#001
    to:   appliance#999
  - rule: date_effective
    nodes: [kizo:food.fullservicerestaurant.reporting.fog_compliance_log]
    not_before: 2026-07-01   # regulatory deadline
```

### 4.5 Drift Reconciliation

Drift is the gap between the sekkei (as-designed) and the realization (as-built). The two-repo layout makes drift detection mechanical: every Component's `realization_file` is a path into `glm-realization/`. A drift job iterates the sekkei, opens each realization file, and checks for divergence.

The most useful question is "did the realization change in a way the sekkei didn't predict?" — answered by:

```bash
# In glm-realization/, compute the content hash of each file referenced
# from the sekkei's realization_file fields.
make drift-report SEKKEI_REF=A.1
# Output:
#   v2/src/workflows/terminal-payment.ts   sekkei expects sha256:1bf2...  realization is sha256:1bf2...  OK
#   v2/src/services/printer.ts             sekkei expects sha256:9c4d...  realization is sha256:7e11...  DRIFT
```

Drift on a single file usually means either (a) the operator hot-patched in production (legitimate or not), or (b) the regenerator improved on the spec and the sekkei should be revised to match. The Drift Reconciliation process classifies each diff into one of those buckets; revert or pull-into-sekkei follows.

### 4.6 Reuse & Inheritance Management

Two patterns, one PLM convention:

**Inherit-as-is** (the §C.2 default): the variant references the parent node by `(id, content_hash)` and never copies it. In Git, that's normal branch inheritance — the parent's commits flow into the variant via merge or rebase. No new mechanism needed.

**Community catalog** (cross-sekkei reuse): when a Component graduates to community-shared, it moves to `glm-catalog/`, and consuming sekkeis pull it in via `git subtree`:

```bash
git subtree add --prefix=nodes/components/_catalog/payment_processor_dispatch \
                git@github.com:kizo/glm-catalog.git \
                payment_processor_dispatch/A.1 \
                --squash
```

The squash flattens the subtree's history into a single commit on the consuming side, with the catalog version pinned. Updates pull the same way (`git subtree pull`). This matches the PLM "Standard Part" concept: a part with its own identity and revision history, referenced by many products but maintained centrally.

A `varies-from` relationship in the sekkei (essay §C.5) corresponds to an Alternate/Substitute selection: when two catalog Components are interchangeable, the variant's sekkei.lock pins the chosen one; the `varies-from` edge documents the alternate.

### 4.7 Provenance & Audit

Every generated artifact carries an in-toto attestation that ties it back to:

- the sekkei commit hash
- the sekkei.lock content hash (capturing the resolved closure)
- the LLM identity + prompt-version content hash + generator-binary content hash

In Git, the in-toto attestation is stored as a **git note** on the sekkei commit:

```bash
git notes --ref=refs/notes/generation add -m "$(jq -c . in_toto.attestation.json)" <sekkei-commit>
```

Notes are signed (`git config notes.rewriteRef refs/notes/generation` + commit signing) so the chain is tamper-evident. To audit "what produced this binary on Hanuman appliance#003":

```bash
# 1. Read the binary's embedded REGENERATED_FROM file
cat REGENERATED_FROM
# sekkei_commit: e7a9...
# sekkei_lock_hash: sha256:6c1f...

# 2. Pull the generation note on that commit
git notes --ref=refs/notes/generation show e7a9...
# {... full in-toto attestation including LLM id and prompt hash ...}

# 3. Replay the generation if needed
make regenerate SEKKEI_COMMIT=e7a9... LOCK_HASH=sha256:6c1f...
```

This is the analog of the SBOM movement, except the SBOM is the SIDE-EFFECT of the generation, not a separately-built document. The sekkei IS the supply chain manifest.

### 4.8 Generation Pipeline

CI runs on every push to the sekkei. For each Component whose `content_hash` changed since the last release tag:

1. **Hit the generation cache** keyed on `(content_hash, parameter_binding_hash, generator_identity)`. If hit, fetch the artifact; goto step 4.
2. **Miss the cache**: dispatch the Component's `spec.prompt` to the LLM with the bundle described in `body.context_bundle`. Save the produced files to `glm-realization/`.
3. **Run the embedded `spec.acceptance.verifier.command`**. If it returns non-zero, the regeneration is INCOMPLETE — open an issue with the sekkei author, do not merge.
4. **Emit the in-toto attestation** and attach it to the sekkei commit as a git note.
5. **Update `REGENERATED_FROM`** in the realization repo.

This is a roughly 200-line CI workflow once the cache infrastructure exists. The cache itself is whatever you have: S3 bucket keyed by hash, a local content-addressed directory, or a proper artifact store. Nix-style hash-locked output paths give you most of what you want.

---

## 5. Pre-commit and pre-receive hooks

Two layers. Pre-commit is advisory (local, fast); pre-receive is mandatory (origin, enforces release immutability).

```bash
# .git/hooks/pre-commit (in glm-sekkei/)
#!/bin/sh
set -e
python3 verify_sekkei.py > /tmp/verify.log 2>&1 || {
  echo "verify_sekkei.py failed:"
  cat /tmp/verify.log
  exit 1
}
python3 specification/validate.py . --show 5 > /tmp/validate.log 2>&1 || {
  echo "specification/validate.py failed:"
  cat /tmp/validate.log
  exit 1
}
# YAML safety: refuse commits with null bytes
git diff --cached --name-only -z | xargs -0 grep -l $'\x00' 2>/dev/null && {
  echo "Refusing commit: null bytes detected in staged YAML"
  exit 1
}
```

The pre-receive hook (on origin) enforces:

- released tags are immutable
- every commit touching `nodes/` carries an `Affected:` line in the commit body
- the sekkei must pass `verify_sekkei.py` (in case the local pre-commit was bypassed)

---

## 6. Branch and tag conventions

| Ref pattern                  | Purpose                                                                          |
|------------------------------|----------------------------------------------------------------------------------|
| `main`                       | Released sekkei trunk; only fast-forward merges from `next` allowed              |
| `next`                       | Integration branch for the next major release; gates on full verifier pass      |
| `feature/<id>-<short>`       | Single ECN in progress; merged into `next` via PR                                 |
| `variants/<operator>`        | Long-lived per-operator branch; rebased on `main` for upstream improvements      |
| `forks/<sector>.<subsector>` | Sector fork (e.g., `forks/health.practice.cosmetic`)                              |
| `tag: A.0`, `A.1`, `B.0`, …  | Major + iteration; signed annotated tags; immutable                              |
| `tag: variants/hanuman/A.1`  | Operator variant resolution against a specific major; immutable on origin        |

A typical PR shape: feature branch → `next` → tag `A.<n+1>` → `main` (fast-forward).

---

## 7. Anti-patterns

- **Don't merge generated code back into the sekkei branch.** The realization is derived; checking it in pollutes the design history with build artifacts and confuses `git log` analysis.
- **Don't squash commits that span an ECN.** The spec→regen→test→tag chain MUST be preserved as separate commits so `git bisect` works on behavioral regressions.
- **Don't edit released revisions.** A pre-receive hook should refuse it. A correct change post-release is a new iteration (`A.1 → A.2`), not a re-tag.
- **Don't put the dBOM in the sekkei repo.** Different lifecycle (per-deployment, mutable, secret-bearing). The dBOM lives in its own repo (`glm-dbom/`) keyed by the sekkei commit it realizes.
- **Don't commit `sekkei.lock` without committing the matching node revisions.** If the lock pins a content_hash that isn't reachable from the commit's tree, downstream `make regenerate` will fail mysteriously.
- **Don't use `git submodule` for the catalog.** Subtrees are better here — submodules require consumers to know the catalog URL, version-pinning is awkward, and the catalog history shouldn't appear separate in `git log` for a consuming sekkei.
- **Don't conflate variant resolution with feature work.** A variant branch should ONLY differ from `main` in `sekkei.lock` + small overrides. If `variants/hanuman` accumulates feature changes, those changes belong on `feature/*` branches with PRs.

---

## 8. Future bridges

A few primitives we haven't needed yet but will:

- **Git LFS for the generation cache**: large artifacts (Tauri bundles, prebuilt printer firmwares) keyed by their input closure hash. LFS handles the storage; the sekkei.lock holds the pointer.
- **GitHub / GitLab CODEOWNERS for spec stewards**: every `nodes/specs/by_component/<x>_specs.yaml` has an owner per the Capability it belongs to. Reviews route automatically.
- **A `git fsck`-style verifier for the design cache**: walk every reachable commit, recompute the content hash for every node, confirm the sekkei.lock entries still resolve. Cheap to run weekly.
- **Hooks for in-toto verification before pull**: refuse to fast-forward `main` if the latest commit's attached generation note doesn't verify against the configured generator identity. This is overkill for an internal repo but useful when accepting community-contributed Components into the catalog.

---

## 9. Cheat sheet

```bash
# Verify the sekkei locally (gates 1-6 + 2.b)
python3 verify_sekkei.py
python3 specification/validate.py .

# See which variants pin a specific node revision
make where-used ID=kizo:food.fullservicerestaurant.payment.payment_state_machine

# Pull upstream improvements into an operator variant
git checkout variants/hanuman-kirkland
git rebase main
python3 verify_sekkei.py    # re-evaluate parameter validity
make regenerate              # if any composed-of content_hash changed

# Cut a release
git checkout next
python3 verify_sekkei.py && python3 specification/validate.py .
git tag -s -a A.1 -m "BaanBaan A.1 — spec-coverage complete, system_role discriminator"
git checkout main && git merge --ff-only next
git push --tags

# Drift report against current realization
( cd glm-realization && make drift-report SEKKEI_REF=A.1 )
```

That's the whole story. Git already does most of what GLM needs; the rest is convention, hooks, and a `Makefile` that knows where the bodies are buried.