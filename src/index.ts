/**
 * Type definitions for the LLM chat application.
 */

export interface Env {
	/**
	 * Binding for the Workers AI API (routes through AI Gateway "ai_dragon").
	 */
	AI: Ai;

	/**
	 * Binding for AI Search (instance "flytripvisa").
	 */
	AI_SEARCH: AiSearchNamespace;

	/**
	 * Binding for static assets (serves ./public).
	 */
	ASSETS: { fetch: (request: Request) => Promise<Response> };

	/**
	 * D1 database — primary: flytripvisa-db (has application data).
	 */
	DB: D1Database;

	/**
	 * D1 database — secondary: flydb-d1.
	 */
	DB2: D1Database;

	/**
	 * KV namespace — rate limiting, session cache, key-value store.
	 * (namespace title: "admin-ai")
	 */
	KV_BINDING: KVNamespace;

	/**
	 * R2 bucket — general object storage (flytripvisa-media).
	 */
	BUCKET: R2Bucket;

	/**
	 * R2 bucket — AI chat file attachments (ai-chat).
	 */
	AI_CHAT_BUCKET: R2Bucket;

	/**
	 * Browser Run binding — web browsing, content extraction.
	 */
	BROWSER: { fetch: (request: Request | string) => Promise<Response> };

	/**
	 * Durable Object — persistent AI agent with SQLite-backed conversation history.
	 */
	AIAgent: DurableObjectNamespace;

	/**
	 * Durable Object — per-conversation message history.
	 */
	ChatSession: DurableObjectNamespace;

	/**
	 * Durable Object — WebSocket real-time streaming with hibernation keep-alive.
	 */
	RealtimeStream: DurableObjectNamespace;

	/**
	 * Durable Object — user session and profile management.
	 */
	UserSession: DurableObjectNamespace;

	/**
	 * Durable Object — payment state and webhook handling.
	 */
	PaymentProcessor: DurableObjectNamespace;

	// ── Environment variables (from wrangler.jsonc vars) ──────────

	APP_NAME: string;
	AI_MODEL: string;
	AI_PROVIDER: string;
	AI_GATEWAY_ID: string;
	CF_ACCOUNT_ID: string;
	APP_DOMAIN: string;
	APP_URL: string;
	AI_CHAT_URL: string;
	ENVIRONMENT: string;
	ENABLE_STREAMING: string;
	LOG_LEVEL: string;
	MAX_HISTORY: string;
	SYSTEM_PROMPT: string;

	// ── Social platform secrets (optional, via wrangler secret put) ──

	TELEGRAM_BOT_TOKEN?: string;
	WECHAT_APP_ID?: string;
	WECHAT_APP_SECRET?: string;
	WECHAT_TOKEN?: string;
	WHATSAPP_ACCESS_TOKEN?: string;
	WHATSAPP_PHONE_NUMBER_ID?: string;

	/**
	 * Owner authentication (optional, for admin endpoints).
	 */
	ADMIN_SECRET?: string;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
