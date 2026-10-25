import assert from "node:assert/strict";
import { test } from "node:test";
import { ImapClient, quote } from "../lib/imap.mjs";
import { htmlToText, parseEmail } from "../lib/mime.mjs";
import { fakeImap, PDF, sampleEmail } from "./helpers.mjs";

test("parseEmail: headers, quoted-printable text, attachments", () => {
	const e = parseEmail(sampleEmail({ subject: "Votre facture été" }));
	assert.equal(e.subject, "Votre facture été");
	assert.equal(e.from, "Rogers Billing <billing@rogers.com>");
	assert.equal(e.messageId, "abc@rogers.com");
	assert.equal(e.date.toISOString(), "2026-03-03T15:00:00.000Z");
	assert.equal(e.text, "Amount due: $85.50 — due March 20, 2026. Thanks.");
	assert.equal(e.attachments.length, 1);
	assert.equal(e.attachments[0].filename, "Rogers March.pdf");
	assert.equal(e.attachments[0].contentType, "application/pdf");
	assert.deepEqual(e.attachments[0].data, PDF);
});

test("HTML-only emails become readable text", () => {
	const raw = Buffer.from("Subject: x\r\nContent-Type: text/html\r\n\r\n<style>p{}</style><table><tr><td>Total</td><td>$1,234.00</td></tr></table><p>Due&nbsp;soon &amp; now</p>");
	assert.equal(parseEmail(raw).text, "Total\t$1,234.00\nDue soon & now");
	assert.equal(htmlToText("a<br>b&#233;"), "a\nbé");
});

test("quote escapes IMAP strings", () => {
	assert.equal(quote('pa"ss\\word'), '"pa\\"ss\\\\word"');
	assert.throws(() => quote("a\r\nb"));
});

test("ImapClient reads messages without marking them seen", async () => {
	const msg = sampleEmail();
	const { server, port, log } = await fakeImap(new Map([[11, msg], [12, sampleEmail({ messageId: "x@y" })]]));
	const c = new ImapClient({ host: "127.0.0.1", port, secure: false, timeoutMs: 5000 });
	await c.connect();
	await c.login("me@example.com", "app-pass");
	assert.deepEqual(await c.examine("INBOX"), { uidvalidity: 7, exists: 2 });
	assert.deepEqual(await c.searchSince(new Date("2026-03-01T00:00:00Z")), [11, 12]);
	assert.equal(await c.size(11), msg.length);
	assert.deepEqual(await c.fetch(11), msg);
	await c.logout();
	server.close();
	assert.ok(log.some((l) => l.endsWith('EXAMINE "INBOX"')));
	assert.ok(log.some((l) => l.endsWith("UID SEARCH SINCE 1-Mar-2026")));
	assert.ok(log.some((l) => l.includes("BODY.PEEK[]")));
	assert.ok(!log.some((l) => /SELECT|STORE|EXPUNGE/.test(l)));
});

test("ImapClient reports a bad password", async () => {
	const { server, port } = await fakeImap(new Map());
	const c = new ImapClient({ host: "127.0.0.1", port, secure: false, timeoutMs: 5000 });
	await c.connect();
	await assert.rejects(c.login("me@example.com", "wrong"), /login failed: \[AUTHENTICATIONFAILED\] Invalid credentials/);
	c.close();
	server.close();
});
