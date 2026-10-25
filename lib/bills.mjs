// Bills: reading them out of emails with the LLM, spotting duplicates
// (reminders for the same bill), and matching them to statement transactions.

import { completeJson, readsPdf } from "./llm.mjs";
import { parseAmount, parseDate } from "./parse.mjs";

const MAX_BODY_CHARS = 15_000;

export const DEFAULT_KEYWORDS = [
	"invoice", "bill", "statement", "amount due", "balance due", "payment due", "due date", "receipt", "pre-authorized", "autopay", "facture",
];

/** Whether an email is worth sending to the model. An empty keyword list lets everything through. */
export function looksLikeBill(email, keywords) {
	if (keywords.length === 0) return true;
	const hay = `${email.subject}\n${email.from}\n${email.text.slice(0, 20_000)}\n${email.attachments.map((a) => a.filename).join(" ")}`.toLowerCase();
	return keywords.some((k) => hay.includes(k.toLowerCase()));
}

export function extractionSchema(codes) {
	return {
		type: "object",
		properties: {
			kind: { type: "string", enum: ["bill", "receipt", "not_bill"] },
			vendor: { type: "string" },
			invoice_number: { type: "string" },
			bill_date: { type: "string", description: "YYYY-MM-DD or empty" },
			due_date: { type: "string", description: "YYYY-MM-DD or empty" },
			amount_due: { type: "string", description: "decimal, e.g. 123.45, or empty" },
			currency: { type: "string", enum: ["CAD", "USD", "other", ""] },
			account_code: { type: "string", enum: [...codes, ""] },
			confidence: { type: "number", description: "0 to 1" },
			summary: { type: "string", description: "one short line" },
		},
		required: ["kind", "vendor", "invoice_number", "bill_date", "due_date", "amount_due", "currency", "account_code", "confidence", "summary"],
		additionalProperties: false,
	};
}

const SYSTEM = `You read emails for a bookkeeper and pick out bills.

kind:
- "bill": the sender asks to be paid, or states an amount that will be charged or withdrawn (invoices, utility and phone bills, credit-card or loan statements with an amount due, upcoming pre-authorized debits).
- "receipt": confirms a payment already made (order confirmations, payment receipts).
- "not_bill": anything else (newsletters, marketing, shipping notices without an amount, account alerts, "your bill is ready" without the amount).

For bills and receipts:
- vendor: the business's short name as it would appear on a bank statement, e.g. "Rogers", "Toronto Hydro", "Amazon".
- amount_due: the total to pay (for statements, the statement balance or the amount that will be withdrawn, not the minimum payment unless it is the only amount). For receipts, the total paid.
- bill_date: the invoice or statement date; due_date: when payment is due or will be withdrawn. Use YYYY-MM-DD. Leave empty when not stated.
- account_code: the account from the list this cost should be booked to, following the user's past bills where the vendor matches. Empty if none fits.
- currency: from the document; "other" for currencies not listed.
- confidence: your probability that the vendor, amount and dates are all correct.
Use only what the email and attached documents say. Never guess an amount.`;

/**
 * Reads one email. Returns { kind, vendor, invoice_number, bill_date, due_date, amount_cents, currency, account_code, confidence, summary }.
 * pdfs: [{ filename, data: Buffer }]; accounts: [{ code, name, type }]; examples: [{ vendor, account_code }]
 */
export async function extractBill({ cfg, email, pdfs = [], accounts, examples = [], fetchImpl }) {
	const codes = accounts.map((a) => a.code);
	let body = email.text;
	const truncated = body.length > MAX_BODY_CHARS;
	if (truncated) body = body.slice(0, MAX_BODY_CHARS);
	const usePdfs = readsPdf(cfg) ? pdfs : [];
	const prompt = [
		"Accounts (code | name | type):",
		...accounts.map((a) => `${a.code} | ${a.name} | ${a.type}`),
		"",
		examples.length > 0 ? "The user's past bills (vendor -> account):" : "",
		...examples.slice(0, 40).map((e) => `${JSON.stringify(e.vendor)} -> ${e.account_code}`),
		"",
		`From: ${email.from}`,
		`Subject: ${email.subject}`,
		`Date: ${email.date ? email.date.toISOString().slice(0, 10) : "unknown"}`,
		pdfs.length > 0
			? usePdfs.length > 0
				? `Attached documents: ${usePdfs.map((p) => p.filename || "document.pdf").join(", ")} (included above).`
				: `Attached PDFs that you cannot see: ${pdfs.map((p) => p.filename || "document.pdf").join(", ")}. If the amount is only in them, use kind "bill" with an empty amount.`
			: "",
		"",
		"Email body:",
		body || "(empty)",
		truncated ? "[body truncated]" : "",
	]
		.filter((l, i, a) => l !== "" || a[i - 1] !== "")
		.join("\n");
	const { data } = await completeJson(
		cfg,
		{
			system: SYSTEM,
			prompt,
			schema: extractionSchema(codes),
			maxTokens: 4000,
			documents: usePdfs.map((p) => ({ media_type: "application/pdf", data: p.data.toString("base64"), name: p.filename })),
		},
		fetchImpl,
	);
	const kind = ["bill", "receipt"].includes(data?.kind) ? data.kind : "not_bill";
	const amount = parseAmount(data?.amount_due ?? "");
	const c = Number(data?.confidence);
	return {
		kind,
		vendor: String(data?.vendor ?? "").trim().slice(0, 200),
		invoice_number: String(data?.invoice_number ?? "").trim().slice(0, 100),
		bill_date: parseDate(data?.bill_date ?? "") ?? null,
		due_date: parseDate(data?.due_date ?? "") ?? null,
		amount_cents: amount !== null && amount > 0n ? amount : null,
		currency: ["CAD", "USD"].includes(data?.currency) ? data.currency : data?.currency === "other" ? "other" : "",
		account_code: codes.includes(data?.account_code) ? data.account_code : null,
		confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5,
		summary: String(data?.summary ?? "").slice(0, 300),
	};
}

