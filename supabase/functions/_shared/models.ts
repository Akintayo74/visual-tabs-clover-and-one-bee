import type Anthropic from '@anthropic-ai/sdk';
import {
  DESCRIBE_MODEL,
  factsText,
  OUTPUT_SCHEMA,
  parseUnderstanding,
  SYSTEM_PROMPT,
  type SaveFacts,
  type Understanding,
} from './prompt.ts';

export const EMBED_MODEL = 'voyage-multimodal-3.5';
export const RERANK_MODEL = 'rerank-2.5';
/** Matches the `vector(1024)` column; 1024 is the model's default output size. */
export const EMBED_DIMENSIONS = 1024;
const VOYAGE_BASE_URL = 'https://api.voyageai.com/v1';

/** A model call that failed. `retryable` says whether trying the same input later can work. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

/** 408, 409, 429 and 5xx (529 is Anthropic's "overloaded") are worth retrying. */
export function retryableStatus(status: number | undefined): boolean {
  return (
    status === undefined || status === 408 || status === 409 || status === 429 || status >= 500
  );
}

/**
 * A problem with the API account rather than the input: a bad or revoked key (401, 403), or
 * no credit left (402, or Anthropic's 400 "credit balance is too low"). Someone can fix it,
 * so the save should keep waiting instead of failing for good.
 */
export function accountProblem(status: number | undefined, detail: string): boolean {
  if (status === 401 || status === 402 || status === 403) return true;
  return status === 400 && /credit balance|billing|payment method/i.test(detail);
}

function retryable(status: number | undefined, detail: string): boolean {
  return retryableStatus(status) || accountProblem(status, detail);
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DescribeInput extends SaveFacts {
  /** The screenshot, base64-encoded. */
  imageBase64: string;
  mediaType: 'image/webp' | 'image/png' | 'image/jpeg';
}

/** Asks Claude for the description, recall phrases and tags of one save. */
export async function describe(
  client: Pick<Anthropic, 'beta'>,
  input: DescribeInput,
): Promise<Understanding> {
  let response: Anthropic.Beta.Messages.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: DESCRIBE_MODEL,
      max_tokens: 8000,
      // Re-runs a request the model declines on Anthropic's recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: input.mediaType, data: input.imageBase64 },
            },
            {
              type: 'text',
              text: `Measured facts about this page:\n${factsText(input)}\n\nDescribe this saved site.`,
            },
          ],
        },
      ],
    });
  } catch (error) {
    const message = messageOf(error);
    throw new ModelError(`Claude: ${message}`, retryable(statusOf(error), message));
  }

  if (response.stop_reason === 'refusal') {
    throw new ModelError('Claude declined to describe this page.', false);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new ModelError('Claude ran out of room before finishing the description.', true);
  }
  const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  try {
    return parseUnderstanding(JSON.parse(text));
  } catch (error) {
    throw new ModelError(`Claude returned an unusable answer: ${messageOf(error)}`, true);
  }
}

export interface VoyageOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

async function voyage<T>(options: VoyageOptions, path: string, body: unknown): Promise<T> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${options.baseUrl ?? VOYAGE_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw new ModelError(`Voyage: ${messageOf(error)}`, true);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new ModelError(
      `Voyage ${path} returned ${String(response.status)}: ${detail}`,
      retryable(response.status, detail),
    );
  }
  return (await response.json()) as T;
}

interface EmbedResponse {
  data?: { embedding?: number[]; index?: number }[];
}

function checkEmbedding(embedding: number[] | undefined): number[] {
  if (!embedding || embedding.length !== EMBED_DIMENSIONS) {
    throw new ModelError(
      `Voyage returned an embedding of ${String(embedding?.length ?? 0)} numbers, expected ${String(EMBED_DIMENSIONS)}.`,
      false,
    );
  }
  return embedding;
}

/** Embeds a save: its generated text and screenshot together, as one interleaved input. */
export async function embedSave(
  options: VoyageOptions,
  input: { text: string; imageBase64: string; mediaType: string },
): Promise<number[]> {
  const response = await voyage<EmbedResponse>(options, '/multimodalembeddings', {
    model: EMBED_MODEL,
    input_type: 'document',
    inputs: [
      {
        content: [
          { type: 'text', text: input.text },
          {
            type: 'image_base64',
            image_base64: `data:${input.mediaType};base64,${input.imageBase64}`,
          },
        ],
      },
    ],
  });
  return checkEmbedding(response.data?.[0]?.embedding);
}

/** Embeds a search query in the same space as the saves. */
export async function embedQuery(options: VoyageOptions, query: string): Promise<number[]> {
  const response = await voyage<EmbedResponse>(options, '/multimodalembeddings', {
    model: EMBED_MODEL,
    input_type: 'query',
    inputs: [{ content: [{ type: 'text', text: query }] }],
  });
  return checkEmbedding(response.data?.[0]?.embedding);
}

interface RerankResponse {
  data?: { index?: number; relevance_score?: number }[];
}

/** Scores each document against the query. Returns indexes into `documents`, best first. */
export async function rerank(
  options: VoyageOptions,
  query: string,
  documents: string[],
): Promise<{ index: number; score: number }[]> {
  if (!documents.length) return [];
  const response = await voyage<RerankResponse>(options, '/rerank', {
    model: RERANK_MODEL,
    query,
    documents,
    truncation: true,
  });
  const ranked = (response.data ?? [])
    .filter(
      (d): d is { index: number; relevance_score: number } =>
        typeof d.index === 'number' && typeof d.relevance_score === 'number',
    )
    .map((d) => ({ index: d.index, score: d.relevance_score }));
  if (ranked.length !== documents.length) {
    throw new ModelError('Voyage rerank returned an incomplete ranking.', true);
  }
  return ranked.sort((a, b) => b.score - a.score);
}
