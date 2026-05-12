import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import type { YamlNodeDoc } from './adapter.ts';

/**
 * Pure parsing layer for the importer. Two source modes:
 *
 *   - `directory`: walks `*.yaml` / `*.yml` under a filesystem path; used by
 *     the CLI and by admin-only server invocations.
 *   - `inline`:   takes a pre-parsed list of `{ filename, content }` blobs;
 *     used by the REST endpoint when the browser uploads files inline.
 *
 * In both modes a single result row is one (file, YAML document) pair.
 * Documents that lack `id` + `stratum` are silently dropped (e.g. the
 * `$schema:` lead-in document in some sekkei files).
 */

export interface SourceDoc {
  doc: YamlNodeDoc;
  file: string;
}

export type ImportSource =
  | { kind: 'directory'; path: string }
  | { kind: 'inline'; documents: Array<{ filename: string; content: string }> };

export function loadDocs(source: ImportSource): SourceDoc[] {
  if (source.kind === 'inline') {
    return source.documents.flatMap((d) => parseDocs(d.content, d.filename));
  }
  return loadDirectory(source.path);
}

function loadDirectory(path: string): SourceDoc[] {
  const absolute = resolve(path);
  const stat = statSync(absolute);
  const files: string[] = [];
  if (stat.isDirectory()) walk(absolute, files);
  else files.push(absolute);
  return files.flatMap((file) => parseDocs(readFileSync(file, 'utf8'), file));
}

function walk(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      acc.push(full);
    }
  }
}

function parseDocs(content: string, file: string): SourceDoc[] {
  const docs = parseAllDocuments(content);
  const out: SourceDoc[] = [];
  for (const d of docs) {
    const value = d.toJS() as YamlNodeDoc | null;
    if (!value || typeof value !== 'object') continue;
    if (!('id' in value) || !('stratum' in value)) continue; // skip header-only docs
    out.push({ doc: value, file });
  }
  return out;
}
