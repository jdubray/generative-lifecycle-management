#!/usr/bin/env bun
/**
 * Test fixture: a minimal `claude` CLI mock.
 *
 * Behavior:
 *   - Parses --print, --model <model>, --system-prompt-file <path> from argv.
 *   - Reads stdin to EOF.
 *   - Writes a single line of JSON to stdout that captures everything the
 *     real wrapper sent us (model, system prompt length + head, stdin text).
 *   - Exits 0.
 *
 * Used by tests/unit/claude-cli.test.ts to assert the wrapper composes the
 * right argv and pipes stdin/stdout correctly. No real LLM is invoked.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let model = 'unknown';
let systemPromptFile: string | undefined;
let isPrint = false;
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--print') {
    isPrint = true;
  } else if (flag === '--model') {
    i += 1;
    model = args[i] ?? 'unknown';
  } else if (flag === '--system-prompt-file') {
    i += 1;
    systemPromptFile = args[i];
  }
}

const chunks: Uint8Array[] = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk as Uint8Array);
}
const userText = Buffer.concat(chunks).toString('utf8');

let systemPrompt = '';
if (systemPromptFile) {
  try {
    systemPrompt = readFileSync(systemPromptFile, 'utf8');
  } catch (err) {
    process.stderr.write(`mock-claude: failed to read system prompt file: ${(err as Error).message}\n`);
    process.exit(2);
  }
}

process.stdout.write(
  `${JSON.stringify({
    mock: true,
    print: isPrint,
    model,
    systemPromptLength: systemPrompt.length,
    systemPromptHead: systemPrompt.slice(0, 64),
    userText,
  })}\n`,
);
