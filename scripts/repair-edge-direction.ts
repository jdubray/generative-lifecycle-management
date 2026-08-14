#!/usr/bin/env bun
/**
 * `bun run scripts/repair-edge-direction.ts --workspace=<id> [--apply] [--db=<path>]`
 *
 * One-off repair for a workspace authored with `composes-of` edges pointing the
 * wrong way (child -> parent instead of parent -> child), with per-interaction
 * specs that gate 5 cannot attribute to a component.
 *
 * Three transformations, all structural — no node body is rewritten except the
 * root System's (see 3):
 *
 *   1. INVERT — every `composes-of` edge moves to its parent and points down.
 *      Parentage is read from the existing (inverted) edges, not from the
 *      dotted glm_id, so the author's intent is preserved exactly.
 *      `depends-on` edges are already correctly directed and are left alone.
 *
 *   2. RE-HOME SPECS — a spec named `<component>.<interaction>.spec.<kind>` is
 *      renamed to `<component>.spec.<kind>` and re-parented onto the component.
 *      Gate 5 attributes specs to components by dotted-prefix string match on
 *      the glm_id (`gates.ts:264`), never by edge, so the rename is what makes
 *      the spec count. The `composes-of` edge is moved to match, since gate 2
 *      reads only edges.
 *
 *      A System may compose a Spec directly (system-scope NFRs, boundaries,
 *      acceptance demos), so those stay put. Any spec left with no parent at
 *      all is adopted by its longest glm_id-prefix ancestor, which is where
 *      the dotted naming already says it belongs.
 *
 *   3. ACCEPTANCE GATE — gate 2.b requires `body.acceptance_gate` on the root
 *      System. Added only when absent, seeded from the workspace's own
 *      acceptance-demo spec when one exists.
 *
 * Writes go through `NodeRepository.update()` with the full relationship /
 * parameter / constraint set supplied, because `update()` deletes all three
 * child tables before rewriting them from its input. (This is the same reason
 * the HTTP `PUT /nodes/:glm_id` path silently drops edges: `buildNodeInput` in
 * `src/server/routes/nodes.ts` never populates them.)
 *
 * Defaults to a dry run. Pass `--apply` to write.
 */
import { Database } from 'bun:sqlite';
import { type NodeInput, NodeRepository } from '../src/repository/node-repository.ts';
import type { NodeRelationship, SekkeiNode } from '../src/types.ts';
import { ALLOWED_CHILDREN, type NodeRecord, runGates } from '../src/verifier/gates.ts';

interface Args {
  workspace: string;
  dbPath: string;
  apply: boolean;
}

/** A `composes-of` edge target, as it should exist after the repair. */
interface PlannedChild {
  targetGlmId: string;
  attributes: Record<string, unknown> | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    workspace: '',
    dbPath: process.env.GLM_DB_PATH ?? './data/glm.db',
    apply: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--workspace=')) args.workspace = arg.slice('--workspace='.length);
    else if (arg.startsWith('--db=')) args.dbPath = arg.slice('--db='.length);
    else if (arg === '--apply') args.apply = true;
  }
  if (!args.workspace) {
    console.error('--workspace=<id> is required');
    process.exit(2);
  }
  return args;
}

/**
 * Split `<prefix>.spec.<kind>` / `<prefix>.spec_<kind>` into its parts.
 * Returns null when the glm_id does not carry a spec suffix.
 */
function splitSpecSuffix(glmId: string): { prefix: string; suffix: string } | null {
  const dotted = glmId.lastIndexOf('.spec.');
  if (dotted !== -1) {
    return { prefix: glmId.slice(0, dotted), suffix: glmId.slice(dotted) };
  }
  const underscored = glmId.lastIndexOf('.spec_');
  if (underscored !== -1) {
    return { prefix: glmId.slice(0, underscored), suffix: glmId.slice(underscored) };
  }
  return null;
}

function toInput(
  node: SekkeiNode,
  record: NodeRecord,
  relationships: NodeRelationship[],
): NodeInput {
  return {
    id: node.id,
    workspaceId: node.workspaceId,
    glmId: node.glmId,
    stratum: node.stratum,
    title: node.title,
    description: node.description,
    body: node.body,
    revisionMajor: node.revisionMajor,
    revisionIteration: node.revisionIteration,
    revisionStatus: node.revisionStatus,
    overrideKind: node.overrideKind,
    derivesFromNodeId: node.derivesFromNodeId,
    systemRole: node.systemRole,
    specKind: node.specKind,
    authoredBy: node.authoredBy,
    authoredAt: node.authoredAt,
    generatorIdentity: node.generatorIdentity,
    // update() wipes all three child tables first — they must be passed back in full.
    parameters: record.parameters,
    constraints: record.constraints,
    relationships: relationships.map((r, ord) => ({ ...r, ord })),
  };
}

