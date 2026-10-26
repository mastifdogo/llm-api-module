// Bills from email: a scheduled IMAP check reads new messages, the LLM pulls
// out bills and receipts, you approve them, and statement transactions that
// pay them are matched automatically.
//
// Approving a bill with an accounts-payable account configured posts
// Dr <bill account> / Cr <payable>; the matched bank payment then books
// Dr <payable> / Cr <bank>. Without a payable account, bills are only
// tracked and the payment books straight to the bill's account.

import { formatCents } from "./categorize.mjs";
import { dashboard } from "./dashboard.mjs";
import { assignMatches, DEFAULT_KEYWORDS, extractBill, findDuplicate, looksLikeBill } from "./bills.mjs";
import { randomBytes } from "node:crypto";
import { GmailBridge, bridgeScript, gmailQuery, validBridgeUrl } from "./gmail.mjs";
import { ImapClient } from "./imap.mjs";
import { readsPdf } from "./llm.mjs";
import { parseEmail } from "./mime.mjs";
import { parseAmount, parseDate } from "./parse.mjs";

const MAX_MESSAGE_BYTES = 15 << 20;
const MAX_DOCUMENT_BYTES = 5 << 20;
const MAX_MESSAGES_PER_CHECK = 200;
const MAIL_KEYS = ["mail_source", "gmail_url", "gmail_token", "gmail_query", "imap_host", "imap_port", "imap_user", "imap_password", "imap_folder", "mail_interval", "mail_keywords", "mail_lookback_days", "ap_account"];

const BILL_COLUMNS = `b.id, b.kind, b.status, b.vendor, b.invoice_number, b.bill_date::text AS bill_date, b.due_date::text AS due_date, b.amount_cents,
	b.currency, b.account_code, b.confidence, b.summary, b.error, b.source, b.mail_from, b.mail_subject, b.mail_date, b.document_name,
	(b.document IS NOT NULL) AS has_document, b.journal_entry_id, b.ap_account, b.paid_entry_id, b.paid_at, b.updated_by, b.created_at, b.updated_at`;

/**
 * h: { q, T, bad, readSettings, requeue(statementIds) }
 * Returns { autoMatch, targetOf, onPosted } for the statement side.
 */
