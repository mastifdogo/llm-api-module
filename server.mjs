// Statement Categorizer: Ledger loads this file at startup and calls register(ctx).
// The module API is described in Ledger's docs/MODULES.md.
//
// Flow: upload a statement -> transactions are staged in this module's tables
// -> a background job asks the LLM for an account per transaction -> you
// review on the module's page -> posting creates one journal entry per
// transaction through ctx.ledger.createJournalEntry and teaches a payee rule.
//
// Bills (lib/bill-routes.mjs): a scheduled mailbox check turns bill emails
// into bills; transactions that pay them are matched before the LLM is asked.

import { createHash } from "node:crypto";
import { registerBills } from "./lib/bill-routes.mjs";
import { dashboard } from "./lib/dashboard.mjs";
import { candidateAccounts, examplesFromEntries, suggest } from "./lib/categorize.mjs";
import { DEFAULTS, LlmError, PROVIDERS, completeJson } from "./lib/llm.mjs";
import { ParseError, parseAmount, parseDate, parseStatement, payeeKey } from "./lib/parse.mjs";

const EFFORTS = ["low", "medium", "high"];
const SETTING_KEYS = ["provider", "model", "base_url", "api_key", "effort", "batch_size", "review_threshold"];
const MAX_CONTENT_CHARS = 1_000_000;