function main(): void {
  const args = parseArgs(process.argv);
  // `{ readonly: false }` is a misuse in bun:sqlite — the flags are exclusive.
  const db = args.apply
    ? new Database(args.dbPath, { readwrite: true })
    : new Database(args.dbPath, { readonly: true });
  db.exec('PRAGMA foreign_keys = ON;');
  const repo = new NodeRepository(db);
  const records = repo.listByWorkspace(args.workspace);
  if (records.length === 0) {
    console.error(`workspace ${args.workspace} has no nodes`);
    process.exit(2);
  }

  const byGlmId = new Map<string, NodeRecord>(records.map((r) => [r.node.glmId, r]));

  // --- 1. Recover parentage from the composes-of edges ------------------------
  // Each edge is oriented by asking which endpoint is the legal parent, so the
  // script is idempotent: it accepts a fully inverted tree, an already-correct
  // one, or any mix. `ALLOWED_CHILDREN` is antisymmetric everywhere except
  // system->system, where an existing edge is taken at face value.
  /** child glm_id -> { parent glm_id, edge attributes } */
  const parentOf = new Map<string, PlannedChild>();
  for (const record of records) {
    for (const rel of record.relationships) {
      if (rel.kind !== 'composes-of') continue;
      const other = byGlmId.get(rel.targetGlmId);
      if (!other) continue; // dangling target; gate 3's problem, not ours

      const sourceIsParent = ALLOWED_CHILDREN[record.node.stratum].has(other.node.stratum);
      const targetIsParent = ALLOWED_CHILDREN[other.node.stratum].has(record.node.stratum);
      if (!sourceIsParent && !targetIsParent) {
        console.error(
          `ABORT: ${record.node.glmId} (${record.node.stratum}) -- ${rel.targetGlmId} (${other.node.stratum}) is not a legal composition in either direction`,
        );
        process.exit(3);
      }
      const [childGlmId, parentGlmId] = sourceIsParent
        ? [other.node.glmId, record.node.glmId]
        : [record.node.glmId, other.node.glmId];

      const existing = parentOf.get(childGlmId);
      if (existing && existing.targetGlmId !== parentGlmId) {
        console.error(
          `ABORT: ${childGlmId} has two parents: ${existing.targetGlmId}, ${parentGlmId}`,
        );
        process.exit(3);
      }
      parentOf.set(childGlmId, { targetGlmId: parentGlmId, attributes: rel.attributes });
    }
  }

  // --- 2. Plan spec renames and re-homing ------------------------------------
  /** old glm_id -> new glm_id */
  const renames = new Map<string, string>();
  /** glm_ids adopted by their longest-prefix ancestor because they had no parent */
  const adopted: Array<{ glmId: string; parentGlmId: string }> = [];

  for (const record of records) {
    if (record.node.stratum !== 'spec') continue;
    const parent = parentOf.get(record.node.glmId);
    if (!parent) continue;
    const parentRecord = byGlmId.get(parent.targetGlmId);
    if (!parentRecord) continue;

    // A System may compose a Spec directly (system-scope NFRs, boundaries,
    // acceptance demos), so a spec parented to one stays where it is.
    if (parentRecord.node.stratum !== 'interaction') continue;

    // Hoist the spec from its interaction onto the interaction's component.
    const component = parentOf.get(parentRecord.node.glmId);
    if (!component) continue;
    const componentRecord = byGlmId.get(component.targetGlmId);
    if (!componentRecord || componentRecord.node.stratum !== 'component') continue;

    const split = splitSpecSuffix(record.node.glmId);
    if (!split) {
      console.error(
        `WARN: ${record.node.glmId} sits under an interaction but carries no .spec suffix; left alone`,
      );
      continue;
    }
    const newGlmId = `${componentRecord.node.glmId}${split.suffix}`;
    if (byGlmId.has(newGlmId) || [...renames.values()].includes(newGlmId)) {
      console.error(
        `ABORT: rename ${record.node.glmId} -> ${newGlmId} collides with an existing node`,
      );
      process.exit(3);
    }
    renames.set(record.node.glmId, newGlmId);
    parentOf.set(record.node.glmId, {
      targetGlmId: componentRecord.node.glmId,
      attributes: parent.attributes,
    });
  }

  // --- 2b. Adopt unparented specs --------------------------------------------
  // A spec that no node composes is invisible to a regenerator walking the
  // tree. Re-home each one on its longest glm_id-prefix ancestor, which is
  // where the dotted naming already says it belongs.
  for (const record of records) {
    if (record.node.stratum !== 'spec') continue;
    if (parentOf.has(record.node.glmId)) continue;

    let best: NodeRecord | null = null;
    for (const candidate of records) {
      if (candidate.node.stratum === 'spec') continue;
      if (!record.node.glmId.startsWith(`${candidate.node.glmId}.`)) continue;
      if (best === null || candidate.node.glmId.length > best.node.glmId.length) best = candidate;
    }
    if (!best) continue;

    parentOf.set(record.node.glmId, { targetGlmId: best.node.glmId, attributes: null });
    adopted.push({ glmId: record.node.glmId, parentGlmId: best.node.glmId });
  }

  // --- 3. Build the corrected downward edge set ------------------------------
  const resolve = (glmId: string): string => renames.get(glmId) ?? glmId;

  /** parent glm_id -> children, in stable glm_id order */
  const childrenOf = new Map<string, PlannedChild[]>();
  for (const [childGlmId, parent] of parentOf) {
    const list = childrenOf.get(parent.targetGlmId) ?? [];
    list.push({ targetGlmId: resolve(childGlmId), attributes: parent.attributes });
    childrenOf.set(parent.targetGlmId, list);
  }
  for (const list of childrenOf.values())
    list.sort((a, b) => a.targetGlmId.localeCompare(b.targetGlmId));

  // --- 4. Assemble the new node inputs ---------------------------------------
  const updates: NodeInput[] = [];
  let edgesBefore = 0;
  let edgesAfter = 0;

  for (const record of records) {
    const node = record.node;
    edgesBefore += record.relationships.length;

    // depends-on (and any other non-hierarchical kind) stays on this node, but
    // its target may have been renamed.
    const kept: NodeRelationship[] = record.relationships
      .filter((r) => r.kind !== 'composes-of')
      .map((r) => ({ ...r, targetGlmId: resolve(r.targetGlmId) }));

    const composes: NodeRelationship[] = (childrenOf.get(node.glmId) ?? []).map((child) => ({
      sourceNodeId: node.id,
      ord: 0,
      kind: 'composes-of' as const,
      targetGlmId: child.targetGlmId,
      attributes: child.attributes,
    }));

    const relationships = [...composes, ...kept];
    edgesAfter += relationships.length;

    const newGlmId = renames.get(node.glmId);
    const body = node.body as Record<string, unknown>;

    const input = toInput(node, record, relationships);
    if (newGlmId) input.glmId = newGlmId;

    // --- 5. Root System acceptance_gate (gate 2.b) ---------------------------
    if (node.stratum === 'system' && node.systemRole === 'root' && !('acceptance_gate' in body)) {
      const demos = records.find((r) => r.node.glmId.endsWith('.acceptance_demos'));
      input.body = {
        ...body,
        acceptance_gate: {
          description:
            'The system is accepted when every component-level acceptance spec passes and the end-to-end demos below run green.',
          demos_ref: demos ? demos.node.glmId : null,
          verifier: { command: 'bun run verify', expect_exit_code: 0 },
        },
      };
      console.log(`  + acceptance_gate added to ${node.glmId}`);
    }

    updates.push(input);
  }

  // --- 6. Report --------------------------------------------------------------
  console.log(
    `\nworkspace ${args.workspace}: ${records.length} nodes, ${edgesBefore} edges -> ${edgesAfter} edges`,
  );
  console.log(`nodes to rewrite: ${updates.length}`);
  console.log(`\nspec renames (${renames.size}):`);
  for (const [from, to] of renames) console.log(`  ${from}\n    -> ${to}`);
  if (adopted.length > 0) {
    console.log(`\nadopted by longest-prefix ancestor (${adopted.length}):`);
    for (const a of adopted) console.log(`  ${a.glmId}\n    under ${a.parentGlmId}`);
  }

  if (!args.apply) {
    console.log('\nDRY RUN — pass --apply to write.');
    return;
  }

  // --- 7. Apply ---------------------------------------------------------------
  // One transaction: either the whole graph is rewired or none of it is. Every
  // node is rewritten rather than only the changed ones — 42 rows is cheap, and
  // a wrong "unchanged" verdict would leave a node with its edges wiped.
  //
  // No staging pass is needed for the renames: each target glm_id is checked
  // above against both existing nodes and other renames, so no intermediate
  // state can violate UNIQUE(workspace_id, glm_id).
  const tx = db.transaction(() => {
    for (const input of updates) repo.update(input);
  });
  tx();
  console.log(`\nAPPLIED — ${updates.length} nodes rewritten.`);

  // --- 8. Re-verify -----------------------------------------------------------
  const after = repo.listByWorkspace(args.workspace);
  const { gates, overallPass } = runGates({ nodes: after, sourceDir: null });
  console.log(
    `\n${overallPass ? 'PASS' : 'FAIL'} (${gates.filter((g) => g.passed).length}/${gates.length} gates)`,
  );
  for (const g of gates) {
    console.log(
      `[${g.passed ? 'PASS' : 'FAIL'}] ${g.name}${g.issues.length ? `  (${g.issues.length} issues)` : ''}`,
    );
    for (const issue of g.issues.slice(0, 12)) console.log(`         ${issue}`);
  }
}

main();
