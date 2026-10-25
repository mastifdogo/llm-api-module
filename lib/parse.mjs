// Statement parsing: CSV exports (columns detected from the header, or from
// the data when there is none) and OFX/QFX/QBO files (SGML or XML).
//
// Every parser returns { format, transactions, warnings } where a transaction
// is { line, date: "YYYY-MM-DD", description, memo, amount_cents: bigint, fitid }.
// amount_cents is signed from the statement account's side: positive when
// money comes in, negative when it goes out (flip it for card exports that
// show purchases as positive).

export class ParseError extends Error {}

const MAX_TRANSACTIONS = 5000;

/** Picks the parser from the file name and content. */
export function parseStatement(text, { filename = "", dateOrder = "auto" } = {}) {
	text = text.replace(/^﻿/, "");
	const looksOfx = /\.(ofx|qfx|qbo)$/i.test(filename) || /<OFX>|OFXHEADER:/i.test(text.slice(0, 4000));
	return looksOfx ? parseOfx(text) : parseCsv(text, { dateOrder });
}

// ---------------------------------------------------------------------------
// Amounts and dates
// ---------------------------------------------------------------------------

/** "1,234.56", "$-12.30", "(12.30)", "12.30-", "12.30 CR", "1.234,56" -> bigint cents, or null. */
export function parseAmount(raw) {
	let s = String(raw ?? "").trim();
	if (s === "") return null;
	let neg = false;
	const crdr = /\s*\b(CR|DR)\.?$/i.exec(s);
	if (crdr) {
		neg = crdr[1].toUpperCase() === "DR";
		s = s.slice(0, crdr.index).trim();
	}
	if (/^\(.*\)$/.test(s)) {
		neg = !neg;
		s = s.slice(1, -1).trim();
	}
	if (s.endsWith("-")) {
		neg = !neg;
		s = s.slice(0, -1).trim();
	}
	if (s.startsWith("-")) {
		neg = !neg;
		s = s.slice(1).trim();
	} else if (s.startsWith("+")) s = s.slice(1).trim();
	s = s.replace(/^(?:[A-Z]{3}\s*)?[$€£]?\s*/i, "").replace(/\s*[$€£]?(?:\s*[A-Z]{3})?$/i, "");
	if (s.startsWith("-")) {
		neg = !neg;
		s = s.slice(1);
	}
	s = s.replace(/[\s']/g, "");
	// European style 1.234,56 or 12,30
	if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
	else s = s.replace(/,/g, "");
	const m = /^(\d+)(?:\.(\d{0,2})\d*)?$/.exec(s);
	if (!m) return null;
	// Round half away from zero on a third decimal.
	const third = /^\d+\.\d{2}(\d)/.exec(s);
	let cents = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
	if (third && Number(third[1]) >= 5) cents += 1n;
	return neg ? -cents : cents;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function ymd(y, m, d) {
	y = Number(y);
	m = Number(m);
	d = Number(d);
	if (y < 100) y += 2000;
	if (!(y >= 1900 && y <= 9999 && m >= 1 && m <= 12 && d >= 1)) return null;
	const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
	if (d > days) return null;
	return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Parses one date. order is "mdy" or "dmy" for numeric dates like 03/04/2026.
 * Returns "YYYY-MM-DD" or null.
 */
export function parseDate(raw, order = "mdy") {
	const s = String(raw ?? "").trim();
	let m;
	if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s))) return ymd(m[1], m[2], m[3]);
	if ((m = /^(\d{4})(\d{2})(\d{2})(?:\d{0,6}(?:\.\d+)?)?(?:\[.*\])?$/.exec(s))) return ymd(m[1], m[2], m[3]);
	if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/.exec(s))) {
		return order === "dmy" ? ymd(m[3], m[2], m[1]) : ymd(m[3], m[1], m[2]);
	}
	// 05 Mar 2026, 5-Mar-26
	if ((m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?,?[\s-](\d{2}|\d{4})$/.exec(s))) {
		const mon = MONTHS[m[2].toLowerCase().slice(0, m[2].length === 4 ? 4 : 3)];
		return mon ? ymd(m[3], mon, m[1]) : null;
	}
	// Mar 5, 2026
	if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
		const mon = MONTHS[m[1].toLowerCase().slice(0, m[1].length === 4 ? 4 : 3)];
		return mon ? ymd(m[3], mon, m[2]) : null;
	}
	return null;
}

