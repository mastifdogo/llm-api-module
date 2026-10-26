import assert from "node:assert/strict";
import { test } from "node:test";
import { entryRecords, pairTransfers, transferScore } from "../lib/transfers.mjs";

const accounts = new Map([
	["1000", { name: "Chequing", currency: "CAD" }],
	["1100", { name: "Savings", currency: "CAD" }],
	["2100", { name: "Visa", currency: "CAD" }],
	["1200", { name: "US account", currency: "USD" }],
]);
const row = (id, account_code, date, description, amount, extra = {}) => ({ id, account_code, date, description, amount_cents: BigInt(amount), suggested_code: null, chosen_code: null, ...extra });

test("transfer between chequing and savings", () => {
	const out = row(1, "1000", "2026-03-02", "ONLINE TRANSFER TO 1234", -50000);
	const inn = row(2, "1100", "2026-03-03", "TFR FROM CHQ", 50000);
	assert.equal(transferScore(out, inn, accounts), 0.75); // worded, next day
	assert.equal(transferScore({ ...out, suggested_code: "1100" }, inn, accounts), 0.95);
	assert.equal(transferScore(out, { ...inn, amount_cents: 49999n }, accounts), 0);
	assert.equal(transferScore(out, { ...inn, date: "2026-03-09" }, accounts), 0);
	assert.equal(transferScore(out, { ...inn, account_code: "1200" }, accounts), 0); // other currency
	assert.equal(transferScore(out, { ...inn, chosen_code: "4000" }, accounts), 0); // you booked it as income
});

test("needs a sign it's a transfer", () => {
	const grocery = row(1, "1000", "2026-03-02", "LOBLAWS 22", -2500);
	const refund = row(2, "2100", "2026-03-02", "AMAZON REFUND", 2500);
	assert.equal(transferScore(grocery, refund, accounts), 0);
	assert.ok(transferScore(row(3, "1000", "2026-03-02", "VISA CARD 4411", -2500), refund, accounts) > 0); // names the other account
});

test("pairing is one-to-one and skips rejected pairs", () => {
	const rows = [
		row(1, "1000", "2026-03-02", "TRANSFER", -10000),
		row(2, "1000", "2026-03-05", "TRANSFER", -10000),
		row(3, "1100", "2026-03-05", "TRANSFER", 10000),
	];
	assert.deepEqual(pairTransfers(rows, accounts).map((p) => [p.a.id, p.b.id]), [[2, 3]]); // closest date wins
	rows[1].rejected_transfer_tx = 3n;
	assert.deepEqual(pairTransfers(rows, accounts).map((p) => [p.a.id, p.b.id]), [[1, 3]]);
});

test("an existing journal entry recording the transfer", () => {
	const t = row(2, "1100", "2026-03-03", "TFR FROM CHQ", 50000);
	const entry = { entry_date: "2026-03-02", reversed_by_id: null, reverses_id: null, lines: [
		{ account_code: "1100", debit_cents: 50000n, credit_cents: 0n },
		{ account_code: "1000", debit_cents: 0n, credit_cents: 50000n },
	] };
	assert.ok(entryRecords(entry, t, "1000"));
	assert.ok(!entryRecords(entry, t, "2100"));
	assert.ok(!entryRecords({ ...entry, reversed_by_id: 9 }, t, "1000"));
	assert.ok(!entryRecords(entry, { ...t, amount_cents: -50000n }, "1000")); // wrong direction
});
