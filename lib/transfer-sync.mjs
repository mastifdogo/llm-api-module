// Links the two statement rows of one transfer between your own accounts, or
// a row and the journal entry that already records it, so it is posted once.
// The scoring rules are in transfers.mjs.

import { MAX_DAYS, entryRecords, pairTransfers, transferScore } from "./transfers.mjs";

const shiftDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/** h: { q, T, bad, requeue(statementIds) } */
export function registerTransfers(ctx, h) {
	const { q, T, bad } = h;

	/** Drops links that no longer hold (an account was changed, a row skipped or discarded). */
	async function cleanup() {
		await q(
			`UPDATE ${T("transactions")} t
			    SET transfer_tx_id = NULL, source = CASE WHEN t.source = 'transfer' THEN 'llm' ELSE t.source END,
			        reason = CASE WHEN t.source = 'transfer' THEN '' ELSE t.reason END
			   FROM ${T("transactions")} o
			  WHERE t.transfer_tx_id = o.id AND t.status = 'new'
			    AND (COALESCE(t.chosen_code, t.suggested_code) IS DISTINCT FROM o.account_code
			         OR (o.status = 'new' AND COALESCE(o.chosen_code, o.suggested_code) IS DISTINCT FROM t.account_code)
			         OR o.status = 'skipped' OR t.bill_id IS NOT NULL)`,
		);
		await q(
			`UPDATE ${T("transactions")} SET transfer_entry_id = NULL, source = 'llm', reason = ''
			  WHERE status = 'new' AND transfer_entry_id IS NOT NULL AND chosen_code IS NOT NULL AND chosen_code IS DISTINCT FROM suggested_code`,
		);
		await q(
			`UPDATE ${T("transactions")} SET source = 'llm', reason = ''
			  WHERE status = 'new' AND source = 'transfer' AND transfer_tx_id IS NULL AND transfer_entry_id IS NULL`,
		);
	}

	/** Pairs unposted rows across statements, then checks the rest against the journal. Returns the number of new links. */
	async function matchTransfers() {
		await cleanup();
		const all = await ctx.ledger.listAccounts();
		const accounts = new Map(all.map((a) => [a.code, a]));
		const { rows } = await q(
			`SELECT t.id, t.statement_id, t.account_code, t.tx_date::text AS date, t.description, t.amount_cents, t.suggested_code, t.chosen_code,
			        t.rejected_transfer_tx, t.rejected_transfer_entry, s.filename
			   FROM ${T("transactions")} t JOIN ${T("statements")} s ON s.id = t.statement_id
			  WHERE t.status = 'new' AND t.bill_id IS NULL AND t.transfer_tx_id IS NULL AND t.transfer_entry_id IS NULL`,
		);
		let linked = 0;
		const label = (code) => `${code}${accounts.get(code) ? ` ${accounts.get(code).name}` : ""}`;

		// 1. Both sides are on uploaded statements.
		const paired = new Set();
		for (const { a, b, score } of pairTransfers(rows, accounts)) {
			const link = async (x, y, dir) => {
				const r = await q(
					`UPDATE ${T("transactions")} SET transfer_tx_id = $2, suggested_code = $3, confidence = $4, source = 'transfer', reason = $5, error = NULL
					  WHERE id = $1 AND status = 'new' AND transfer_tx_id IS NULL AND bill_id IS NULL`,
					[x.id, y.id, y.account_code, score, `transfer ${dir} ${label(y.account_code)}: ${y.date} on ${y.filename}`.slice(0, 200)],
				);
				return r.rowCount === 1;
			};
			if ((await link(a, b, "to")) && (await link(b, a, "from"))) {
				paired.add(String(a.id)).add(String(b.id));
				linked++;
			}
		}

		// 2. The transfer is already in the journal (the other side was posted earlier, or entered by hand):
		//    an unclaimed entry on this row's account with its exact amount, whose other side is a bank or card account.
		const isBankish = (code) => ["asset", "liability"].includes(accounts.get(code)?.type);
		const candidates = rows.filter((t) => !paired.has(String(t.id)) && (t.chosen_code === null || isBankish(t.chosen_code)));
		const byAccount = Map.groupBy(candidates, (t) => t.account_code);
		const entries = new Map();
		for (const [code, list] of byAccount) {
			const dates = list.map((t) => t.date).sort();
			let ledger;
			try {
				ledger = await ctx.ledger.accountLedger(code, { from: shiftDays(dates[0], -MAX_DAYS), to: shiftDays(dates.at(-1), MAX_DAYS) });
			} catch {
				continue;
			}
			const { rows: claimedRows } = await q(
				`SELECT journal_entry_id AS id FROM ${T("transactions")} WHERE account_code = $1 AND journal_entry_id IS NOT NULL
				 UNION SELECT transfer_entry_id FROM ${T("transactions")} WHERE account_code = $1 AND transfer_entry_id IS NOT NULL`,
				[code],
			);
			const claimed = new Set(claimedRows.map((r) => String(r.id)));
			for (const t of list) {
				const amt = BigInt(t.amount_cents);
				const abs = amt < 0n ? -amt : amt;
				let best = null;
				for (const line of ledger.lines) {
					const id = String(line.journal_entry_id);
					if (claimed.has(id) || String(t.rejected_transfer_entry) === id) continue;
					if (BigInt(amt > 0n ? line.debit_cents : line.credit_cents) !== abs) continue;
					if (!entries.has(id)) entries.set(id, await ctx.ledger.getJournalEntry(line.journal_entry_id).catch(() => null));
					const entry = entries.get(id);
					if (!entry) continue;
					for (const other of new Set(entry.lines.map((l) => l.account_code))) {
						if (other === code || !isBankish(other) || !entryRecords(entry, t, other)) continue;
						// Score it like a pair of rows, with the entry standing in for the other statement row.
						const score = transferScore(t, { id: `entry-${id}`, account_code: other, date: entry.entry_date, description: entry.description, amount_cents: -amt, suggested_code: null, chosen_code: null }, accounts);
						if (score > 0 && (!best || score > best.score)) best = { entry, other, score };
					}
				}
				if (!best) continue;
				const r = await q(
					`UPDATE ${T("transactions")} SET transfer_entry_id = $2, suggested_code = $3, confidence = $4, source = 'transfer', reason = $5, error = NULL
					  WHERE id = $1 AND status = 'new' AND transfer_entry_id IS NULL AND transfer_tx_id IS NULL`,
					[t.id, best.entry.id, best.other, best.score, `already in the journal: entry #${best.entry.id} on ${best.entry.entry_date}, "${best.entry.description}"`.slice(0, 200)],
				);
				if (r.rowCount === 1) {
					claimed.add(String(best.entry.id));
					linked++;
				}
			}
		}
		if (linked > 0) ctx.log.info("transfers linked", { links: linked });
		return linked;
	}

	// POST /transactions/:id/not-transfer: unlink a wrong match; the pair isn't linked again.
	ctx.route("POST", "/transactions/:id/not-transfer", async (req) => {
		if (!/^\d+$/.test(req.params.id)) throw new ctx.HttpError(404, "no such transaction");
		const { rows } = await q(`SELECT id, statement_id, transfer_tx_id, transfer_entry_id, status FROM ${T("transactions")} WHERE id = $1`, [req.params.id]);
		const t = rows[0];
		if (!t) throw new ctx.HttpError(404, "no such transaction");
		if (t.status !== "new") throw bad("only transactions waiting to be posted can be unlinked");
		const requeue = new Set();
		if (t.transfer_tx_id !== null) {
			// Both sides go back to the model for a fresh suggestion.
			const r = await q(
				`UPDATE ${T("transactions")}
				    SET rejected_transfer_tx = CASE WHEN id = $1 THEN $2 ELSE $1 END, transfer_tx_id = NULL,
				        suggested_code = NULL, confidence = NULL, source = '', reason = ''
				  WHERE id IN ($1, $2) AND status = 'new' RETURNING statement_id`,
				[t.id, t.transfer_tx_id],
			);
			for (const x of r.rows) requeue.add(x.statement_id);
		} else if (t.transfer_entry_id !== null) {
			await q(
				`UPDATE ${T("transactions")} SET rejected_transfer_entry = transfer_entry_id, transfer_entry_id = NULL, source = 'llm', reason = '' WHERE id = $1`,
				[t.id],
			);
		} else throw bad("this transaction isn't linked to a transfer");
		if (requeue.size > 0) await h.requeue([...requeue]);
		return { ok: true };
	});

	return { matchTransfers };
}
