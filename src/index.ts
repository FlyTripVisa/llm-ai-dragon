/**
 * LLM Chat Application — llm-ai-dragon
 *
 * Features:
 * - Streaming chat via Server-Sent Events (SSE)
 * - OpenAI-compatible /v1/chat/completions endpoint
 * - AI Gateway routing (ai_dragon / kimik2)
 * - Health check endpoint
 * - CORS support
 *
 * Model: @cf/qwen/qwen3-30b-a3b-fp8 (free, Cloudflare Workers AI)
 */

// ─── Types ───────────────────────────────────────────────
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Env {
  // Bindings (from wrangler.jsonc)
  AI: Ai;
  ASSETS: Fetcher;
  AI_SEARCH: any;
  DB: D1Database;
  DB2: D1Database;
  KV_BINDING: KVNamespace;
  BUCKET: R2Bucket;
  AI_CHAT_BUCKET: R2Bucket;
  BROWSER: any;

  // Secrets (set via `wrangler secret put`)
  CLOUDFLARE_API_TOKEN?: string;
  SESSION_SECRET?: string;
}

// ─── Constants ────────────────────────────────────────────
const MODEL_ID = "@cf/qwen/qwen3-30b-a3b-fp8";

// AI Gateway config — choose ONE:
const AI_GATEWAY = {
  id: "ai_dragon",           // ← primary gateway slug
  // id: "kimik2",          // ← alternative (from your WebSocket URL)
  skipCache: false,
  cacheTtl: 3600,
};

const SYSTEM_PROMPT =
  "You are FlyTripVisa AI — a helpful, professional travel visa assistant. Provide accurate, concise answers about visa requirements, documentation, processing times, and travel regulations. Always clarify you're an AI assistant.";

// ─── CORS Headers ─────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
} as const;

// ─── Main Fetch Handler ────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Static assets (frontend)
    if (path === "/" || (!path.startsWith("/api/") && !path.startsWith("/ai/"))) {
      return env.ASSETS.fetch(request);
    }

    // ─── API Routes ───────────────────────────────────────
    try {
      // Streaming chat (SSE)
      if (path === "/api/chat" && request.method === "POST") {
        return handleChatStream(request, env);
      }

      // OpenAI-compatible endpoint
      if (path === "/api/v1/chat/completions" && request.method === "POST") {
        return handleChatCompletions(request, env);
      }

      // Health check
      if (path === "/api/health" && request.method === "GET") {
        return jsonResponse({
          status: "ok",
          worker: "llm-ai-dragon",
          model: MODEL_ID,
          gateway: AI_GATEWAY.id,
          timestamp: new Date().toISOString(),
        });
      }

      // AI Search
      if (path === "/api/search" && request.method === "POST") {
        return handleSearch(request, env);
      }

      // 404
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse(
        { error: "Internal Server Error", message: String(err) },
        500,
        CORS_HEADERS,
      );
    }
  },
} satisfies ExportedHandler<Env>;

// ─── Handlers ──────────────────────────────────────────────

/**
 * SSE Streaming Chat
 * POST /api/chat
 * Body: { "messages": [{ "role": "user", "content": "Hello" }] }
 */
async function handleChatStream(request: Request, env: Env): Promise<Response> {
  const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };

  // Ensure system prompt exists
  const chatMessages: ChatMessage[] = messages.some((m) => m.role === "system")
    ? messages
    : [{ role: "system", content: SYSTEM_PROMPT }, ...messages];

  const stream = await env.AI.run(
    MODEL_ID,
    {
      messages: chatMessages,
      max_tokens: 2048,
      temperature: 0.7,
      stream: true,
    } as any,
    AI_GATEWAY,
  );

  // Convert AI stream to SSE format
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream as any) {
          // Workers AI returns chunks with .response or .text
          const token = chunk?.response ?? chunk?.text ?? chunk?.content ?? "";
          if (token) {
            const sseData = `data: ${JSON.stringify({ content: token })}\n\n`;
            controller.enqueue(encoder.encode(sseData));
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        console.error("Stream error:", err);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...CORS_HEADERS,
    },
  });
}

/**
 * OpenAI-Compatible Chat Completions
 * POST /api/v1/chat/completions
 */
async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as any;
  const messages: ChatMessage[] = body.messages ?? [];
  const stream = body.stream ?? false;

  const chatMessages: ChatMessage[] = messages.some((m: any) => m.role === "system")
    ? messages
    : [{ role: "system", content: SYSTEM_PROMPT }, ...messages];

  const aiStream = await env.AI.run(
    MODEL_ID,
    {
      messages: chatMessages,
      max_tokens: body.max_tokens ?? 2048,
      temperature: body.temperature ?? 0.7,
      stream: true,
    } as any,
    AI_GATEWAY,
  );

  if (!stream) {
    // Non-streaming: collect full response
    let fullText = "";
    for await (const chunk of aiStream as any) {
      fullText += chunk?.response ?? chunk?.text ?? chunk?.content ?? "";
    }
    return jsonResponse(
      {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: fullText },
            finish_reason: "stop",
          },
        ],
      },
      200,
      CORS_HEADERS,
    );
  }

  // Streaming: OpenAI SSE format
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      let chunkId = `chatcmpl-${Date.now()}`;
      try {
        for await (const chunk of aiStream as any) {
          const token = chunk?.response ?? chunk?.text ?? chunk?.content ?? "";
          if (token) {
            const data = {
              id: chunkId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: MODEL_ID,
              choices: [
                {
                  index: 0,
                  delta: { content: token },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          }
        }
        // Final chunk
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: chunkId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: MODEL_ID,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        console.error("Stream error:", err);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      ...CORS_HEADERS,
    },
  });
}

/**
 * AI Search (uses AI_SEARCH binding)
 * POST /api/search
 * Body: { "query": "visa requirements for Japan" }
 */
async function handleSearch(request: Request, env: Env): Promise<Response> {
  const { query } = (await request.json()) as { query: string };

  if (!query) {
    return jsonResponse({ error: "Missing 'query' field" }, 400, CORS_HEADERS);
  }

  // AI_SEARCH is bound to instance "flytripvisa"
  const results = await env.AI_SEARCH.search(query, {
    limit: 10,
  });

  return jsonResponse({ query, results }, 200, CORS_HEADERS);
}

// ─── Helpers ───────────────────────────────────────────────
function jsonResponse(data: any, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