/** Decides mdy vs dmy from all numeric dates in a column. */
function detectDateOrder(values) {
	let mdy = true;
	let dmy = true;
	for (const v of values) {
		const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})/.exec(String(v).trim());
		if (!m) continue;
		if (Number(m[1]) > 12) mdy = false;
		if (Number(m[2]) > 12) dmy = false;
	}
	return !mdy && dmy ? "dmy" : "mdy";
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 records: [{ fields, line }]. */
export function readCsvRecords(text, delimiter) {
	const out = [];
	let fields = [];
	let field = "";
	let quoted = false;
	let line = 1;
	let start = 1;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else {
				if (c === "\n") line++;
				field += c;
			}
		} else if (c === '"' && field.trim() === "") {
			quoted = true;
			field = "";
		} else if (c === delimiter) {
			fields.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			fields.push(field);
			out.push({ fields, line: start });
			fields = [];
			field = "";
			line++;
			start = line;
		} else field += c;
	}
	if (field !== "" || fields.length > 0) {
		fields.push(field);
		out.push({ fields, line: start });
	}
	return out.filter((r) => r.fields.some((f) => f.trim() !== ""));
}

function detectDelimiter(text) {
	const sample = text.split(/\r?\n/).slice(0, 20).join("\n");
	let best = ",";
	let bestCount = 0;
	for (const d of [",", ";", "\t", "|"]) {
		const n = sample.split(d).length;
		if (n > bestCount) {
			best = d;
			bestCount = n;
		}
	}
	return best;
}

const HEADER_PATTERNS = {
	date: /^(transaction |trans\.? |posting |posted |post |value |booking )?date( posted)?$|^date de (transaction|l'opération)$/,
	description: /^(description|payee|name|merchant|merchant name|details|transaction details|narrative|transaction description|description 1|libellé)$/,
	memo: /^(memo|notes?|description 2|reference|additional (details|info)|category)$/,
	amount: /^(amount|transaction amount|amount \([a-z]{3}\)|[a-z]{3}\$|value|montant)$/,
	debit: /^(debit|debits|debit amount|withdrawal|withdrawals|withdrawal amount|money out|paid out|outflow|charges?)$/,
	credit: /^(credit|credits|credit amount|deposit|deposits|deposit amount|money in|paid in|inflow|payments?)$/,
	fitid: /^(transaction id|id|fitid|reference number|ref)$/,
};

function findHeader(records) {
	for (let r = 0; r < Math.min(records.length, 15); r++) {
		const names = records[r].fields.map((f) => f.trim().toLowerCase().replace(/\s+/g, " "));
		const col = {};
		names.forEach((n, i) => {
			for (const [k, re] of Object.entries(HEADER_PATTERNS)) if (col[k] === undefined && re.test(n)) col[k] = i;
		});
		if (col.date !== undefined && col.description !== undefined && (col.amount !== undefined || col.debit !== undefined || col.credit !== undefined)) {
			return { row: r, col };
		}
	}
	return null;
}

/** Headerless exports (e.g. date, description, withdrawal, deposit, balance): infer from the data. */
function inferColumns(records, order) {
	const rows = records.slice(0, 50).map((r) => r.fields);
	const width = Math.max(...rows.map((r) => r.length));
	const share = (test) => [...Array(width).keys()].map((i) => rows.filter((r) => test(r[i] ?? "")).length / rows.length);
	const isDate = share((v) => parseDate(v, order) !== null);
	const isNum = share((v) => v.trim() !== "" && parseAmount(v) !== null);
	const isNumOrEmpty = share((v) => v.trim() === "" || parseAmount(v) !== null);
	const date = isDate.findIndex((s) => s >= 0.8);
	if (date < 0) return null;
	const textLen = [...Array(width).keys()].map((i) => (i === date || isNumOrEmpty[i] >= 0.9 ? -1 : rows.reduce((n, r) => n + (r[i] ?? "").length, 0)));
	const description = textLen.indexOf(Math.max(...textLen));
	if (description < 0 || textLen[description] <= 0) return null;
	const nums = [...Array(width).keys()].filter((i) => i !== date && isNumOrEmpty[i] >= 0.9 && isNum[i] > 0);
	if (nums.length === 0) return null;
	const [a, b] = nums;
	if (b !== undefined) {
		const exclusive = rows.every((r) => !((r[a] ?? "").trim() !== "" && (r[b] ?? "").trim() !== ""));
		if (exclusive) return { date, description, debit: a, credit: b };
	}
	return { date, description, amount: a };
}

export function parseCsv(text, { dateOrder = "auto" } = {}) {
	const delimiter = detectDelimiter(text);
	const records = readCsvRecords(text, delimiter);
	if (records.length === 0) throw new ParseError("the file is empty");
	const warnings = [];

	const header = findHeader(records);
	let col;
	let data;
	if (header) {
		col = header.col;
		data = records.slice(header.row + 1);
	} else {
		col = inferColumns(records, dateOrder === "dmy" ? "dmy" : "mdy");
		if (!col) {
			throw new ParseError("could not find date, description and amount columns; the header needs columns like Date, Description, and Amount (or Debit/Credit)");
		}
		data = records;
		warnings.push("no header row recognised; columns were guessed from the data");
	}
	const order = dateOrder === "auto" ? detectDateOrder(data.map((r) => r.fields[col.date] ?? "")) : dateOrder;

	const transactions = [];
	for (const { fields, line } of data) {
		const get = (i) => (i === undefined ? "" : (fields[i] ?? "").trim());
		const rawDate = get(col.date);
		const date = parseDate(rawDate, order);
		if (!date) {
			// Footer lines ("Total", "Ending balance") and repeated headers are skipped quietly.
			if (rawDate !== "" && /\d/.test(rawDate)) warnings.push(`line ${line}: unrecognised date ${JSON.stringify(rawDate)}, skipped`);
			continue;
		}
		let amount = null;
		if (col.amount !== undefined) amount = parseAmount(get(col.amount));
		else {
			const debit = parseAmount(get(col.debit));
			const credit = parseAmount(get(col.credit));
			if (debit !== null || credit !== null) {
				// Debit columns hold money out; some banks already sign them negative.
				amount = (credit ?? 0n) - (debit === null ? 0n : debit < 0n ? -debit : debit);
			}
		}
		if (amount === null || amount === 0n) {
			if (amount === null) warnings.push(`line ${line}: no amount, skipped`);
			continue;
		}
		const description = get(col.description) || get(col.memo) || "(no description)";
		transactions.push({ line, date, description, memo: col.memo !== undefined && col.memo !== col.description ? get(col.memo) : "", amount_cents: amount, fitid: get(col.fitid) });
		if (transactions.length > MAX_TRANSACTIONS) throw new ParseError(`more than ${MAX_TRANSACTIONS} transactions in one file`);
	}
	if (transactions.length === 0) throw new ParseError("no transactions found in the file");
	return { format: "csv", transactions, warnings };
}

// ---------------------------------------------------------------------------
// OFX / QFX / QBO
// ---------------------------------------------------------------------------

function decodeEntities(s) {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&amp;/g, "&");
}

