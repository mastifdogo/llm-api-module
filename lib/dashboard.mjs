// Notifications and to-dos on Ledger's dashboard (ctx.dashboard, Ledger 0.7.0+).
// Best effort: a failure here is logged and never breaks the work that triggered it.

export function dashboard(ctx) {
	const d = ctx.dashboard;
	const safe =
		(name) =>
		async (...args) => {
			if (!d) return null;
			try {
				return await d[name](...args);
			} catch (err) {
				ctx.log.warn("dashboard update failed", { call: name, err: String(err?.message || err) });
				return null;
			}
		};
	return {
		/** The module's page inside Ledger. */
		link: `/apps/${ctx.id}`,
		notify: safe("notify"),
		todo: safe("todo"),
		complete: safe("complete"),
		remove: safe("remove"),
	};
}
