// LLM providers. Each takes a system prompt, a user prompt and a JSON schema
// and returns the parsed JSON object the model produced.
//
// Modules are installed without a build step or npm install, so these call
// the HTTP APIs with Node's built-in fetch.
//
//   anthropic  Claude via the Messages API, with structured outputs
//   ollama     a local model through Ollama's /api/chat (format = schema)
//   openai     any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, ...)

export class LlmError extends Error {}

export const PROVIDERS = ["anthropic", "ollama", "openai"];

export const DEFAULTS = {
	anthropic: { model: "claude-opus-5-5", base_url: "https://api.anthropic.com" },
	ollama: { model: "qwen3:14b", base_url: "http://127.0.0.1:11434" },
	openai: { model: "", base_url: "http://127.0.0.1:1234/v1" },
};

// Models that accept server-side refusal fallbacks (fallbacks: "default").
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

const TIMEOUT_MS = 180_000;

async function post(url, headers, body, fetchImpl) {
	let res;
	try {
		res = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		const why = err?.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS / 1000} s` : err?.cause?.message || err?.message || String(err);
		throw new LlmError(`could not reach ${new URL(url).host}: ${why}`);
	}
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	if (!res.ok) {
		const msg = json?.error?.message || json?.error || text.slice(0, 300) || res.statusText;
		throw new LlmError(`${new URL(url).host} answered ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
	}
	if (json === null) throw new LlmError(`${new URL(url).host} returned a non-JSON response`);
	return json;
}

function parseJsonText(text, who) {
	const s = String(text ?? "")
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	try {
		return JSON.parse(s);
	} catch {
		throw new LlmError(`${who} did not return valid JSON`);
	}
}

async function anthropic(cfg, { system, prompt, schema, maxTokens, documents = [] }, fetchImpl) {
	if (!cfg.api_key) throw new LlmError("no Anthropic API key configured (Settings, or CATEGORIZER_API_KEY in /etc/ledger/ledger.env)");
	const model = cfg.model || DEFAULTS.anthropic.model;
	const body = {
		model,
		max_tokens: maxTokens,
		system,
		messages: [
			{
				role: "user",
				// PDFs go before the text that refers to them.
				content:
					documents.length === 0
						? prompt
						: [
								...documents.map((d) => ({ type: "document", source: { type: "base64", media_type: d.media_type, data: d.data }, title: d.name || undefined })),
								{ type: "text", text: prompt },
							],
			},
		],
		output_config: { effort: cfg.effort || "low", format: { type: "json_schema", schema } },
	};
	const headers = { "x-api-key": cfg.api_key, "anthropic-version": "2026-10-21" };
	if (FALLBACK_MODELS.test(model)) {
		// If the model declines a batch, the API re-runs it on a fallback model instead of failing.
		body.fallbacks = "default";
		headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
	}
	const base = (cfg.base_url || DEFAULTS.anthropic.base_url).replace(/\/+$/, "");
	const res = await post(`${base}/v1/messages`, headers, body, fetchImpl);
	if (res.stop_reason === "refusal") {
		throw new LlmError(`the model declined this batch${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ""}`);
	}
	if (res.stop_reason === "max_tokens") throw new LlmError("the answer was cut off (max_tokens); try a smaller batch size");
	const text = (res.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	return { data: parseJsonText(text, "Claude"), model: res.model ?? model, usage: res.usage ?? null };
}

async function ollama(cfg, { system, prompt, schema }, fetchImpl) {
	if (!cfg.model) throw new LlmError("no Ollama model configured");
	const base = (cfg.base_url || DEFAULTS.ollama.base_url).replace(/\/+$/, "");
	const res = await post(
		`${base}/api/chat`,
		cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {},
		{
			model: cfg.model,
			stream: false,
			format: schema,
			options: { temperature: 0 },
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: prompt },
			],
		},
		fetchImpl,
	);
	return { data: parseJsonText(res.message?.content, "Ollama"), model: res.model ?? cfg.model, usage: null };
}

async function openai(cfg, { system, prompt, schema, maxTokens }, fetchImpl) {
	if (!cfg.model) throw new LlmError("no model configured");
	const base = (cfg.base_url || DEFAULTS.openai.base_url).replace(/\/+$/, "");
	const res = await post(
		`${base}/chat/completions`,
		cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {},
		{
			model: cfg.model,
			max_tokens: maxTokens,
			response_format: { type: "json_schema", json_schema: { name: "categories", strict: true, schema } },
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: prompt },
			],
		},
		fetchImpl,
	);
	return { data: parseJsonText(res.choices?.[0]?.message?.content, cfg.model), model: res.model ?? cfg.model, usage: res.usage ?? null };
}

/** Whether the provider reads PDF documents passed in req.documents (others get the text only). */
export const readsPdf = (cfg) => cfg.provider === "anthropic";

/**
 * Calls the configured provider. cfg: { provider, model, base_url, api_key, effort }.
 * req: { system, prompt, schema, maxTokens?, documents?: [{ media_type: "application/pdf", data: base64, name }] }
 */
export async function completeJson(cfg, req, fetchImpl = globalThis.fetch) {
	const r = { maxTokens: 16000, ...req };
	switch (cfg.provider) {
		case "anthropic":
			return anthropic(cfg, r, fetchImpl);
		case "ollama":
			return ollama(cfg, r, fetchImpl);
		case "openai":
			return openai(cfg, r, fetchImpl);
		default:
			throw new LlmError(`unknown provider ${JSON.stringify(cfg.provider)}`);
	}
}
