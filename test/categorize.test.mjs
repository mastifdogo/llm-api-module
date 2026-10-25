import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt, candidateAccounts, examplesFromEntries, suggest } from "../lib/categorize.mjs";
import { completeJson } from "../lib/llm.mjs";

const bank = { code: "1000", name: "Chequing", type: "asset", currency: "CAD", is_active: true };
const accounts = [
	bank,
	{ code: "5100", name: "Fuel", type: "expense", currency: "CAD", is_active: true, description: "" },
	{ code: "5200", name: "Subscriptions", type: "expense", currency: "CAD", is_active: true, description: "" },
	{ code: "4000", name: "Salary", type: "revenue", currency: "CAD", is_active: true, description: "" },
	{ code: "5900", name: "Old", type: "expense", currency: "CAD", is_active: false, description: "" },
	{ code: "1100", name: "USD account", type: "asset", currency: "USD", is_active: true, description: "" },
];
const candidates = candidateAccounts(accounts, bank);

/** A fake fetch that records requests and answers like the Messages API. */
function fakeAnthropic(answer) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ url, headers: init.headers, body });
		const results = answer(body);
		return new Response(JSON.stringify({ model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ results }) }] }), { status: 200 });
	};
	return { calls, fetchImpl };
}

test("candidate accounts: active, same currency, not the statement account", () => {
	assert.deepEqual(candidates.map((a) => a.code), ["5100", "5200", "4000"]);
});

test("rules answer without the model; the rest go to Claude with a constrained schema", async () => {
	const { calls, fetchImpl } = fakeAnthropic((body) => {
		const lines = body.messages[0].content.split("\n").filter((l) => l.startsWith("{"));
		return lines.map((l) => {
			const t = JSON.parse(l);
			return { i: t.i, account_code: t.amount.startsWith("-") ? "5100" : "4000", confidence: 1.7, reason: "test" };
		});
	});
	const cfg = { provider: "anthropic", model: "claude-opus-5-5", api_key: "k", effort: "low" };
	const out = await suggest({
		cfg,
		statementAccount: bank,
		candidates,
		examples: [{ description: "NETFLIX.COM", amount: "-16.99", account_code: "5200" }],
		rules: new Map([["NETFLIX", { account_code: "5200", hits: 3 }]]),
		transactions: [
			{ id: 1, date: "2026-03-01", description: "NETFLIX.COM", memo: "", amount_cents: -1699n },
			{ id: 2, date: "2026-03-02", description: "SHELL #12", memo: "", amount_cents: -4510n },
			{ id: 3, date: "2026-03-03", description: "PAYROLL", memo: "", amount_cents: 200000n },
		],
		fetchImpl,
	});
	assert.equal(calls.length, 1);
	const req = calls[0];
	assert.equal(req.url, "https://api.anthropic.com/v1/messages");
	assert.equal(req.headers["anthropic-version"], "2026-10-21");
	assert.equal(req.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
	assert.equal(req.body.fallbacks, "default");
	assert.equal(req.body.output_config.effort, "low");
	assert.deepEqual(req.body.output_config.format.schema.properties.results.items.properties.account_code.enum, ["5100", "5200", "4000"]);
	assert.ok(!("temperature" in req.body));
	assert.match(req.body.messages[0].content, /"NETFLIX.COM" -16.99 -> 5200/);

	assert.equal(out.get(1).source, "rule");
	assert.equal(out.get(1).code, "5200");
	assert.deepEqual(out.get(2), { code: "5100", confidence: 1, reason: "test", source: "llm" });
	assert.equal(out.get(3).code, "4000");
});

test("invalid codes and missing rows become errors; batches are split", async () => {
	const { calls, fetchImpl } = fakeAnthropic(() => [{ i: 1, account_code: "9999", confidence: 0.9, reason: "x" }]);
	const txs = [1, 2, 3].map((id) => ({ id, date: "2026-03-01", description: `X${id}`, memo: "", amount_cents: -100n }));
	const out = await suggest({ cfg: { provider: "anthropic", api_key: "k" }, statementAccount: bank, candidates, examples: [], rules: new Map(), transactions: txs, batchSize: 2, fetchImpl });
	assert.equal(calls.length, 2);
	for (const id of [1, 2, 3]) assert.equal(out.get(id).source, "error");
});

test("auth errors stop after the first batch", async () => {
	let n = 0;
	const fetchImpl = async () => (n++, new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 }));
	const txs = [1, 2, 3, 4].map((id) => ({ id, date: "2026-03-01", description: `X${id}`, memo: "", amount_cents: -100n }));
	const out = await suggest({ cfg: { provider: "anthropic", api_key: "bad" }, statementAccount: bank, candidates, examples: [], rules: new Map(), transactions: txs, batchSize: 1, fetchImpl });
	assert.equal(n, 1);
	assert.match(out.get(4).reason, /401: invalid x-api-key/);
});

test("refusals and missing keys raise readable errors", async () => {
	const refuse = async () => new Response(JSON.stringify({ stop_reason: "refusal", content: [] }), { status: 200 });
	const req = { system: "s", prompt: "p", schema: {} };
	await assert.rejects(completeJson({ provider: "anthropic", api_key: "k" }, req, refuse), /declined/);
	await assert.rejects(completeJson({ provider: "anthropic", api_key: "" }, req, refuse), /no Anthropic API key/);
});

test("Ollama and OpenAI-compatible requests", async () => {
	const seen = [];
	const fetchImpl = async (url, init) => {
		seen.push({ url, body: JSON.parse(init.body) });
		const content = '{"ok": true}';
		return new Response(JSON.stringify(url.endsWith("/api/chat") ? { model: "m", message: { content } } : { model: "m", choices: [{ message: { content: "```json\n" + content + "\n```" } }] }));
	};
	const req = { system: "s", prompt: "p", schema: { type: "object" } };
	assert.deepEqual((await completeJson({ provider: "ollama", model: "qwen3:14b", base_url: "http://h:11434/" }, req, fetchImpl)).data, { ok: true });
	assert.deepEqual((await completeJson({ provider: "openai", model: "m", base_url: "http://h:1234/v1" }, req, fetchImpl)).data, { ok: true });
	assert.equal(seen[0].url, "http://h:11434/api/chat");
	assert.deepEqual(seen[0].body.format, { type: "object" });
	assert.equal(seen[1].url, "http://h:1234/v1/chat/completions");
	assert.equal(seen[1].body.response_format.type, "json_schema");
});

test("examples come from two-line entries touching the statement account", () => {
	const line = (account_code, d, c) => ({ account_code, debit_cents: BigInt(d), credit_cents: BigInt(c) });
	const entries = [
		{ description: "SHELL #1", lines: [line("5100", 4000, 0), line("1000", 0, 4000)] },
		{ description: "SHELL #2", lines: [line("5100", 3000, 0), line("1000", 0, 3000)] },
		{ description: "Split", lines: [line("5100", 1, 0), line("5200", 1, 0), line("1000", 0, 2)] },
		{ description: "Inactive", lines: [line("5900", 1, 0), line("1000", 0, 1)] },
	];
	const ex = examplesFromEntries(entries, "1000", new Set(candidates.map((a) => a.code)));
	assert.deepEqual(ex, [{ description: "SHELL #1", amount: "-40.00", account_code: "5100" }]);
	const prompt = buildPrompt({ statementAccount: bank, candidates, examples: ex, batch: [{ i: 1, date: "2026-03-01", description: "A", memo: "", amount_cents: -5n }] });
	assert.match(prompt, /"amount":"-0.05"/);
});
