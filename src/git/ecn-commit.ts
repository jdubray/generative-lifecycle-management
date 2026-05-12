/**
 * ECN commit message builder (spec §9.5).
 *
 *   ECN: <imperative summary>
 *
 *   Affected:
 *     - glm:<node_id_1>
 *     - glm:<node_id_2>
 *
 *   Why:
 *     <free text>
 *
 *   Regen required:
 *     - <realization_file_path>  (re-emit; <reason>)
 *
 *   SCR: SCR-<number>
 *   Signed-off-by: <user_email>
 *
 * Pure: takes inputs, returns the string. Validation throws so callers
 * never produce malformed messages that the pre-receive hook would reject.
 */

export class EcnMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcnMessageError';
  }
}

export interface EcnRegen {
  path: string;
  reason: string;
}

export interface EcnMessageInput {
  /** Imperative one-line summary; appears after `ECN:`. */
  summary: string;
  /** glm_ids of every node touched by this commit. */
  affected: string[];
  /** Free-text rationale; usually the SCR problem statement. */
  why: string;
  /** Files that need regeneration. */
  regenRequired?: EcnRegen[];
  /** SCR identifier in the form `SCR-<digits>`. */
  scrId: string;
  /** Author email shown as `Signed-off-by`. */
  signedOffBy: string;
}

const SCR_ID_PATTERN = /^SCR-\d+$/;

/** Build a canonical ECN commit message string. Throws on missing/invalid input. */
export function buildEcnMessage(input: EcnMessageInput): string {
  if (!input.summary || input.summary.includes('\n')) {
    throw new EcnMessageError('summary must be a non-empty single line');
  }
  if (!input.affected || input.affected.length === 0) {
    throw new EcnMessageError('affected[] must list at least one glm_id');
  }
  for (const id of input.affected) {
    if (!id.startsWith('glm:')) {
      throw new EcnMessageError(`affected entry '${id}' does not start with 'glm:'`);
    }
  }
  if (!input.why || input.why.trim().length === 0) {
    throw new EcnMessageError('why must be a non-empty rationale');
  }
  if (!SCR_ID_PATTERN.test(input.scrId)) {
    throw new EcnMessageError(`scrId '${input.scrId}' does not match SCR-<digits>`);
  }
  if (!input.signedOffBy || !input.signedOffBy.includes('@')) {
    throw new EcnMessageError('signedOffBy must look like an email');
  }

  const lines: string[] = [];
  lines.push(`ECN: ${input.summary}`);
  lines.push('');
  lines.push('Affected:');
  for (const id of input.affected) lines.push(`  - ${id}`);
  lines.push('');
  lines.push('Why:');
  for (const part of splitWhy(input.why)) lines.push(`  ${part}`);
  if (input.regenRequired && input.regenRequired.length > 0) {
    lines.push('');
    lines.push('Regen required:');
    for (const r of input.regenRequired) {
      if (!r.path || r.path.includes('\n')) {
        throw new EcnMessageError(`regen path '${r.path}' must be a non-empty single line`);
      }
      lines.push(`  - ${r.path}  (re-emit; ${r.reason})`);
    }
  }
  lines.push('');
  lines.push(`SCR: ${input.scrId}`);
  lines.push(`Signed-off-by: ${input.signedOffBy}`);
  return lines.join('\n');
}

/**
 * Tolerant parser for ECN messages. Returns `null` if the message does not
 * have an `ECN:` first line — useful for the pre-receive hook that needs
 * to recognize non-ECN commits without throwing.
 */
export function parseEcnMessage(message: string): EcnMessageInput | null {
  const lines = message.split(/\r?\n/);
  const first = lines[0] ?? '';
  if (!first.startsWith('ECN: ')) return null;

  const summary = first.slice(5).trim();
  const affected: string[] = [];
  const regen: EcnRegen[] = [];
  let why = '';
  let scrId = '';
  let signedOffBy = '';
  let section: 'none' | 'affected' | 'why' | 'regen' = 'none';

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === '') continue;
    if (line === 'Affected:') {
      section = 'affected';
      continue;
    }
    if (line === 'Why:') {
      section = 'why';
      continue;
    }
    if (line === 'Regen required:') {
      section = 'regen';
      continue;
    }
    if (line.startsWith('SCR:')) {
      section = 'none';
      scrId = line.slice(4).trim();
      continue;
    }
    if (line.startsWith('Signed-off-by:')) {
      section = 'none';
      signedOffBy = line.slice('Signed-off-by:'.length).trim();
      continue;
    }
    const trimmed = line.replace(/^ {2}/, '');
    if (section === 'affected' && trimmed.startsWith('- ')) {
      affected.push(trimmed.slice(2).trim());
    } else if (section === 'why') {
      why = why ? `${why}\n${trimmed}` : trimmed;
    } else if (section === 'regen' && trimmed.startsWith('- ')) {
      const match = trimmed.slice(2).match(/^(.+?)\s+\(re-emit;\s+(.+)\)\s*$/);
      if (match) regen.push({ path: match[1]?.trim() ?? '', reason: match[2]?.trim() ?? '' });
    }
  }

  return {
    summary,
    affected,
    why,
    regenRequired: regen.length > 0 ? regen : undefined,
    scrId,
    signedOffBy,
  };
}
function splitWhy(why: string): string[] {
  return why
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
