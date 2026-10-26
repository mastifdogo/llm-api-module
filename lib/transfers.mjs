// Transfers between your own accounts (chequing -> savings, bank -> credit
// card payment). Uploading both statements gives two rows for one transfer;
// pairing them lets it be posted once.

import { nameTokens } from "./bills.mjs";

/** Words banks use for transfers and card payments. */
const TRANSFER_WORDS = /\b(TRANSFER|TRANSFERT|TFR|XFER|TRSF|E-?TRANSFER|PAYMENT|PYMT|PMT|PAIEMENT|ONLINE BANKING|INTERNET BANKING|MOBILE BANKING|VIREMENT)\b/i;

export const MAX_DAYS = 4;
const DAY = 86_400_000;
export const dayDiff = (a, b) => Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / DAY;

/** The account a row is booked to: your choice, else the suggestion. */
export const effectiveCode = (t) => t.chosen_code ?? t.suggested_code ?? null;

const mentions = (description, account) => {
	if (!account) return false;
	const words = nameTokens(description);
	for (const w of nameTokens(account.name)) if (words.has(w)) return true;
	return false;
};

/**
 * How likely rows a and b are the two sides of one transfer: 0 (no) to 0.95.
 * Needs opposite amounts in two different accounts of the same currency,
 * at most MAX_DAYS apart, plus a sign it's a transfer: one side is booked to
 * the other's account, a description says transfer/payment, or names the other account.
 * accounts: Map(code -> { name, currency })
 */
export function transferScore(a, b, accounts) {
	if (a.account_code === b.account_code) return 0;
	if (BigInt(a.amount_cents) !== -BigInt(b.amount_cents)) return 0;
	const accA = accounts.get(a.account_code);
	const accB = accounts.get(b.account_code);
	if (!accA || !accB || accA.currency !== accB.currency) return 0;
	const days = dayDiff(a.date, b.date);
	if (days > MAX_DAYS) return 0;
	// A row you booked elsewhere yourself isn't a transfer to the other account.
	if (a.chosen_code && a.chosen_code !== b.account_code) return 0;
	if (b.chosen_code && b.chosen_code !== a.account_code) return 0;
	const booked = effectiveCode(a) === b.account_code || effectiveCode(b) === a.account_code;
	const worded = TRANSFER_WORDS.test(a.description) || TRANSFER_WORDS.test(b.description);
	const named = mentions(a.description, accB) || mentions(b.description, accA);
	if (!booked && !worded && !named) return 0;
	let score = 0.6;
	if (booked) score += 0.2;
	if (worded || named) score += 0.1;
	if (days <= 1) score += 0.05;
	return Math.min(score, 0.95);
}

/** One-to-one pairing, best first. rows: staged rows; returns [{ a, b, score }] with a the money-out side. */
export function pairTransfers(rows, accounts) {
	const out = rows.filter((t) => BigInt(t.amount_cents) < 0n);
	const ins = rows.filter((t) => BigInt(t.amount_cents) > 0n);
	const pairs = [];
	for (const a of out) for (const b of ins) {
		if (String(a.rejected_transfer_tx) === String(b.id) || String(b.rejected_transfer_tx) === String(a.id)) continue;
		const score = transferScore(a, b, accounts);
		if (score > 0) pairs.push({ a, b, score, days: dayDiff(a.date, b.date) });
	}
	pairs.sort((x, y) => y.score - x.score || x.days - y.days);
	const used = new Set();
	const result = [];
	for (const p of pairs) {
		if (used.has(String(p.a.id)) || used.has(String(p.b.id))) continue;
		used.add(String(p.a.id));
		used.add(String(p.b.id));
		result.push({ a: p.a, b: p.b, score: p.score });
	}
	return result;
}

/**
 * Whether a journal entry already records row t as a transfer between t's account and `other`:
 * a line on t's account with t's amount (debit for money in, credit for money out) and the
 * opposite line on `other`.
 */
export function entryRecords(entry, t, other) {
	if (entry.reversed_by_id || entry.reverses_id) return false;
	const amt = BigInt(t.amount_cents);
	const abs = amt < 0n ? -amt : amt;
	const mine = entry.lines.some((l) => l.account_code === t.account_code && BigInt(amt > 0n ? l.debit_cents : l.credit_cents) === abs);
	const theirs = entry.lines.some((l) => l.account_code === other && BigInt(amt > 0n ? l.credit_cents : l.debit_cents) === abs);
	return mine && theirs && dayDiff(entry.entry_date, t.date) <= MAX_DAYS;
}