// ---------------------------------------------------------------------------
// Vendors, duplicates, matching
// ---------------------------------------------------------------------------

const VENDOR_NOISE = new Set(["INC", "LTD", "LLC", "CORP", "CO", "THE", "AND", "COM", "WWW", "CANADA", "LIMITED", "SERVICES", "BILLING", "PAYMENT", "PAYMENTS"]);

/** Distinctive words of a vendor name or bank description. */
export function nameTokens(s) {
	return new Set(
		String(s ?? "")
			.toUpperCase()
			.replace(/[^A-Z0-9 ]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length >= 3 && !/\d/.test(w) && !VENDOR_NOISE.has(w)),
	);
}

const shareToken = (a, b) => {
	const tb = nameTokens(b);
	for (const t of nameTokens(a)) if (tb.has(t)) return true;
	// "TORONTOHYDRO" vs "Toronto Hydro"
	const ca = String(a ?? "").toUpperCase().replace(/[^A-Z]/g, "");
	const cb = String(b ?? "").toUpperCase().replace(/[^A-Z]/g, "");
	return ca.length >= 5 && cb.length >= 5 && (ca.includes(cb) || cb.includes(ca));
};

/** The existing bill this one repeats (a reminder, or the same bill sent twice), if any. */
export function findDuplicate(bill, existing) {
	return (
		existing.find((e) => {
			if (!shareToken(bill.vendor, e.vendor)) return false;
			if (bill.invoice_number && e.invoice_number) return bill.invoice_number === e.invoice_number;
			if (bill.amount_cents === null || e.amount_cents === null || BigInt(bill.amount_cents) !== BigInt(e.amount_cents)) return false;
			return (bill.due_date && bill.due_date === e.due_date) || (bill.bill_date && bill.bill_date === e.bill_date);
		}) ?? null
	);
}

const DAY = 86_400_000;
const days = (iso) => Date.parse(iso + "T00:00:00Z") / DAY;

/**
 * How well a statement transaction fits as the payment of a bill: 0 (no) to 0.95.
 * Needs the exact amount going out, within a window around the bill's dates.
 */
export function matchScore(bill, tx) {
	if (bill.amount_cents === null || bill.amount_cents === undefined) return 0;
	if (BigInt(tx.amount_cents) !== -BigInt(bill.amount_cents)) return 0;
	const anchor = bill.bill_date ?? bill.due_date ?? bill.mail_date ?? null;
	if (!anchor) return 0;
	const t = days(tx.date);
	const receipt = bill.kind === "receipt";
	const lo = days(bill.bill_date ?? bill.due_date ?? anchor) - (receipt ? 3 : 7);
	const hi = days(bill.due_date ?? bill.bill_date ?? anchor) + (receipt ? 10 : 45);
	if (t < lo || t > hi) return 0;
	let score = 0.6;
	if (shareToken(bill.vendor, tx.description)) score += 0.25;
	if (bill.due_date && Math.abs(t - days(bill.due_date)) <= 5) score += 0.1;
	return Math.min(score, 0.95);
}

/** One-to-one matching, best scores first. Returns [{ bill, tx, score }]. allow(bill, tx) can veto a pair. */
export function assignMatches(bills, txs, allow = () => true) {
	const pairs = [];
	for (const b of bills) for (const t of txs) {
		if (!allow(b, t)) continue;
		const s = matchScore(b, t);
		if (s > 0) pairs.push({ bill: b, tx: t, score: s });
	}
	pairs.sort((a, b) => b.score - a.score);
	const usedB = new Set();
	const usedT = new Set();
	const out = [];
	for (const p of pairs) {
		if (usedB.has(p.bill.id) || usedT.has(p.tx.id)) continue;
		usedB.add(p.bill.id);
		usedT.add(p.tx.id);
		out.push(p);
	}
	return out;
}
