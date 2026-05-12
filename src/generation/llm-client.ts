/**
 * LLM provider abstraction for the generation pipeline.
 *
 * Two implementations ship in v1:
 *
 *   - `FakeLlmClient`     — deterministic tests; queues canned responses
 *   - `AnthropicLlmClient` — fetch-based call to the Anthropic Messages API
 *                           with `cache_control: ephemeral` on the system
 *                           and context blocks (5-minute TTL)
 *
 * The pipeline calls `generate(...)`; everything beyond that — prompt
 * caching, token counting, model selection — is the client's concern.
 *
 * The Anthropic SDK is intentionally NOT a dependency. The Messages API is
 * a thin HTTP surface and the SDK adds bundle weight that the rest of the
 * server does not benefit from.
 */

export interface LlmGenerateInput {
  /** System prompt; usually the generator's identity / role. */
  system?: string;
  /** Main user prompt (the spec.prompt content + assembled context_bundle). */
  prompt: string;
  /** Optional context bundle entries; each gets its own cache_control block. */
  contextBundle?: Array<{ name: string; content: string }>;
  /** Override the configured model. */
  model?: string;
  /** Maximum tokens to emit. */
  maxTokens?: number;
}

export interface LlmGenerateResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  /** The model that actually produced the output (post-routing). */
  model: string;
}

export interface LlmClient {
  /** Stable identifier surfaced in provenance + cache keys. */
  readonly identityString: string;
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>;
}

// ---------------------------------------------------------------------------
// Fake (deterministic)
// ---------------------------------------------------------------------------

export interface FakeLlmResponse extends Partial<LlmGenerateResult> {
  text: string;
}

export class FakeLlmClient implements LlmClient {
  public readonly identityString: string;
  public readonly calls: LlmGenerateInput[] = [];
  private readonly responses: FakeLlmResponse[];

  constructor(responses: FakeLlmResponse[] = [], identity = 'fake-llm@v1') {
    this.responses = [...responses];
    this.identityString = identity;
  }

  generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    this.calls.push(input);
    const next = this.responses.shift();
    if (!next) {
      return Promise.reject(new Error('FakeLlmClient: no more canned responses'));
    }
    const text = next.text;
    return Promise.resolve({
      text,
      tokensIn: next.tokensIn ?? Math.max(1, Math.floor(input.prompt.length / 4)),
      tokensOut: next.tokensOut ?? Math.max(1, Math.floor(text.length / 4)),
      durationMs: next.durationMs ?? 50,
      model: next.model ?? input.model ?? 'fake-model',
    });
  }
}

// ---------------------------------------------------------------------------
// Anthropic (real)
// ---------------------------------------------------------------------------

export interface AnthropicClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Override the global `fetch` (for tests). */
  fetchImpl?: typeof fetch;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Thin Anthropic Messages API client with prompt caching enabled. The
 * `system` and each `contextBundle` entry are sent as their own
 * `cache_control: { type: "ephemeral" }` block so a re-run within 5 minutes
 * pays only for the delta tokens.
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicClientOptions) {
    if (!opts.apiKey) throw new Error('AnthropicLlmClient requires an API key');
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'claude-sonnet-4-6';
    this.baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get identityString(): string {
    return `anthropic:${this.model}`;
  }

  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    const started = Date.now();
    const body = {
      model: input.model ?? this.model,
      max_tokens: input.maxTokens ?? 4096,
      system: input.system
        ? [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }]
        : undefined,
      messages: [
        {
          role: 'user',
          content: [
            ...(input.contextBundle ?? []).map((c) => ({
              type: 'text',
              text: `# ${c.name}\n${c.content}`,
              cache_control: { type: 'ephemeral' },
            })),
            { type: 'text', text: input.prompt },
          ],
        },
      ],
    };

    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic ${res.status}: ${text}`);
    }
    const payload = (await res.json()) as AnthropicResponse;
    const text = payload.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    const durationMs = Date.now() - started;
    return {
      text,
      tokensIn: payload.usage?.input_tokens ?? 0,
      tokensOut: payload.usage?.output_tokens ?? 0,
      durationMs,
      model: payload.model,
    };
  }
}