/** @param {import("../../backend/src/module-host.ts").ModuleContext} ctx */
export default async function register(ctx) {
	const T = (name) => `${ctx.schema}.${name}`;
	const q = (sql, params) => ctx.db.query(sql, params);
	const bad = (msg) => new ctx.HttpError(422, msg);
	const dash = dashboard(ctx);

	// -----------------------------------------------------------------------
	// Settings
	// -----------------------------------------------------------------------

	async function readSettings() {
		const { rows } = await q(`SELECT key, value FROM ${T("settings")}`);
		const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
		const provider = PROVIDERS.includes(s.provider) ? s.provider : "anthropic";
		const envKey = process.env.CATEGORIZER_API_KEY || (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : "") || "";
		return {
			provider,
			model: s.model || DEFAULTS[provider].model,
			base_url: s.base_url || DEFAULTS[provider].base_url,
			api_key: envKey || s.api_key || "",
			api_key_from_env: envKey !== "",
			effort: EFFORTS.includes(s.effort) ? s.effort : "low",
			batch_size: Number(s.batch_size) || 40,
			review_threshold: s.review_threshold === undefined ? 0.75 : Number(s.review_threshold),
		};
	}

	const publicSettings = (s) => {
		const { api_key, ...rest } = s;
		return { ...rest, api_key_set: api_key !== "", providers: PROVIDERS, defaults: DEFAULTS };
	};

	// -----------------------------------------------------------------------
	// Accounts and examples
	// -----------------------------------------------------------------------

	async function statementAccount(code) {
		const accounts = await ctx.ledger.listAccounts({ includeInactive: true });
		const account = accounts.find((a) => a.code === code);
		if (!account) throw bad(`no account with code ${JSON.stringify(code)}`);
		return { account, accounts };
	}

	async function loadRules() {
		const { rows } = await q(`SELECT payee_key, account_code, example, hits FROM ${T("rules")} ORDER BY updated_at DESC`);
		return rows;
	}

	async function examplesFor(account, candidates, rules) {
		const allowed = new Set(candidates.map((a) => a.code));
		const fromRules = rules.filter((r) => allowed.has(r.account_code)).slice(0, 30).map((r) => ({ description: r.example, account_code: r.account_code }));
		const entries = await ctx.ledger.listJournalEntries({ accountCode: account.code, limit: 300 });
		const seen = new Set(fromRules.map((e) => payeeKey(e.description)));
		const fromBooks = examplesFromEntries(entries, account.code, allowed).filter((e) => !seen.has(payeeKey(e.description)));
		return [...fromRules, ...fromBooks];
	}

	/** A dashboard notification per statement with transactions waiting to be posted; removed once none are left. */
	async function syncStatementNotice(id) {
		const key = `statement-${id}`;
		const { review_threshold } = await readSettings();
		const { rows } = await q(
			`SELECT s.filename, s.account_code, s.status, s.error,
			        count(t.id) FILTER (WHERE t.status = 'new')::int AS open,
			        count(t.id) FILTER (WHERE t.status = 'new' AND (COALESCE(t.chosen_code, t.suggested_code) IS NULL
			                            OR (t.chosen_code IS NULL AND COALESCE(t.confidence, 0) < $2)))::int AS review
			   FROM ${T("statements")} s LEFT JOIN ${T("transactions")} t ON t.statement_id = s.id
			  WHERE s.id = $1 GROUP BY s.id`,
			[id, review_threshold],
		);
		const s = rows[0];
		if (!s || (s.open === 0 && s.status !== "error")) return dash.remove(key, "notification");
		if (s.status === "error") {
			return dash.notify({ key, title: `${s.filename}: suggestions failed`.slice(0, 200), body: `${s.error ?? ""}\nRe-run them on the Statements tab.`.trim(), level: "danger", link: dash.link });
		}
		if (s.status === "queued" || s.status === "categorizing") return;
		await dash.notify({
			key,
			title: `${s.filename}: ${s.open} transaction${s.open === 1 ? "" : "s"} to post`.slice(0, 200),
			body: `${s.review > 0 ? `${s.review} need${s.review === 1 ? "s" : ""} review.` : "Every suggestion is confident."} Account ${s.account_code}.`,
			level: s.review > 0 ? "warning" : "info",
			link: dash.link,
		});
	}

	// -----------------------------------------------------------------------
	// Background categorisation (one statement at a time)
	// -----------------------------------------------------------------------

	let queue = Promise.resolve();
	const enqueue = (statementId, opts = {}) => {
		queue = queue
			.then(() => categorizeStatement(statementId, opts))
			.catch((err) => ctx.log.error("categorize failed", { statement: String(statementId), err: String(err?.message || err) }));
	};

	async function categorizeStatement(id, { all = false } = {}) {
		const { rows } = await q(`UPDATE ${T("statements")} SET status = 'categorizing', error = NULL WHERE id = $1 RETURNING account_code`, [id]);
		if (rows.length === 0) return;
		try {
			// Payments of known bills don't need the model.
			await bills.autoMatch();
			const cfg = await readSettings();
			const { account, accounts } = await statementAccount(rows[0].account_code);
			const candidates = candidateAccounts(accounts, account);
			const rules = await loadRules();
			const examples = await examplesFor(account, candidates, rules);
			const { rows: txs } = await q(
				`SELECT id, tx_date::text AS date, description, memo, amount_cents FROM ${T("transactions")}
				  WHERE statement_id = $1 AND status = 'new' AND bill_id IS NULL AND ($2 OR suggested_code IS NULL OR source = 'error')
				  ORDER BY line_no`,
				[id, all],
			);
			const started = Date.now();
			const out = await suggest({
				cfg,
				statementAccount: account,
				candidates,
				examples,
				rules: new Map(rules.map((r) => [r.payee_key, r])),
				transactions: txs,
				batchSize: cfg.batch_size,
			});
			const ids = [...out.keys()].map(String);
			const v = [...out.values()];
			await q(
				`UPDATE ${T("transactions")} t
				    SET suggested_code = u.code, confidence = u.confidence, reason = u.reason, source = u.source, error = NULL
				   FROM unnest($1::bigint[], $2::text[], $3::real[], $4::text[], $5::text[]) AS u(id, code, confidence, reason, source)
				  WHERE t.id = u.id AND t.status = 'new'`,
				[ids, v.map((s) => s.code), v.map((s) => s.confidence), v.map((s) => s.reason), v.map((s) => s.source)],
			);
			const failed = v.filter((s) => s.source === "error");
			const error = failed.length > 0 ? `${failed.length} of ${v.length} transactions could not be categorised: ${failed[0].reason}` : null;
			await q(`UPDATE ${T("statements")} SET status = 'ready', error = $2, categorized_at = now() WHERE id = $1`, [id, error]);
			await syncStatementNotice(id);
			ctx.log.info("statement categorized", { statement: String(id), transactions: txs.length, failed: failed.length, ms: Date.now() - started });
		} catch (err) {
			const msg = err instanceof ctx.HttpError || err instanceof LlmError || err instanceof Error ? err.message : String(err);
			await q(`UPDATE ${T("statements")} SET status = 'error', error = $2 WHERE id = $1`, [id, msg]);
			await syncStatementNotice(id);
			throw err;
		}
	}

	const bills = registerBills(ctx, {
		q,
		T,
		bad,
		readSettings,
		requeue: async (ids) => {
			for (const sid of ids) {
				const { rowCount } = await q(`UPDATE ${T("statements")} SET status = 'queued' WHERE id = $1 AND status IN ('ready', 'error')`, [sid]);
				if (rowCount > 0) enqueue(sid);
			}
		},
	});

	// Resume work interrupted by a restart (not awaited: register must finish quickly).
	const { rows: unfinished } = await q(`SELECT id FROM ${T("statements")} WHERE status IN ('queued', 'categorizing') ORDER BY id`);
	for (const r of unfinished) enqueue(r.id);
	await q(
		`UPDATE ${T("transactions")} SET status = 'new', error = 'interrupted while posting; check the journal for this transaction before posting it again'
		  WHERE status = 'posting'`,
	);

	// -----------------------------------------------------------------------
	// Routes: settings
	// -----------------------------------------------------------------------

	ctx.route("GET", "/settings", async () => publicSettings(await readSettings()));

	ctx.route("PUT", "/settings", async (req) => {
		const b = req.body ?? {};
		const set = {};
		if (b.provider !== undefined) {
			if (!PROVIDERS.includes(b.provider)) throw bad(`provider must be one of ${PROVIDERS.join(", ")}`);
			set.provider = b.provider;
		}
		for (const k of ["model", "base_url"]) {
			if (b[k] !== undefined) {
				if (typeof b[k] !== "string" || b[k].length > 300) throw bad(`${k} must be a string`);
				set[k] = b[k].trim();
			}
		}
		if (set.base_url && !/^https?:\/\/[^\s]+$/.test(set.base_url)) throw bad("base_url must start with http:// or https://");
		if (b.effort !== undefined) {
			if (!EFFORTS.includes(b.effort)) throw bad(`effort must be one of ${EFFORTS.join(", ")}`);
			set.effort = b.effort;
		}
		if (b.batch_size !== undefined) {
			const n = Number(b.batch_size);
			if (!Number.isInteger(n) || n < 1 || n > 200) throw bad("batch_size must be 1-200");
			set.batch_size = String(n);
		}
		if (b.review_threshold !== undefined) {
			const n = Number(b.review_threshold);
			if (!(n >= 0 && n <= 1)) throw bad("review_threshold must be between 0 and 1");
			set.review_threshold = String(n);
		}
		if (b.api_key !== undefined) {
			if (b.api_key !== null && (typeof b.api_key !== "string" || b.api_key.length > 500)) throw bad("api_key must be a string or null");
			set.api_key = b.api_key === null ? "" : b.api_key.trim();
		}
		for (const [key, value] of Object.entries(set)) {
			if (!SETTING_KEYS.includes(key)) continue;
			if (value === "") await q(`DELETE FROM ${T("settings")} WHERE key = $1`, [key]);
			else await q(`INSERT INTO ${T("settings")} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
		}
		// Switching provider resets model and URL to that provider's defaults unless given.
		if (set.provider) {
			const reset = ["model", "base_url"].filter((k) => b[k] === undefined);
			if (reset.length > 0) await q(`DELETE FROM ${T("settings")} WHERE key = ANY($1::text[])`, [reset]);
		}
		ctx.log.info("settings changed", { by: req.user.username, keys: Object.keys(set).join(",") });
		return publicSettings(await readSettings());
	});

	ctx.route("POST", "/settings/test", async () => {
		const cfg = await readSettings();
		const started = Date.now();
		try {
			const r = await completeJson(cfg, {
				system: "You check that a connection works.",
				prompt: 'Answer with {"ok": true}.',
				schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
				maxTokens: 2000,
			});
			return { ok: r.data?.ok === true, model: r.model, ms: Date.now() - started };
		} catch (err) {
			return { ok: false, error: err.message, ms: Date.now() - started };
		}
	});

	// -----------------------------------------------------------------------
	// Routes: accounts, rules
	// -----------------------------------------------------------------------

	ctx.route("GET", "/accounts", async () => {
		const accounts = await ctx.ledger.listAccounts();
		return { data: accounts.map((a) => ({ code: a.code, name: a.name, type: a.type, currency: a.currency })) };
	});

	ctx.route("GET", "/rules", async () => ({ data: await q(`SELECT payee_key, account_code, example, hits, updated_by, updated_at FROM ${T("rules")} ORDER BY payee_key`).then((r) => r.rows) }));

	ctx.route("DELETE", "/rules/:key", async (req) => {
		const { rowCount } = await q(`DELETE FROM ${T("rules")} WHERE payee_key = $1`, [req.params.key]);
		if (rowCount === 0) throw new ctx.HttpError(404, "no such rule");
	});

	// -----------------------------------------------------------------------
	// Routes: statements
	// -----------------------------------------------------------------------

	const STATEMENT_SELECT = `
		SELECT s.id, s.filename, s.account_code, s.format, s.status, s.error, s.duplicates, s.uploaded_by, s.created_at, s.categorized_at,
		       count(t.id)::int AS total,
		       count(t.id) FILTER (WHERE t.status = 'posted')::int AS posted,
		       count(t.id) FILTER (WHERE t.status = 'skipped')::int AS skipped,
		       min(t.tx_date)::text AS first_date, max(t.tx_date)::text AS last_date
		  FROM ${T("statements")} s LEFT JOIN ${T("transactions")} t ON t.statement_id = s.id`;

	ctx.route("GET", "/statements", async () => {
		const { rows } = await q(`${STATEMENT_SELECT} GROUP BY s.id ORDER BY s.id DESC LIMIT 200`);
		return { data: rows };
	});

	ctx.route("POST", "/statements", async (req) => {
		const b = req.body ?? {};
		const filename = typeof b.filename === "string" ? b.filename.trim().slice(0, 200) : "";
		if (typeof b.content !== "string" || b.content.trim() === "") throw bad("content (the statement file's text) is required");
		if (b.content.length > MAX_CONTENT_CHARS) throw bad("the file is too large; split it into smaller statements");
		if (typeof b.account_code !== "string" || b.account_code === "") throw bad("account_code (the bank or card account) is required");
		const dateOrder = ["auto", "mdy", "dmy"].includes(b.date_order) ? b.date_order : "auto";
		const { account } = await statementAccount(b.account_code);
		if (!account.is_active) throw bad(`account ${account.code} is inactive`);

		let parsed;
		try {
			parsed = parseStatement(b.content, { filename, dateOrder });
		} catch (err) {
			if (err instanceof ParseError) throw bad(err.message);
			throw err;
		}
		const flip = b.flip_signs === true;
		const txs = parsed.transactions.map((t) => ({ ...t, amount_cents: flip ? -t.amount_cents : t.amount_cents }));

		// Fingerprints identify a transaction across overlapping uploads.
		const occurrences = new Map();
		const fingerprints = txs.map((t) => {
			if (t.fitid) return createHash("sha256").update(`fitid|${t.fitid}`).digest("hex");
			const base = `${t.date}|${t.amount_cents}|${t.description.toUpperCase().replace(/\s+/g, " ")}`;
			const n = (occurrences.get(base) ?? 0) + 1;
			occurrences.set(base, n);
			return createHash("sha256").update(`${base}|${n}`).digest("hex");
		});

		const { rows } = await q(
			`INSERT INTO ${T("statements")} (filename, account_code, format, uploaded_by) VALUES ($1, $2, $3, $4) RETURNING id`,
			[filename || `statement.${parsed.format}`, account.code, parsed.format, req.user.username],
		);
		const id = rows[0].id;
		const { rowCount } = await q(
			`INSERT INTO ${T("transactions")} (statement_id, line_no, account_code, fingerprint, tx_date, description, memo, amount_cents, fitid)
			 SELECT $1, u.line_no, $2, u.fp, u.d, u.description, u.memo, u.amount, u.fitid
			   FROM unnest($3::int[], $4::text[], $5::date[], $6::text[], $7::text[], $8::bigint[], $9::text[])
			        AS u(line_no, fp, d, description, memo, amount, fitid)
			 ON CONFLICT (account_code, fingerprint) DO NOTHING`,
			[
				id,
				account.code,
				txs.map((t) => t.line),
				fingerprints,
				txs.map((t) => t.date),
				txs.map((t) => t.description.slice(0, 500)),
				txs.map((t) => t.memo.slice(0, 500)),
				txs.map((t) => t.amount_cents.toString()),
				txs.map((t) => t.fitid.slice(0, 100)),
			],
		);
		const duplicates = txs.length - rowCount;
		if (rowCount === 0) {
			await q(`DELETE FROM ${T("statements")} WHERE id = $1`, [id]);
			throw new ctx.HttpError(409, `all ${txs.length} transactions in this file were uploaded before`);
		}
		await q(`UPDATE ${T("statements")} SET duplicates = $2 WHERE id = $1`, [id, duplicates]);
		enqueue(id);
		ctx.log.info("statement uploaded", { statement: String(id), account: account.code, transactions: rowCount, duplicates, by: req.user.username });
		return ctx.response(201, { id, transactions: rowCount, duplicates, warnings: parsed.warnings.slice(0, 50) });
	});

	async function getStatement(id) {
		if (!/^\d+$/.test(id)) throw new ctx.HttpError(404, "no such statement");
		const { rows } = await q(`${STATEMENT_SELECT} WHERE s.id = $1 GROUP BY s.id`, [id]);
		if (rows.length === 0) throw new ctx.HttpError(404, "no such statement");
		return rows[0];
	}

	ctx.route("GET", "/statements/:id", async (req) => {
		const statement = await getStatement(req.params.id);
		const { rows } = await q(
			`SELECT t.id, t.line_no, t.tx_date::text AS date, t.description, t.memo, t.amount_cents, t.fitid, t.suggested_code, t.confidence, t.reason, t.source,
			        t.chosen_code, COALESCE(t.chosen_code, t.suggested_code) AS account_code, t.status, t.journal_entry_id, t.error, t.posted_by, t.posted_at,
			        t.bill_id, b.vendor AS bill_vendor, b.status AS bill_status
			   FROM ${T("transactions")} t LEFT JOIN ${T("bills")} b ON b.id = t.bill_id
			  WHERE t.statement_id = $1 ORDER BY t.line_no, t.id`,
			[statement.id],
		);
		const { review_threshold } = await readSettings();
		return { statement, transactions: rows, review_threshold };
	});

	ctx.route("POST", "/statements/:id/categorize", async (req) => {
		const statement = await getStatement(req.params.id);
		if (statement.status === "categorizing" || statement.status === "queued") throw new ctx.HttpError(409, "this statement is already being categorised");
		await q(`UPDATE ${T("statements")} SET status = 'queued' WHERE id = $1`, [statement.id]);
		enqueue(statement.id, { all: req.body?.all === true });
		return ctx.response(202, { id: statement.id, status: "queued" });
	});

	ctx.route("DELETE", "/statements/:id", async (req) => {
		const statement = await getStatement(req.params.id);
		// Posted rows stay so their fingerprints keep blocking duplicate uploads.
		await q(`DELETE FROM ${T("transactions")} WHERE statement_id = $1 AND status <> 'posted'`, [statement.id]);
		await q(`DELETE FROM ${T("statements")} s WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM ${T("transactions")} t WHERE t.statement_id = s.id)`, [statement.id]);
		await syncStatementNotice(statement.id);
	});

	// -----------------------------------------------------------------------
	// Routes: reviewing transactions
	// -----------------------------------------------------------------------

	async function updateTransactions(ids, b) {
		if (!Array.isArray(ids) || ids.length === 0 || ids.length > 5000 || !ids.every((x) => /^\d+$/.test(String(x)))) throw bad("ids must be a list of transaction ids");
		const sets = [];
		const params = [ids.map(String)];
		if (b.account_code !== undefined) {
			if (b.account_code !== null && typeof b.account_code !== "string") throw bad("account_code must be a string or null");
			if (b.account_code) {
				const accounts = await ctx.ledger.listAccounts();
				if (!accounts.some((a) => a.code === b.account_code)) throw bad(`no active account with code ${JSON.stringify(b.account_code)}`);
			}
			params.push(b.account_code || null);
			sets.push(`chosen_code = $${params.length}`);
		}
		if (b.status !== undefined) {
			if (b.status !== "new" && b.status !== "skipped") throw bad('status must be "new" or "skipped"');
			params.push(b.status);
			sets.push(`status = $${params.length}`);
		}
		if (sets.length === 0) throw bad("nothing to change: give account_code and/or status");
		const { rows, rowCount } = await q(
			`UPDATE ${T("transactions")} SET ${sets.join(", ")}, error = NULL WHERE id = ANY($1::bigint[]) AND status IN ('new', 'skipped') RETURNING statement_id`,
			params,
		);
		for (const sid of new Set(rows.map((r) => r.statement_id))) await syncStatementNotice(sid);
		return { updated: rowCount };
	}

	ctx.route("PATCH", "/transactions/:id", async (req) => updateTransactions([req.params.id], req.body ?? {}));
	ctx.route("POST", "/transactions/bulk", async (req) => updateTransactions(req.body?.ids, req.body ?? {}));

	// -----------------------------------------------------------------------
	// Routes: posting to the journal
	// -----------------------------------------------------------------------

	async function learn(description, code, username) {
		const key = payeeKey(description);
		if (key === "") return;
		await q(
			`INSERT INTO ${T("rules")} (payee_key, account_code, example, hits, updated_by) VALUES ($1, $2, $3, 1, $4)
			 ON CONFLICT (payee_key) DO UPDATE
			    SET hits = CASE WHEN ${T("rules")}.account_code = EXCLUDED.account_code THEN ${T("rules")}.hits + 1 ELSE 1 END,
			        account_code = EXCLUDED.account_code, example = EXCLUDED.example, updated_by = EXCLUDED.updated_by, updated_at = now()`,
			[key, code, description.slice(0, 200), username],
		);
	}

	ctx.route("POST", "/statements/:id/post", async (req) => {
		const statement = await getStatement(req.params.id);
		const only = req.body?.ids;
		if (only !== undefined && (!Array.isArray(only) || !only.every((x) => /^\d+$/.test(String(x))))) throw bad("ids must be a list of transaction ids");
		const { rows } = await q(
			`SELECT id FROM ${T("transactions")}
			  WHERE statement_id = $1 AND status = 'new' AND COALESCE(chosen_code, suggested_code) IS NOT NULL
			    AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))
			  ORDER BY tx_date, line_no`,
			[statement.id, only === undefined ? null : only.map(String)],
		);
		const results = { posted: 0, failed: [] };
		for (const { id } of rows) {
			// Claim the row so a double click cannot post it twice.
			const claim = await q(
				`UPDATE ${T("transactions")} SET status = 'posting' WHERE id = $1 AND status = 'new'
				 RETURNING tx_date::text AS date, description, memo, amount_cents, fitid, account_code, COALESCE(chosen_code, suggested_code) AS code, bill_id`,
				[id],
			);
			if (claim.rowCount === 0) continue;
			const t = claim.rows[0];
			const amt = t.amount_cents;
			const abs = amt < 0n ? -amt : amt;
			try {
				const entry = await ctx.ledger.createJournalEntry(
					{
						entry_date: t.date,
						description: t.description.trim().slice(0, 500) || "Bank transaction",
						reference: (t.fitid || `categorizer ${statement.id}/${id}`).slice(0, 100),
						lines: [
							{ account_code: t.account_code, debit_cents: amt > 0n ? abs : 0n, credit_cents: amt < 0n ? abs : 0n, memo: t.memo.slice(0, 500) },
							{ account_code: t.code, debit_cents: amt < 0n ? abs : 0n, credit_cents: amt > 0n ? abs : 0n, memo: "" },
						],
					},
					req.user,
				);
				await q(
					`UPDATE ${T("transactions")} SET status = 'posted', journal_entry_id = $2, posted_by = $3, posted_at = now(), error = NULL WHERE id = $1`,
					[id, entry.id, req.user.username],
				);
				// A bill payment marks the bill paid; it isn't a payee rule (it books to payables).
				const paidBill = t.bill_id !== null && (await bills.onPosted(id, t.code, entry.id));
				if (!paidBill) await learn(t.description, t.code, req.user.username);
				results.posted++;
			} catch (err) {
				const msg = String(err?.message || err).slice(0, 500);
				await q(`UPDATE ${T("transactions")} SET status = 'new', error = $2 WHERE id = $1`, [id, msg]);
				results.failed.push({ id, error: msg });
			}
		}
		await syncStatementNotice(statement.id);
		ctx.log.info("transactions posted", { statement: String(statement.id), posted: results.posted, failed: results.failed.length, by: req.user.username });
		return results;
	});

	// -----------------------------------------------------------------------
	// Route: suggestions without staging (for scripts and other modules)
	// -----------------------------------------------------------------------

	// POST /suggest {"account_code": "1000", "transactions": [{"date": "2026-03-01", "description": "SHELL", "amount": "-45.10"}]}
	ctx.route("POST", "/suggest", async (req) => {
		const b = req.body ?? {};
		if (!Array.isArray(b.transactions) || b.transactions.length === 0 || b.transactions.length > 500) throw bad("transactions must be a list of 1-500 items");
		const { account, accounts } = await statementAccount(String(b.account_code ?? ""));
		const txs = b.transactions.map((t, i) => {
			const amount = typeof t?.amount === "number" ? parseAmount(t.amount.toFixed(2)) : parseAmount(t?.amount);
			const date = parseDate(t?.date ?? "", "mdy");
			if (amount === null || !date || typeof t.description !== "string") throw bad(`transactions[${i}] needs date, description and amount`);
			return { id: i, date, description: t.description.slice(0, 500), memo: typeof t.memo === "string" ? t.memo.slice(0, 500) : "", amount_cents: amount };
		});
		const cfg = await readSettings();
		const candidates = candidateAccounts(accounts, account);
		const rules = await loadRules();
		const out = await suggest({
			cfg,
			statementAccount: account,
			candidates,
			examples: await examplesFor(account, candidates, rules),
			rules: new Map(rules.map((r) => [r.payee_key, r])),
			transactions: txs,
			batchSize: cfg.batch_size,
		});
		return {
			data: txs.map((t) => {
				const s = out.get(t.id);
				return { index: t.id, account_code: s.code, confidence: s.confidence, reason: s.reason, source: s.source, needs_review: s.code === null || s.confidence < cfg.review_threshold };
			}),
		};
	});

	ctx.log.info("categorizer ready", { resumed: unfinished.length });
}