function ofxTag(block, tag) {
	// SGML leaves elements unclosed: the value runs to the next tag or line end.
	const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
	return m ? decodeEntities(m[1].trim()) : "";
}

export function parseOfx(text) {
	const blocks = text.split(/<STMTTRN>/i).slice(1);
	if (blocks.length === 0) throw new ParseError("no <STMTTRN> transactions found in the OFX file");
	const warnings = [];
	const transactions = [];
	blocks.forEach((raw, i) => {
		const block = raw.split(/<\/STMTTRN>/i)[0];
		const line = i + 1;
		const date = parseDate(ofxTag(block, "DTPOSTED") || ofxTag(block, "DTUSER"));
		const amount = parseAmount(ofxTag(block, "TRNAMT"));
		if (!date || amount === null) {
			warnings.push(`transaction ${line}: missing date or amount, skipped`);
			return;
		}
		if (amount === 0n) return;
		const name = ofxTag(block, "NAME") || ofxTag(block, "PAYEE");
		const memo = ofxTag(block, "MEMO");
		transactions.push({ line, date, description: name || memo || "(no description)", memo: name ? memo : "", amount_cents: amount, fitid: ofxTag(block, "FITID") });
	});
	if (transactions.length > MAX_TRANSACTIONS) throw new ParseError(`more than ${MAX_TRANSACTIONS} transactions in one file`);
	if (transactions.length === 0) throw new ParseError("no usable transactions in the OFX file");
	return { format: "ofx", transactions, warnings };
}

// ---------------------------------------------------------------------------
// Payee keys (for learned rules)
// ---------------------------------------------------------------------------

const NOISE = new Set([
	"POS", "PURCHASE", "DEBIT", "CREDIT", "CARD", "VISA", "MASTERCARD", "MC", "INTERAC", "IDP", "E-TRANSFER", "ETRANSFER",
	"PREAUTHORIZED", "PRE-AUTHORIZED", "PAP", "ACH", "ONLINE", "PAYMENT", "RECURRING", "CHECKCARD", "SQ", "TST", "PP", "PAYPAL",
	"WWW", "COM", "INC", "LTD", "LLC", "CO", "THE",
]);

/** A stable key for "the same payee": upper case, without card noise, numbers and store ids. */
export function payeeKey(description) {
	const words = String(description)
		.toUpperCase()
		.replace(/[*#]/g, " ")
		.replace(/[^A-Z0-9&' -]/g, " ")
		.split(/\s+/)
		.filter((w) => w !== "" && !/\d/.test(w) && !NOISE.has(w) && w.length > 1);
	return words.slice(0, 3).join(" ");
}
