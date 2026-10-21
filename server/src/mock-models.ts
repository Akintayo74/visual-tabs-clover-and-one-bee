/**
 * A stand-in for the Anthropic and Voyage APIs, for tests and local runs without keys.
 *
 * - POST /v1/messages: answers with a description built from the facts in the prompt.
 * - POST /v1/multimodalembeddings: a hashed bag of words over the text parts, so texts that
 *   share words land close together, like a real embedding would for these tests.
 * - POST /v1/rerank: scores documents by how many of the query's words they contain.
 * - POST /__mock/fail { path, count, status }: makes the next `count` calls to `path` fail.
 * - GET /__mock/calls: how many calls each path received.
 *
 * Run with `pnpm --filter server mock-models` (port 54399, or MOCK_MODELS_PORT).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';

const DIMENSIONS = 1024;
const STOP_WORDS = new Set(
  'a an and are as at be by for from has in is it its of on or that the this to was with'.split(
    ' ',
  ),
);

export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP_WORDS.has(w));
}

function hash(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % DIMENSIONS;
}

export function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of words(text)) vector[hash(word)] = (vector[hash(word)] ?? 0) + 1;
  // A constant component keeps the vector non-zero for texts with no words.
  vector[0] = (vector[0] ?? 0) + 0.01;
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map((v) => v / norm);
}

function overlap(query: string, document: string): number {
  const q = new Set(words(query));
  if (!q.size) return 0;
  const d = new Set(words(document));
  let hits = 0;
  for (const w of q) if (d.has(w)) hits++;
  return hits / q.size;
}

interface MessagesBody {
  messages?: { content?: { type: string; text?: string }[] }[];
}

/** Echoes the facts back as the description, so tests can control what a save "looks like". */
function describeFromPrompt(body: MessagesBody): unknown {
  const text = (body.messages?.[0]?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
  const title = /Title: (.*)/.exec(text)?.[1] ?? 'a site';
  const largest = [...text.matchAll(/^- "([^"]*)"/gm)].map((m) => m[1] ?? '');
  const result = {
    description: `A saved site called ${title}. It shows ${largest.join(', ') || 'a page'}.`,
    recall_phrases: [
      `the ${title} site`,
      `site with ${largest[0] ?? 'some text'}`,
      `page that says ${largest.slice(0, 3).join(' ') || title}`,
    ],
    tags: ['mock', ...words(title).slice(0, 3)],
  };
  return {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify(result) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

interface EmbedBody {
  inputs?: { content?: { type: string; text?: string }[] }[];
}

interface RerankBody {
  query?: string;
  documents?: string[];
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as unknown) : {};
}

export function startMockModels(port = 54399): Promise<Server> {
  const failures = new Map<string, { count: number; status: number }>();
  const calls = new Map<string, number>();

  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (path === '/__mock/calls') {
        send(200, Object.fromEntries(calls));
        return;
      }
      const body = await readJson(request);
      if (path === '/__mock/fail') {
        const {
          path: target,
          count,
          status,
        } = body as { path: string; count: number; status: number };
        failures.set(target, { count, status });
        send(200, { ok: true });
        return;
      }
      calls.set(path, (calls.get(path) ?? 0) + 1);
      const failure = failures.get(path);
      if (failure && failure.count > 0) {
        failure.count--;
        send(failure.status, { error: { type: 'overloaded_error', message: 'Mock failure' } });
        return;
      }
      if (path === '/v1/messages') {
        send(200, describeFromPrompt(body as MessagesBody));
      } else if (path === '/v1/multimodalembeddings') {
        const inputs = (body as EmbedBody).inputs ?? [];
        send(200, {
          object: 'list',
          data: inputs.map((input, index) => ({
            object: 'embedding',
            index,
            embedding: fakeEmbedding(
              (input.content ?? [])
                .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
                .join(' '),
            ),
          })),
          model: 'voyage-multimodal-3.5',
          usage: { total_tokens: 1 },
        });
      } else if (path === '/v1/rerank') {
        const { query = '', documents = [] } = body as RerankBody;
        send(200, {
          object: 'list',
          data: documents
            .map((document, index) => ({ index, relevance_score: overlap(query, document) }))
            .sort((a, b) => b.relevance_score - a.relevance_score),
          model: 'rerank-2.5',
          usage: { total_tokens: 1 },
        });
      } else {
        send(404, { error: `No mock for ${path}` });
      }
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  return new Promise((resolve) => {
    // All interfaces, so the Edge Runtime container can reach it.
    server.listen(port, '0.0.0.0', () => {
      resolve(server);
    });
  });
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const port = Number(process.env.MOCK_MODELS_PORT ?? 54399);
  void startMockModels(port).then(() => {
    console.log(`Mock models listening on http://0.0.0.0:${String(port)}`);
  });
}
