// Gmail without IMAP: a small Google Apps Script, deployed as a web app in the
// user's own Google account, answers the module's requests with a list of
// matching messages and, per message, its raw RFC 822 source. The module
// calls it on its schedule with a secret token. Read-only: the script never
// changes, labels, moves or deletes mail.

export class GmailError extends Error {}

const TIMEOUT_MS = 90_000;

/** The Apps Script the user pastes into script.google.com, with their token filled in. */
export function bridgeScript(token) {
	return `// Gmail bridge for the "LLM API" module in Ledger.
// Lets the module read bill emails from this Gmail account without IMAP.
// Read-only: it never changes, labels, moves or deletes mail.
//
// Setup (once):
//  1. Open https://script.google.com, click "New project", and replace all the code with this file.
//  2. Click Deploy -> New deployment -> Select type: Web app.
//     Execute as: Me.  Who has access: Anyone.  Click Deploy and allow access when asked.
//  3. Copy the Web app URL (it ends in /exec) into Ledger: LLM API -> Settings -> Email.
// Only requests that carry TOKEN get an answer. If you create a new token in Ledger,
// paste the new script here and use Deploy -> Manage deployments -> Edit -> New version.

const TOKEN = ${JSON.stringify(token)};
const MAX_RAW_CHARS = 15 * 1024 * 1024;

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (TOKEN.length < 32 || p.token !== TOKEN) return reply({ error: "forbidden" });
  try {
    if (p.action === "raw") {
      const m = GmailApp.getMessageById(p.id);
      if (!m) return reply({ error: "not_found" });
      const raw = m.getRawContent();
      if (raw.length > MAX_RAW_CHARS) return reply({ id: p.id, too_large: true });
      return reply({ id: p.id, raw: Utilities.base64Encode(raw, Utilities.Charset.UTF_8) });
    }
    const since = Number(p.since) || 0;
    const max = Math.min(Number(p.max) || 200, 500);
    const out = [];
    for (const t of GmailApp.search(p.q || "newer_than:30d", 0, 200)) {
      for (const m of t.getMessages()) {
        if (m.getDate().getTime() < since || m.isInTrash()) continue;
        out.push({ id: m.getId(), date: m.getDate().toISOString(), subject: m.getSubject(), from: m.getFrom() });
      }
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return reply({ account: Session.getEffectiveUser().getEmail(), total: out.length, messages: out.slice(0, max) });
  } catch (err) {
    return reply({ error: String((err && err.message) || err) });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

/** Web app URLs from Apps Script, or a loopback URL (for testing). */
export function validBridgeUrl(url) {
	return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[^\s]*$/.test(url);
}

/** The Gmail search for bill emails: the lookback window plus any of the keywords. */
export function gmailQuery({ lookbackDays, keywords, custom }) {
	const parts = [`newer_than:${lookbackDays}d`];
	if (custom) parts.push(custom);
	else if (keywords.length > 0) parts.push(`{${keywords.map((k) => (/\s/.test(k) ? `"${k.replace(/"/g, "")}"` : k)).join(" ")}}`);
	return parts.join(" ");
}

export class GmailBridge {
	constructor({ url, token, fetchImpl = globalThis.fetch }) {
		this.url = url;
		this.token = token;
		this.fetch = fetchImpl;
	}

	async call(params) {
		const u = new URL(this.url);
		for (const [k, v] of Object.entries({ ...params, token: this.token })) u.searchParams.set(k, String(v));
		let res;
		try {
			// Apps Script answers with a redirect to script.googleusercontent.com; fetch follows it.
			res = await this.fetch(u, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
		} catch (err) {
			const why = err?.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS / 1000} s` : err?.cause?.message || err?.message || String(err);
			throw new GmailError(`could not reach the Gmail bridge: ${why}`);
		}
		const text = await res.text();
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			if (/<html/i.test(text)) {
				throw new GmailError('the Gmail bridge answered with a web page instead of data: check the deployment is a Web app with "Who has access: Anyone", and that the URL ends in /exec');
			}
			throw new GmailError(`the Gmail bridge answered ${res.status} with something that isn't JSON`);
		}
		if (data?.error === "forbidden") throw new GmailError("the Gmail bridge refused the token: paste the current script from Ledger into Apps Script and deploy a new version");
		if (data?.error) throw new GmailError(`the Gmail bridge reported: ${data.error}`);
		if (!res.ok) throw new GmailError(`the Gmail bridge answered ${res.status}`);
		return data;
	}

	/** { account, total, messages: [{ id, date, subject, from }] }, oldest first. */
	async list({ query, since, max = 200 }) {
		const d = await this.call({ q: query, since: since.getTime(), max });
		if (!Array.isArray(d.messages)) throw new GmailError("the Gmail bridge returned no message list");
		return { account: String(d.account ?? ""), total: Number(d.total) || d.messages.length, messages: d.messages.filter((m) => typeof m?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(m.id)) };
	}

	/** The raw message (Buffer), or { tooLarge: true }. */
	async raw(id) {
		const d = await this.call({ action: "raw", id });
		if (d.too_large) return { tooLarge: true };
		if (typeof d.raw !== "string") throw new GmailError(`the Gmail bridge returned no content for message ${id}`);
		return { data: Buffer.from(d.raw, "base64") };
	}
}
