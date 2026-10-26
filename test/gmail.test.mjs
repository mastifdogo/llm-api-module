import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { GmailBridge, bridgeScript, gmailQuery, validBridgeUrl } from "../lib/gmail.mjs";

const TOKEN = "t".repeat(32);

/** Runs the Apps Script in a sandbox with a fake Gmail, the way Google would call doGet. */
function runScript(messages, params) {
	const raw = new Map(messages.map((m) => [m.id, m.raw]));
	const msg = (m) => ({ getId: () => m.id, getDate: () => new Date(m.date), getSubject: () => m.subject, getFrom: () => m.from, isInTrash: () => !!m.trash, getRawContent: () => m.raw });
	const sandbox = {
		GmailApp: {
			search: (q) => { sandbox.lastQuery = q; return [{ getMessages: () => messages.map(msg) }]; },
			getMessageById: (id) => (raw.has(id) ? msg(messages.find((m) => m.id === id)) : null),
		},
		Utilities: { base64Encode: (s) => Buffer.from(s, "utf8").toString("base64"), Charset: { UTF_8: "UTF-8" } },
		Session: { getEffectiveUser: () => ({ getEmail: () => "me@gmail.com" }) },
		ContentService: { createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }), MimeType: { JSON: "json" } },
	};
	vm.createContext(sandbox);
	vm.runInContext(bridgeScript(TOKEN), sandbox);
	return { out: JSON.parse(vm.runInContext("doGet", sandbox)({ parameter: params }).text), sandbox };
}

const MSGS = [
	{ id: "18b2", date: "2026-03-05T10:00:00Z", subject: "Your bill", from: "Rogers <b@rogers.com>", raw: "Subject: Your bill\r\n\r\nAmount due $85.50" },
	{ id: "18a1", date: "2026-03-01T10:00:00Z", subject: "Old", from: "x", raw: "Subject: Old\r\n\r\nhi" },
	{ id: "18c3", date: "2026-03-06T10:00:00Z", subject: "Trash", from: "x", raw: "", trash: true },
];

test("the Apps Script answers only with the token, lists oldest first, returns raw messages", () => {
	assert.deepEqual(runScript(MSGS, { token: "wrong" }).out, { error: "forbidden" });
	const { out, sandbox } = runScript(MSGS, { token: TOKEN, q: "newer_than:30d {bill}", since: String(Date.parse("2026-03-02T00:00:00Z")) });
	assert.equal(sandbox.lastQuery, "newer_than:30d {bill}");
	assert.equal(out.account, "me@gmail.com");
	assert.deepEqual(out.messages.map((m) => m.id), ["18b2"]); // older and trashed ones left out
	const raw = runScript(MSGS, { token: TOKEN, action: "raw", id: "18b2" }).out;
	assert.equal(Buffer.from(raw.raw, "base64").toString(), MSGS[0].raw);
	assert.deepEqual(runScript(MSGS, { token: TOKEN, action: "raw", id: "nope" }).out, { error: "not_found" });
});

test("GmailBridge talks to the web app", async () => {
	const seen = [];
	const fetchImpl = async (u) => {
		seen.push(u);
		const p = Object.fromEntries(u.searchParams);
		const { out } = runScript(MSGS, p);
		return new Response(JSON.stringify(out));
	};
	const g = new GmailBridge({ url: "https://script.google.com/macros/s/AKfy_x-1/exec", token: TOKEN, fetchImpl });
	const list = await g.list({ query: "newer_than:30d", since: new Date("2026-02-01T00:00:00Z") });
	assert.deepEqual(list.messages.map((m) => m.id), ["18a1", "18b2"]);
	assert.equal(seen[0].searchParams.get("token"), TOKEN);
	assert.equal((await g.raw("18b2")).data.toString(), MSGS[0].raw);
	await assert.rejects(new GmailBridge({ url: "https://script.google.com/macros/s/x/exec", token: "bad", fetchImpl }).list({ query: "", since: new Date() }), /refused the token/);
});

test("helpful errors for a wrong deployment", async () => {
	const html = async () => new Response("<html><body>Sign in - Google Accounts</body></html>", { status: 200 });
	await assert.rejects(new GmailBridge({ url: "https://script.google.com/macros/s/x/exec", token: TOKEN, fetchImpl: html }).list({ query: "", since: new Date() }), /Who has access: Anyone/);
	const down = async () => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND script.google.com") }); };
	await assert.rejects(new GmailBridge({ url: "https://script.google.com/macros/s/x/exec", token: TOKEN, fetchImpl: down }).list({ query: "", since: new Date() }), /ENOTFOUND/);
});

test("query and URL helpers", () => {
	assert.equal(gmailQuery({ lookbackDays: 30, keywords: ["invoice", "amount due"], custom: "" }), 'newer_than:30d {invoice "amount due"}');
	assert.equal(gmailQuery({ lookbackDays: 7, keywords: ["invoice"], custom: "label:bills" }), "newer_than:7d label:bills");
	assert.equal(gmailQuery({ lookbackDays: 7, keywords: [], custom: "" }), "newer_than:7d");
	assert.ok(validBridgeUrl("https://script.google.com/macros/s/AKfycbx-_12/exec"));
	assert.ok(!validBridgeUrl("https://evil.example/macros/s/x/exec"));
	assert.ok(!validBridgeUrl("http://script.google.com/macros/s/x/exec"));
	assert.ok(validBridgeUrl("http://127.0.0.1:9998/exec"));
});
