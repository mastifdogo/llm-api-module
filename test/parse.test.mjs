import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAmount, parseDate, parseStatement, payeeKey } from "../lib/parse.mjs";

test("parseAmount handles bank formats", () => {
	const cases = {
		"12.30": 1230n, "-12.30": -1230n, "$1,234.56": 123456n, "-$45.10": -4510n, "$-45.10": -4510n, "(12.30)": -1230n,
		"12.30-": -1230n, "12.30 CR": 1230n, "12.30 DR": -1230n, "1.234,56": 123456n, "12,3": 1230n, "CAD 5": 500n,
		"0.005": 1n, "7": 700n, "+3.5": 350n, "": null, "abc": null,
	};
	for (const [raw, want] of Object.entries(cases)) assert.equal(parseAmount(raw), want, raw);
});

test("parseDate handles common layouts", () => {
	assert.equal(parseDate("2026-03-05"), "2026-03-05");
	assert.equal(parseDate("2026/3/5"), "2026-03-05");
	assert.equal(parseDate("20260305120000.000[-5:EST]"), "2026-03-05");
	assert.equal(parseDate("03/05/2026"), "2026-03-05");
	assert.equal(parseDate("03/05/2026", "dmy"), "2026-05-03");
	assert.equal(parseDate("5 Mar 2026"), "2026-03-05");
	assert.equal(parseDate("05-Mar-26"), "2026-03-05");
	assert.equal(parseDate("Mar 5, 2026"), "2026-03-05");
	assert.equal(parseDate("Sept 5, 2026"), "2026-09-05");
	assert.equal(parseDate("02/30/2026"), null);
	assert.equal(parseDate("Total"), null);
});

test("CSV with a single amount column", () => {
	const csv = '﻿Date,Description,Amount,Balance\n2026-03-01,"SHELL #1234, TORONTO",-45.10,100\n2026-03-02,PAYROLL ACME,"2,000.00",2100\n,Total,,\n';
	const r = parseStatement(csv, { filename: "x.csv" });
	assert.equal(r.format, "csv");
	assert.deepEqual(
		r.transactions.map((t) => [t.date, t.description, t.amount_cents]),
		[["2026-03-01", "SHELL #1234, TORONTO", -4510n], ["2026-03-02", "PAYROLL ACME", 200000n]],
	);
});

test("CSV with debit/credit columns, preamble lines and day-first dates", () => {
	const csv = "Account: 1234\nExported 2026\n\nTransaction Date;Details;Money Out;Money In\n13/03/2026;TESCO;12,50;\n14/03/2026;REFUND;;3,00\n";
	const r = parseStatement(csv);
	assert.deepEqual(r.transactions.map((t) => [t.date, t.description, t.amount_cents]), [["2026-03-13", "TESCO", -1250n], ["2026-03-14", "REFUND", 300n]]);
});

test("headerless CSV: date, description, withdrawal, deposit, balance", () => {
	const csv = "03/01/2026,TIM HORTONS #22,4.25,,995.75\n03/02/2026,E-TRANSFER FROM BOB,,50.00,1045.75\n03/03/2026,HYDRO ONE,120.00,,925.75\n";
	const r = parseStatement(csv);
	assert.deepEqual(r.transactions.map((t) => [t.date, t.description, t.amount_cents]), [
		["2026-03-01", "TIM HORTONS #22", -425n],
		["2026-03-02", "E-TRANSFER FROM BOB", 5000n],
		["2026-03-03", "HYDRO ONE", -12000n],
	]);
	assert.match(r.warnings[0], /no header/);
});

test("OFX (SGML) statement", () => {
	const ofx = `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260301120000[-5:EST]<TRNAMT>-16.99<FITID>A1<NAME>NETFLIX.COM<MEMO>Subscription &amp; more
</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260302<TRNAMT>1500.00<FITID>A2<NAME>PAYROLL</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
	const r = parseStatement(ofx, { filename: "march.qfx" });
	assert.equal(r.format, "ofx");
	assert.deepEqual(r.transactions.map((t) => [t.date, t.description, t.memo, t.amount_cents, t.fitid]), [
		["2026-03-01", "NETFLIX.COM", "Subscription & more", -1699n, "A1"],
		["2026-03-02", "PAYROLL", "", 150000n, "A2"],
	]);
});

test("unusable files are rejected with a clear message", () => {
	assert.throws(() => parseStatement("hello\nworld\n"), /could not find date/);
	assert.throws(() => parseStatement("<OFX></OFX>", { filename: "a.ofx" }), /STMTTRN/);
});

test("payeeKey groups the same merchant", () => {
	assert.equal(payeeKey("POS PURCHASE SHELL #1234 TORONTO ON"), "SHELL TORONTO ON");
	assert.equal(payeeKey("SHELL #998 TORONTO ON"), "SHELL TORONTO ON");
	assert.equal(payeeKey("PAYPAL *NETFLIX.COM 866-579"), "NETFLIX");
	assert.equal(payeeKey("12345"), "");
});