export function registerBills(ctx, h) {
	const { q, T, bad } = h;
	const dash = dashboard(ctx);

	// -----------------------------------------------------------------------
	// Mail settings and state
	// -----------------------------------------------------------------------

	async function mailSettings() {
		const { rows } = await q(`SELECT key, value FROM ${T("settings")} WHERE key = ANY($1::text[]) OR key = 'mail_state'`, [MAIL_KEYS]);
		const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
		const envPassword = process.env.CATEGORIZER_IMAP_PASSWORD || "";
		let state = {};
		try {
			state = JSON.parse(s.mail_state ?? "{}");
		} catch {}
		return {
			mail_source: s.mail_source === "gmail" ? "gmail" : "imap",
			gmail_url: s.gmail_url ?? "",
			gmail_token: s.gmail_token ?? "",
			gmail_query: s.gmail_query ?? "",
			imap_host: s.imap_host ?? "",
			imap_port: Number(s.imap_port) || 993,
			imap_user: s.imap_user ?? "",
			imap_password: envPassword || s.imap_password || "",
			imap_password_from_env: envPassword !== "",
			imap_folder: s.imap_folder || "INBOX",
			mail_interval: s.mail_interval === undefined ? 60 : Number(s.mail_interval),
			mail_keywords: s.mail_keywords === undefined ? DEFAULT_KEYWORDS : s.mail_keywords.split(",").map((k) => k.trim()).filter(Boolean),
			mail_lookback_days: Number(s.mail_lookback_days) || 30,
			ap_account: s.ap_account ?? "",
			state,
		};
	}

	/** What's missing before mail can be read, or "" when ready. */
	const missing = (m) =>
		m.mail_source === "gmail"
			? !m.gmail_token
				? 'Gmail is not set up: press "Show the script", deploy it in Apps Script, and paste the web app URL'
				: !m.gmail_url
					? "Gmail is not set up: paste the web app URL from Apps Script"
					: ""
			: !m.imap_host || !m.imap_user || !m.imap_password
				? "email is not set up (server, user name and password)"
				: "";
	const configured = (m) => (m.mail_source === "gmail" ? m.gmail_url !== "" && m.gmail_token !== "" : m.imap_host !== "" && m.imap_user !== "" && m.imap_password !== "");

	const publicMail = (m) => {
		const { imap_password, gmail_token, ...rest } = m;
		return {
			...rest,
			imap_password_set: imap_password !== "",
			gmail_token_set: gmail_token !== "",
			configured: configured(m),
			effective_gmail_query: gmailQuery({ lookbackDays: m.mail_lookback_days, keywords: m.mail_keywords, custom: m.gmail_query }),
			running: checking,
			default_keywords: DEFAULT_KEYWORDS,
		};
	};

	async function saveSetting(key, value) {
		if (value === "" || value === null) await q(`DELETE FROM ${T("settings")} WHERE key = $1`, [key]);
		else await q(`INSERT INTO ${T("settings")} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, String(value)]);
	}

	async function saveState(patch) {
		const { state } = await mailSettings();
		await saveSetting("mail_state", JSON.stringify({ ...state, ...patch }));
	}

	async function accountsByCode() {
		return new Map((await ctx.ledger.listAccounts({ includeInactive: true })).map((a) => [a.code, a]));
	}

	/**
	 * Implicit TLS, except for a mail bridge on this machine (e.g. Proton Bridge on 127.0.0.1:1143),
	 * which may run without TLS or with a self-signed certificate. Passwords never cross the network unencrypted.
	 */
	function clientFor(mail, timeoutMs = 60_000) {
		const local = /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(mail.imap_host);
		return new ImapClient({ host: mail.imap_host, port: mail.imap_port, secure: !local || mail.imap_port === 993, rejectUnauthorized: !local, timeoutMs });
	}

	/**
	 * The mailbox to read: { folder, uidvalidity, account, keys(), fetch(key) -> Buffer | { tooLarge } | null, close() }.
	 * IMAP folders are tracked by UIDVALIDITY and UID; Gmail (through the Apps Script bridge) by message id.
	 */
	async function openMailbox(mail, since, timeoutMs = 60_000) {
		if (mail.mail_source === "gmail") {
			const bridge = new GmailBridge({ url: mail.gmail_url, token: mail.gmail_token });
			const query = gmailQuery({ lookbackDays: mail.mail_lookback_days, keywords: mail.mail_keywords, custom: mail.gmail_query });
			let listing = null;
			return {
				folder: "gmail",
				uidvalidity: 0,
				async keys() {
					listing ??= await bridge.list({ query, since, max: 500 });
					return listing.messages.map((m) => m.id);
				},
				async account() {
					listing ??= await bridge.list({ query, since, max: 500 });
					return listing.account;
				},
				async fetch(id) {
					const r = await bridge.raw(id);
					return r.tooLarge ? { tooLarge: true } : r.data;
				},
				async close() {},
				abort() {},
			};
		}
		const client = clientFor(mail, timeoutMs);
		await client.connect();
		try {
			await client.login(mail.imap_user, mail.imap_password);
			const { uidvalidity, exists } = await client.examine(mail.imap_folder);
			return {
				folder: mail.imap_folder,
				uidvalidity,
				exists,
				async keys() {
					return (await client.searchSince(since)).map(String);
				},
				async account() {
					return mail.imap_user;
				},
				async fetch(uid) {
					const size = await client.size(uid);
					if (size !== null && size > MAX_MESSAGE_BYTES) return { tooLarge: true };
					return client.fetch(uid);
				},
				close: () => client.logout(),
				abort: () => client.close(),
			};
		} catch (err) {
			client.close();
			throw err;
		}
	}

	// -----------------------------------------------------------------------
	// Checking the mailbox
	// -----------------------------------------------------------------------

	let checking = false;

	async function pastVendors() {
		const { rows } = await q(
			`SELECT DISTINCT ON (lower(vendor)) vendor, account_code FROM ${T("bills")}
			  WHERE status IN ('open', 'paid') AND account_code IS NOT NULL AND vendor <> '' ORDER BY lower(vendor), updated_at DESC LIMIT 60`,
		);
		return rows;
	}

	async function billAccounts(ap) {
		return (await ctx.ledger.listAccounts()).filter((a) => a.code !== ap);
	}

	/** Extracts and stores a bill from a parsed email; returns { outcome, bill_id }. */
	async function ingest(email, { source, cfg, mail }) {
		if (email.messageId) {
			const { rows } = await q(`SELECT id FROM ${T("bills")} WHERE message_id = $1`, [email.messageId]);
			if (rows.length > 0) return { outcome: "duplicate", bill_id: rows[0].id };
		}
		const pdfs = email.attachments.filter((a) => a.contentType === "application/pdf" && a.data.length <= 30 << 20);
		const accounts = await billAccounts(mail.ap_account);
		const x = await extractBill({ cfg, email, pdfs: pdfs.slice(0, 3), accounts, examples: await pastVendors() });
		if (x.kind === "not_bill" && source === "email") return { outcome: "not_bill", bill_id: null };
		const { rows: recent } = await q(
			`SELECT id, vendor, invoice_number, bill_date::text AS bill_date, due_date::text AS due_date, amount_cents FROM ${T("bills")}
			  WHERE status <> 'ignored' AND created_at > now() - interval '180 days'`,
		);
		const dup = findDuplicate(x, recent);
		if (dup) return { outcome: "duplicate", bill_id: dup.id };
		const doc = pdfs.find((p) => p.data.length <= MAX_DOCUMENT_BYTES) ?? null;
		const notes = [];
		if (x.kind === "not_bill") notes.push("This doesn't look like a bill; fill in the details or ignore it.");
		if (x.currency === "other") notes.push("The bill is in a currency Ledger doesn't use.");
		if (x.amount_cents === null) notes.push(pdfs.length > 0 && !readsPdf(cfg) ? "No amount found: it's probably in the PDF, which only Claude can read." : "No amount found.");
		const { rows } = await q(
			`INSERT INTO ${T("bills")} (kind, vendor, invoice_number, bill_date, due_date, amount_cents, currency, account_code, confidence, summary, error,
			                            source, message_id, mail_from, mail_subject, mail_date, body_text, document_name, document_type, document)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
			[
				x.kind === "receipt" ? "receipt" : "bill",
				x.vendor,
				x.invoice_number,
				x.bill_date,
				x.due_date,
				x.amount_cents === null ? null : x.amount_cents.toString(),
				x.currency === "USD" ? "USD" : "CAD",
				x.account_code,
				x.confidence,
				x.summary,
				notes.join(" ") || null,
				source,
				email.messageId,
				email.from.slice(0, 300),
				email.subject.slice(0, 500),
				email.date,
				email.text.slice(0, 50_000),
				doc ? (doc.filename || "document.pdf").slice(0, 200) : null,
				doc ? doc.contentType : null,
				doc ? doc.data : null,
			],
		);
		return { outcome: x.kind === "receipt" ? "receipt" : "bill", bill_id: rows[0].id };
	}

	async function checkMail({ trigger = "schedule" } = {}) {
		if (checking) return { skipped: "a check is already running" };
		checking = true;
		const started = new Date();
		const result = { looked_at: 0, bills: 0, receipts: 0, duplicates: 0, not_bills: 0, filtered: 0, too_large: 0, remaining: 0 };
		let box;
		try {
			const mail = await mailSettings();
			if (!configured(mail)) throw new Error(missing(mail));
			const cfg = await h.readSettings();
			const since = new Date(Date.now() - mail.mail_lookback_days * 86_400_000);
			box = await openMailbox(mail, since);
			const keys = await box.keys();
			const { rows: seen } = await q(`SELECT uid FROM ${T("mail_seen")} WHERE folder = $1 AND uidvalidity = $2 AND uid = ANY($3::text[])`, [
				box.folder,
				box.uidvalidity,
				keys,
			]);
			const done = new Set(seen.map((r) => r.uid));
			const todo = keys.filter((k) => !done.has(k));
			result.remaining = Math.max(0, todo.length - MAX_MESSAGES_PER_CHECK);
			for (const uid of todo.slice(0, MAX_MESSAGES_PER_CHECK)) {
				let outcome;
				let billId = null;
				let subject = "";
				const raw = await box.fetch(uid);
				if (!raw) continue;
				if (raw.tooLarge) outcome = "too_large";
				else {
					const email = parseEmail(raw);
					subject = email.subject;
					if (!looksLikeBill(email, mail.mail_keywords)) outcome = "filtered";
					else ({ outcome, bill_id: billId } = await ingest(email, { source: "email", cfg, mail }));
				}
				await q(
					`INSERT INTO ${T("mail_seen")} (folder, uidvalidity, uid, outcome, bill_id, subject) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
					[box.folder, box.uidvalidity, uid, outcome, billId, subject.slice(0, 300)],
				);
				result.looked_at++;
				const key = { bill: "bills", receipt: "receipts", duplicate: "duplicates", not_bill: "not_bills", filtered: "filtered", too_large: "too_large" }[outcome];
				if (key) result[key]++;
			}
			await box.close();
			await saveState({ last_check_at: started.toISOString(), last_ok_at: new Date().toISOString(), error: null, result, trigger });
			await dash.remove("mail-error", "notification");
			if (result.bills + result.receipts > 0) await autoMatch();
			ctx.log.info("mail checked", { ...result, trigger });
			return result;
		} catch (err) {
			box?.abort();
			const error = String(err?.message || err).slice(0, 500);
			await saveState({ last_check_at: started.toISOString(), error, result, trigger });
			await dash.notify({ key: "mail-error", title: "Couldn't check email for bills", body: `${error}\nSee LLM API → Settings → Email.`, level: "danger", link: dash.link });
			ctx.log.warn("mail check failed", { err: error, trigger });
			return { ...result, error };
		} finally {
			checking = false;
		}
	}

	// Scheduler: every minute, check whether a mail check is due.
	const timer = setInterval(async () => {
		try {
			const m = await mailSettings();
			if (!(m.mail_interval > 0) || !configured(m) || checking) return;
			const last = Date.parse(m.state.last_check_at ?? "") || 0;
			if (Date.now() - last >= m.mail_interval * 60_000) await checkMail();
		} catch (err) {
			ctx.log.error("mail scheduler", { err: String(err?.message || err) });
		}
	}, 60_000);
	timer.unref?.();

	// -----------------------------------------------------------------------
	// Matching bills to statement transactions
	// -----------------------------------------------------------------------

	/** The account a payment of this bill is booked to. */
	const targetOf = (b) => b.ap_account || b.account_code || null;

	/** Links unposted outgoing transactions to open bills they pay, and refreshes existing links. */
	async function autoMatch() {
		const n = await matchBills();
		await syncBillTodos();
		return n;
	}

	/** One dashboard to-do per unpaid bill (with its due date); ticked when paid, removed when ignored or deleted. */
	async function syncBillTodos() {
		const { rows } = await q(
			`SELECT b.id, b.kind, b.status, b.vendor, b.invoice_number, b.due_date::text AS due_date, b.amount_cents, b.currency, b.journal_entry_id,
			        EXISTS (SELECT 1 FROM ${T("transactions")} t WHERE t.bill_id = b.id AND t.status = 'new') AS matched
			   FROM ${T("bills")} b
			  WHERE b.status IN ('new', 'open') OR b.updated_at > now() - interval '3 days'`,
		);
		for (const b of rows) {
			const key = `bill-${b.id}`;
			if (b.kind !== "bill" || b.status === "ignored") await dash.remove(key);
			else if (b.status === "paid") await dash.complete(key);
			else {
				const vendor = b.vendor || "unknown vendor";
				const amount = b.amount_cents === null ? "" : ` ${formatCents(b.amount_cents)} ${b.currency}`;
				const body = [
					b.invoice_number ? `Invoice ${b.invoice_number}.` : "",
					b.status === "new" ? "Check the details on the Bills tab and approve it." : "",
					b.journal_entry_id ? "Posted to accounts payable." : "",
					b.matched ? "Its payment is on a statement: post it on the Statements tab to mark the bill paid." : "",
				].filter(Boolean).join(" ");
				await dash.todo({
					key,
					title: (b.status === "new" ? `Review bill: ${vendor}${amount}` : `Pay ${vendor}${amount}`).slice(0, 200),
					body,
					due: b.due_date,
					link: dash.link,
				});
			}
		}
	}

	async function matchBills() {
		// Keep suggestions of existing links in step with their bill (e.g. after approval moved it to payables).
		await q(
			`UPDATE ${T("transactions")} t SET suggested_code = COALESCE(b.ap_account, b.account_code)
			   FROM ${T("bills")} b
			  WHERE t.bill_id = b.id AND t.status = 'new' AND t.source = 'bill' AND COALESCE(b.ap_account, b.account_code) IS NOT NULL`,
		);
		const { rows: bills } = await q(
			`SELECT b.id, b.kind, b.vendor, b.invoice_number, b.bill_date::text AS bill_date, b.due_date::text AS due_date, b.mail_date::date::text AS mail_date,
			        b.amount_cents, b.currency, b.account_code, b.ap_account
			   FROM ${T("bills")} b
			  WHERE b.status IN ('new', 'open') AND b.amount_cents IS NOT NULL AND COALESCE(b.ap_account, b.account_code) IS NOT NULL
			    AND NOT EXISTS (SELECT 1 FROM ${T("transactions")} t WHERE t.bill_id = b.id AND t.status IN ('new', 'posting', 'posted'))`,
		);
		if (bills.length === 0) return 0;
		const { rows: txs } = await q(
			`SELECT id, statement_id, account_code, tx_date::text AS date, description, amount_cents, rejected_bill_id FROM ${T("transactions")}
			  WHERE status = 'new' AND bill_id IS NULL AND chosen_code IS NULL AND amount_cents < 0
			    AND transfer_tx_id IS NULL AND transfer_entry_id IS NULL`,
		);
		const accounts = await accountsByCode();
		let n = 0;
		for (const currency of ["CAD", "USD"]) {
			const pairs = assignMatches(
				bills.filter((b) => b.currency === currency),
				txs.filter((t) => accounts.get(t.account_code)?.currency === currency),
				(b, t) => t.rejected_bill_id === null || BigInt(t.rejected_bill_id) !== BigInt(b.id),
			);
			for (const { bill, tx, score } of pairs) {
				const reason = `pays ${bill.vendor || "bill"}${bill.invoice_number ? ` #${bill.invoice_number}` : ""}${bill.due_date ? ` due ${bill.due_date}` : ""}`;
				await q(
					`UPDATE ${T("transactions")} SET bill_id = $2, suggested_code = $3, confidence = $4, reason = $5, source = 'bill', error = NULL
					  WHERE id = $1 AND status = 'new' AND bill_id IS NULL AND chosen_code IS NULL`,
					[tx.id, bill.id, targetOf(bill), score, reason.slice(0, 200)],
				);
				n++;
			}
		}
		if (n > 0) ctx.log.info("bills matched", { matches: n });
		return n;
	}

	/** Called after a statement transaction is posted: marks its bill paid if it was booked as the bill's payment. */
	async function onPosted(txId, code, entryId) {
		const { rows } = await q(
			`UPDATE ${T("bills")} b SET status = 'paid', paid_entry_id = $3, paid_at = now(), updated_at = now()
			   FROM ${T("transactions")} t
			  WHERE t.id = $1 AND t.bill_id = b.id AND COALESCE(b.ap_account, b.account_code) = $2 AND b.status IN ('new', 'open')
			  RETURNING b.id`,
			[txId, code, entryId],
		);
		for (const r of rows) await dash.complete(`bill-${r.id}`);
		return rows.length > 0;
	}

	/** Unlinks unposted transactions from a bill and re-categorises their statements. */
	async function unlink(billId) {
		const { rows } = await q(
			`UPDATE ${T("transactions")} SET bill_id = NULL,
			        suggested_code = CASE WHEN source = 'bill' THEN NULL ELSE suggested_code END,
			        confidence = CASE WHEN source = 'bill' THEN NULL ELSE confidence END,
			        reason = CASE WHEN source = 'bill' THEN '' ELSE reason END,
			        source = CASE WHEN source = 'bill' THEN '' ELSE source END
			  WHERE bill_id = $1 AND status IN ('new', 'skipped') RETURNING statement_id`,
			[billId],
		);
		const ids = [...new Set(rows.map((r) => r.statement_id))];
		if (ids.length > 0) await h.requeue(ids);
	}

	// -----------------------------------------------------------------------
	// Routes: mail
	// -----------------------------------------------------------------------

	ctx.route("GET", "/mail/settings", async () => publicMail(await mailSettings()));

	ctx.route("PUT", "/mail/settings", async (req) => {
		const b = req.body ?? {};
		const str = (k, max) => {
			if (b[k] === undefined) return undefined;
			if (b[k] !== null && (typeof b[k] !== "string" || b[k].length > max)) throw bad(`${k} must be a string`);
			return (b[k] ?? "").trim();
		};
		const host = str("imap_host", 255);
		if (host && !/^[A-Za-z0-9.-]+$/.test(host)) throw bad("imap_host must be a host name, e.g. imap.gmail.com");
		const set = { imap_host: host, imap_user: str("imap_user", 255), imap_folder: str("imap_folder", 255), ap_account: str("ap_account", 32) };
		if (b.mail_source !== undefined) {
			if (!["imap", "gmail"].includes(b.mail_source)) throw bad('mail_source must be "imap" or "gmail"');
			set.mail_source = b.mail_source;
		}
		const url = str("gmail_url", 300);
		if (url && !validBridgeUrl(url)) throw bad("the Gmail web app URL looks like https://script.google.com/macros/s/.../exec");
		set.gmail_url = url;
		set.gmail_query = str("gmail_query", 500);
		if (b.imap_password !== undefined) set.imap_password = b.imap_password === null ? "" : str("imap_password", 500);
		for (const [k, lo, hi] of [["imap_port", 1, 65535], ["mail_interval", 0, 10080], ["mail_lookback_days", 1, 365]]) {
			if (b[k] === undefined) continue;
			const n = Number(b[k]);
			if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${k} must be a whole number from ${lo} to ${hi}`);
			set[k] = String(n);
		}
		if (b.mail_keywords !== undefined) {
			if (!Array.isArray(b.mail_keywords) || b.mail_keywords.some((k) => typeof k !== "string" || k.includes(","))) throw bad("mail_keywords must be a list of words");
			set.mail_keywords = b.mail_keywords.map((k) => k.trim()).filter(Boolean).join(",");
			// An empty list is stored as "" meaning "no filter", so keep the row.
			await q(`INSERT INTO ${T("settings")} (key, value) VALUES ('mail_keywords', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [set.mail_keywords]);
			delete set.mail_keywords;
		}
		if (set.ap_account) {
			const a = (await accountsByCode()).get(set.ap_account);
			if (!a || !a.is_active || a.type !== "liability") throw bad("the payable account must be an active liability account");
		}
		for (const [k, v] of Object.entries(set)) if (v !== undefined) await saveSetting(k, v);
		ctx.log.info("mail settings changed", { by: req.user.username });
		return publicMail(await mailSettings());
	});

	ctx.route("POST", "/mail/test", async () => {
		const mail = await mailSettings();
		if (!configured(mail)) return { ok: false, error: missing(mail) };
		let box;
		try {
			box = await openMailbox(mail, new Date(Date.now() - mail.mail_lookback_days * 86_400_000), 20_000);
			const matching = (await box.keys()).length;
			const account = await box.account();
			await box.close();
			return { ok: true, source: mail.mail_source, account, messages: box.exists ?? null, matching };
		} catch (err) {
			box?.abort();
			return { ok: false, error: err.message };
		}
	});

	/** The Gmail bridge's token, created on first use; a new one invalidates the deployed script until it's updated. */
	async function gmailToken({ renew = false } = {}) {
		const mail = await mailSettings();
		if (mail.gmail_token && !renew) return mail.gmail_token;
		const token = randomBytes(24).toString("base64url");
		await saveSetting("gmail_token", token);
		return token;
	}

	// POST /mail/gmail-script {renew?: true}: the Apps Script to paste into script.google.com, with the token in it.
	ctx.route("POST", "/mail/gmail-script", async (req) => {
		const token = await gmailToken({ renew: req.body?.renew === true });
		if (req.body?.renew === true) ctx.log.info("gmail bridge token renewed", { by: req.user.username });
		return { script: bridgeScript(token) };
	});

	ctx.route("POST", "/mail/check", async () => checkMail({ trigger: "manual" }));

	ctx.route("GET", "/mail/log", async () => ({
		data: (await q(`SELECT uid, outcome, bill_id, subject, seen_at FROM ${T("mail_seen")} ORDER BY seen_at DESC, uid DESC LIMIT 100`)).rows,
	}));

	// -----------------------------------------------------------------------
	// Routes: bills
	// -----------------------------------------------------------------------

	async function getBill(id) {
		if (!/^\d+$/.test(String(id))) throw new ctx.HttpError(404, "no such bill");
		const { rows } = await q(`SELECT ${BILL_COLUMNS} FROM ${T("bills")} b WHERE b.id = $1`, [id]);
		if (rows.length === 0) throw new ctx.HttpError(404, "no such bill");
		return rows[0];
	}

	async function paymentOf(id) {
		const { rows } = await q(
			`SELECT t.id, t.statement_id, t.account_code, t.tx_date::text AS date, t.description, t.amount_cents, t.status, t.journal_entry_id,
			        COALESCE(t.chosen_code, t.suggested_code) AS code, t.confidence
			   FROM ${T("transactions")} t WHERE t.bill_id = $1 ORDER BY t.id DESC`,
			[id],
		);
		return rows;
	}

	ctx.route("GET", "/bills", async (req) => {
		const status = req.query.get("status") || "";
		if (status && !["new", "open", "paid", "ignored", "unpaid"].includes(status)) throw bad("unknown status");
		const where = status === "unpaid" ? `b.status IN ('new', 'open')` : status ? `b.status = $1` : "TRUE";
		const { rows } = await q(
			`SELECT ${BILL_COLUMNS},
			        (SELECT t.id FROM ${T("transactions")} t WHERE t.bill_id = b.id ORDER BY t.id DESC LIMIT 1) AS transaction_id,
			        (SELECT t.status FROM ${T("transactions")} t WHERE t.bill_id = b.id ORDER BY t.id DESC LIMIT 1) AS transaction_status
			   FROM ${T("bills")} b WHERE ${where}
			  ORDER BY (b.status IN ('new', 'open')) DESC, COALESCE(b.due_date, b.bill_date, b.created_at::date) ASC, b.id DESC LIMIT 500`,
			status && status !== "unpaid" ? [status] : [],
		);
		return { data: rows };
	});

	ctx.route("GET", "/bills/:id", async (req) => {
		const bill = await getBill(req.params.id);
		const { rows } = await q(`SELECT body_text FROM ${T("bills")} WHERE id = $1`, [bill.id]);
		return { bill: { ...bill, body_text: rows[0].body_text }, payments: await paymentOf(bill.id) };
	});

	ctx.route("GET", "/bills/:id/document", async (req) => {
		const { rows } = await q(`SELECT document_name, document_type, document FROM ${T("bills")} WHERE id = $1`, [req.params.id]);
		if (!rows[0]?.document) throw new ctx.HttpError(404, "this bill has no document");
		return { name: rows[0].document_name, type: rows[0].document_type, data: rows[0].document.toString("base64") };
	});

	/** Validated field changes from a request body. */
	async function billFields(b, current = null) {
		const f = {};
		if (b.kind !== undefined) {
			if (!["bill", "receipt"].includes(b.kind)) throw bad('kind must be "bill" or "receipt"');
			f.kind = b.kind;
		}
		for (const [k, max] of [["vendor", 200], ["invoice_number", 100]]) {
			if (b[k] === undefined) continue;
			if (typeof b[k] !== "string" || b[k].length > max) throw bad(`${k} must be a string of at most ${max} characters`);
			f[k] = b[k].trim();
		}
		for (const k of ["bill_date", "due_date"]) {
			if (b[k] === undefined) continue;
			if (b[k] === null || b[k] === "") f[k] = null;
			else if (!(f[k] = parseDate(b[k]))) throw bad(`${k} must be a date (YYYY-MM-DD)`);
		}
		if (b.amount !== undefined) {
			if (b.amount === null || b.amount === "") f.amount_cents = null;
			else {
				const a = parseAmount(typeof b.amount === "number" ? b.amount.toFixed(2) : b.amount);
				if (a === null || a <= 0n) throw bad("amount must be a positive amount");
				f.amount_cents = a.toString();
			}
		}
		if (b.currency !== undefined) {
			if (!["CAD", "USD"].includes(b.currency)) throw bad("currency must be CAD or USD");
			f.currency = b.currency;
		}
		if (b.account_code !== undefined) {
			if (b.account_code === null || b.account_code === "") f.account_code = null;
			else {
				const a = (await accountsByCode()).get(b.account_code);
				if (!a || !a.is_active) throw bad(`no active account with code ${JSON.stringify(b.account_code)}`);
				f.account_code = a.code;
			}
		}
		if (current?.journal_entry_id && ["amount_cents", "account_code", "currency", "bill_date", "kind"].some((k) => k in f && String(f[k]) !== String(current[k]))) {
			throw new ctx.HttpError(409, "this bill is posted to payables; undo the approval before changing its amount, account, currency or date");
		}
		return f;
	}

	async function applyFields(id, f, username) {
		const keys = Object.keys(f);
		if (keys.length === 0) return;
		await q(
			`UPDATE ${T("bills")} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_by = $${keys.length + 2}, updated_at = now() WHERE id = $1`,
			[id, ...keys.map((k) => f[k]), username],
		);
	}

	ctx.route("POST", "/bills", async (req) => {
		const f = await billFields(req.body ?? {});
		if (!f.vendor) throw bad("vendor is required");
		const { rows } = await q(`INSERT INTO ${T("bills")} (source, vendor, updated_by) VALUES ('upload', $1, $2) RETURNING id`, [f.vendor, req.user.username]);
		await applyFields(rows[0].id, f, req.user.username);
		await autoMatch();
		return ctx.response(201, await getBill(rows[0].id));
	});

	// POST /bills/upload {"filename": "invoice.pdf", "content_base64": "..."}: a PDF or a saved .eml file.
	ctx.route("POST", "/bills/upload", async (req) => {
		const b = req.body ?? {};
		const filename = typeof b.filename === "string" ? b.filename.trim().slice(0, 200) : "";
		if (typeof b.content_base64 !== "string" || b.content_base64 === "") throw bad("content_base64 is required");
		const data = Buffer.from(b.content_base64, "base64");
		const cfg = await h.readSettings();
		const mail = await mailSettings();
		let email;
		if (/\.pdf$/i.test(filename) || data.subarray(0, 5).toString("latin1") === "%PDF-") {
			if (!readsPdf(cfg)) throw bad("reading PDFs needs the Claude provider; with a local model, upload the bill's email (.eml) or enter it by hand");
			email = { subject: filename, from: "", date: null, messageId: null, text: "", attachments: [{ filename: filename || "bill.pdf", contentType: "application/pdf", data }] };
		} else email = parseEmail(data);
		const r = await ingest(email, { source: "upload", cfg, mail });
		if (r.outcome === "duplicate") throw new ctx.HttpError(409, `this looks like bill #${r.bill_id}, which is already here`);
		await autoMatch();
		return ctx.response(201, await getBill(r.bill_id));
	});

	ctx.route("PATCH", "/bills/:id", async (req) => {
		const bill = await getBill(req.params.id);
		const b = req.body ?? {};
		const f = await billFields(b, bill);
		if (b.status !== undefined) {
			if (!["new", "open", "ignored", "paid"].includes(b.status)) throw bad("status must be new, open, ignored or paid");
			if (bill.journal_entry_id && b.status === "ignored") throw new ctx.HttpError(409, "undo the approval before ignoring this bill");
			f.status = b.status;
			if (b.status === "paid" && bill.status !== "paid") f.paid_at = new Date();
		}
		await applyFields(bill.id, f, req.user.username);
		if (f.status === "ignored" || f.amount_cents !== undefined || f.account_code !== undefined) await unlink(bill.id);
		await autoMatch();
		return getBill(bill.id);
	});

	ctx.route("DELETE", "/bills/:id", async (req) => {
		const bill = await getBill(req.params.id);
		if (bill.journal_entry_id) throw new ctx.HttpError(409, "undo the approval before deleting this bill");
		if ((await paymentOf(bill.id)).some((t) => t.status === "posted")) throw new ctx.HttpError(409, "a posted payment refers to this bill; ignore it instead");
		await unlink(bill.id);
		await q(`DELETE FROM ${T("bills")} WHERE id = $1`, [bill.id]);
		await dash.remove(`bill-${bill.id}`);
	});

	// Approve: the details are right. With a payable account set, also post the bill to payables.
	ctx.route("POST", "/bills/:id/approve", async (req) => {
		const bill = await getBill(req.params.id);
		if (!["new", "open"].includes(bill.status)) throw new ctx.HttpError(409, `this bill is ${bill.status}`);
		if (bill.amount_cents === null) throw bad("enter the amount first");
		if (!bill.account_code) throw bad("choose the account first");
		const mail = await mailSettings();
		const accounts = await accountsByCode();
		const account = accounts.get(bill.account_code);
		if (account?.currency !== bill.currency) throw bad(`account ${bill.account_code} is in ${account?.currency}, the bill in ${bill.currency}`);
		if (bill.kind === "bill" && mail.ap_account && !bill.journal_entry_id) {
			const ap = accounts.get(mail.ap_account);
			if (!ap || ap.currency !== bill.currency) throw bad(`the payable account ${mail.ap_account} is not in ${bill.currency}; bills in ${bill.currency} can't be posted to it`);
			const date = bill.bill_date ?? bill.due_date ?? new Date().toISOString().slice(0, 10);
			const entry = await ctx.ledger.createJournalEntry(
				{
					entry_date: date,
					description: `${bill.vendor || "Bill"}${bill.invoice_number ? ` invoice ${bill.invoice_number}` : " bill"}`.slice(0, 500),
					reference: (bill.invoice_number ? `bill ${bill.invoice_number}` : `bill ${bill.id}`).slice(0, 100),
					lines: [
						{ account_code: bill.account_code, debit_cents: bill.amount_cents, credit_cents: 0n, memo: bill.due_date ? `due ${bill.due_date}` : "" },
						{ account_code: ap.code, debit_cents: 0n, credit_cents: bill.amount_cents, memo: "" },
					],
				},
				req.user,
			);
			await q(`UPDATE ${T("bills")} SET journal_entry_id = $2, ap_account = $3 WHERE id = $1`, [bill.id, entry.id, ap.code]);
		}
		await applyFields(bill.id, { status: bill.status === "new" ? "open" : bill.status, error: null }, req.user.username);
		await autoMatch();
		return getBill(bill.id);
	});

	ctx.route("POST", "/bills/:id/unapprove", async (req) => {
		const bill = await getBill(req.params.id);
		if (bill.status === "paid") throw new ctx.HttpError(409, "this bill is paid; reverse the payment entry in the journal first");
		if (bill.journal_entry_id) {
			await ctx.ledger.reverseJournalEntry(bill.journal_entry_id, { description: `Undo ${bill.vendor || "bill"} bill approval`.slice(0, 500) }, req.user);
			await q(`UPDATE ${T("bills")} SET journal_entry_id = NULL, ap_account = NULL WHERE id = $1`, [bill.id]);
		}
		await applyFields(bill.id, { status: "new" }, req.user.username);
		await unlink(bill.id);
		await autoMatch();
		return getBill(bill.id);
	});

	// Unposted outgoing statement transactions with this bill's amount (for manual matching).
	ctx.route("GET", "/bills/:id/candidates", async (req) => {
		const bill = await getBill(req.params.id);
		if (bill.amount_cents === null) return { data: [] };
		const { rows } = await q(
			`SELECT t.id, t.statement_id, t.account_code, t.tx_date::text AS date, t.description, t.amount_cents, t.bill_id
			   FROM ${T("transactions")} t WHERE t.status = 'new' AND t.amount_cents = $1 ORDER BY t.tx_date DESC LIMIT 50`,
			[(-BigInt(bill.amount_cents)).toString()],
		);
		return { data: rows };
	});

	ctx.route("POST", "/bills/:id/match", async (req) => {
		const bill = await getBill(req.params.id);
		const txId = String(req.body?.transaction_id ?? "");
		if (!/^\d+$/.test(txId)) throw bad("transaction_id is required");
		const target = targetOf(bill);
		if (!target) throw bad("choose the bill's account first");
		await unlink(bill.id);
		const { rowCount } = await q(
			`UPDATE ${T("transactions")} SET bill_id = $2, chosen_code = $3, source = 'bill', reason = $4, error = NULL WHERE id = $1 AND status = 'new'`,
			[txId, bill.id, target, `pays ${bill.vendor || "bill"} (matched by hand)`.slice(0, 200)],
		);
		if (rowCount === 0) throw bad("that transaction is not waiting to be posted");
		await syncBillTodos();
		return { bill: await getBill(bill.id), payments: await paymentOf(bill.id) };
	});

	ctx.route("POST", "/bills/:id/unmatch", async (req) => {
		const bill = await getBill(req.params.id);
		await q(`UPDATE ${T("transactions")} SET chosen_code = NULL WHERE bill_id = $1 AND status = 'new' AND chosen_code = $2`, [bill.id, targetOf(bill)]);
		await q(`UPDATE ${T("transactions")} SET rejected_bill_id = bill_id WHERE bill_id = $1 AND status = 'new'`, [bill.id]);
		await unlink(bill.id);
		await syncBillTodos();
		return { bill: await getBill(bill.id), payments: await paymentOf(bill.id) };
	});

	return { autoMatch, targetOf, onPosted, checkMail };
}
