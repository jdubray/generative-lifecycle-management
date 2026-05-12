# How to load the GLM sekkei into the GLM

The classic self-hosting question. The GLM (this directory's design) is the tool that authors sekkeis. The GLM's own sekkei (`./sekkei/`) is the design that *produces* the GLM. So how does the GLM "load itself"?

There are three answers, one for each stage of the bootstrap chain.

---

## Stage 0 — GLM doesn't exist yet (today)

Right now, the GLM application is a sekkei without a realization. The only tools that touch `./sekkei/` are:

- A text editor (or Claude Code) to author the YAML files.
- `python3 ./sekkei/verify_sekkei.py` to run the 7 gates.
- `python3 specification/validate.py ./sekkei` to validate against the JSON Schema.

No "loading into the GLM" is possible because the GLM doesn't exist as code yet. This is the same state every self-hosting compiler starts in — you write the first compiler in a different language and bootstrap from there.

The first regeneration is done by an *external* generator: Claude Code reads `./sekkei/`, walks the 6 brief-named Components' `spec.prompt` nodes, dispatches each prompt, captures the output into `./src/`, and runs every `spec.acceptance.verifier.command`. That produces the v0 GLM binary.

---

## Stage 1 — GLM exists; load its own sekkei into the running app

Once `./src/` contains a working Bun + Hono + bun:sqlite app, you boot it and import `./sekkei/` as a workspace. The path is:

```bash
# Start the GLM
cd ./src
bun install
bun run src/server.ts
# → "GLM listening on http://127.0.0.1:4040"

# In another terminal — import the GLM's own sekkei
curl -X POST http://127.0.0.1:4040/api/workspaces/import \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "directory",
    "path": "/c/Users/jjdub/code/glm/sekkei",
    "name": "glm-self",
    "role": "owner"
  }'
# → 201 + { "workspace_id": "ws_01H...", "node_count": 75 }

# Open the browser at http://127.0.0.1:4040/workspaces/ws_01H.../tree
# The tree view now shows kizo:dev.glm at the root.
```

The Component that does this is `kizo:dev.glm.persistence.workspace_importer`. Its responsibility is to:

1. Walk every `*.yaml` file under the supplied directory.
2. Validate each node against `specification/sekkei.schema.json` (the same schema this repo's `validate.py` uses).
3. Compute `content_hash` per node (the canonical sha256 over body + dependency closure).
4. Insert into the workspace SQLite DB.
5. Build the closure index that powers the where-used panel.

Equivalent flows for the same import, expressed three ways:

| Surface              | How                                                                 |
|----------------------|----------------------------------------------------------------------|
| Workbench UI         | `File → Import Sekkei → choose directory → confirm name → Load`     |
| REST API             | `POST /api/workspaces/import` with `source: 'directory'` and `path` |
| CLI (Engine binary)  | `glm import-workspace --path ./sekkei --name glm-self`              |

The directory itself isn't modified by the import. The workspace is a SQLite DB at `workspaces_root/glm-self.db`; the on-disk YAML is the source-of-truth that the import populated from. You can re-run the import to refresh the workspace (the importer is idempotent on `(id, content_hash)`), and you can `export` the workspace back to YAML for a round-trip.

---

## Stage 2 — the self-hosting cycle (daily use)

Once the GLM is loaded into itself, you edit the GLM by editing the GLM's own sekkei IN the GLM. The cycle:

```
┌─ author / edit kizo:dev.glm.* nodes in the Workbench ─────────────────┐
│                                                                       │
│ → click "Regenerate" on the Component you changed                     │
│   (or on the root System to regenerate everything affected)           │
│                                                                       │
│ → the Engine walks dirty Components (whose content_hash changed)      │
│   → assembles each Component's spec.prompt context_bundle             │
│   → dispatches to the LLM provider                                    │
│   → captures produced files into ./src.next/                          │
│   → runs every spec.acceptance.verifier.command                       │
│   → if all PASS: emits in-toto attestation, swaps ./src/ → ./src/    │
│                                                                       │
│ → restart the server (or hot-reload, if you've wired it)              │
│                                                                       │
│ → the new GLM is running, with the same workspace still loaded        │
└───────────────────────────────────────────────────────────────────────┘
```

This is the equivalent of a self-hosting compiler recompiling itself. At no point does the GLM regenerate while it is regenerating — the new binary appears in a fresh location and the running process is restarted. The two-dimensional cache means most Components don't actually regenerate (their `content_hash` didn't change); only the dirty Components incur LLM cost.

A safety property worth highlighting: the regeneration of GLM by GLM still passes through `spec_acceptance_runner`. If a buggy edit produces a binary that fails its own verifier, the swap doesn't happen. The old GLM keeps running.

---

## What about `./sekkei/` vs. the workspace DB?

After the import, two representations of the same sekkei exist:

- **On disk** (`./sekkei/*.yaml`) — version-controlled in git, the source-of-truth for the project, what reviewers diff in PRs.
- **In the workspace DB** (`workspaces_root/glm-self.db`) — the in-app representation, what the Workbench renders and the Engine reads from.

The convention (from `specification/glm_with_git.md`):

| When you do…                                       | The on-disk and DB representations stay in sync because…       |
|----------------------------------------------------|----------------------------------------------------------------|
| Edit a node in the Workbench                       | The Workbench `POST`s the change to the persistence layer AND emits a YAML write back to `./sekkei/<file>.yaml`. The git working tree shows a diff. |
| Edit a YAML file by hand and re-import             | The importer recomputes content_hashes and updates the DB. Edits in the DB that don't yet exist on disk are surfaced as "uncommitted changes."  |
| Pull a new commit from git                          | The Workbench detects the file timestamp change and prompts to re-import. After the re-import, the workspace reflects the new commit's state. |

The dual representation is the trade-off: GLM is a real-time multi-user app, so it needs a database; sekkei is a git-versioned artifact, so it needs files. The on-disk form wins on conflict; the DB is the working set.

---

## TL;DR

You load the GLM sekkei into the GLM by running the GLM (`bun run src/server.ts`) and then hitting `POST /api/workspaces/import` (or `File → Import` in the Workbench) with the path to `./sekkei/`. The Component that does this is `kizo:dev.glm.persistence.workspace_importer`. Once loaded, you can author the GLM by editing its own sekkei, regenerate from within the GLM, and restart — the self-hosting cycle.

Today, before the first regeneration, `./sekkei/` is just YAML on disk + the verifier scripts. The first GLM binary is produced by an external generator (Claude Code, or a one-off script) following `./sekkei/*.spec.prompt` like any other sekkei.
