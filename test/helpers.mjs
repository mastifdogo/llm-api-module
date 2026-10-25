import net from "node:net";
import { quote } from "../lib/imap.mjs";

export const PDF = Buffer.from("%PDF-1.4 fake pdf bytes \x00\x01\x02");

/** A bill email: multipart/alternative text + HTML, with a PDF attachment. */
export function sampleEmail({ subject = "Your Rogers bill", messageId = "abc@rogers.com", html = true } = {}) {
	const b64 = PDF.toString("base64");
	return Buffer.from(
		[
			"From: =?UTF-8?Q?Rogers_Billing?= <billing@rogers.com>",
			`Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
			"Date: Tue, 03 Mar 2026 10:00:00 -0500",
			`Message-ID: <${messageId}>`,
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="outer"',
			"",
			"--outer",
			'Content-Type: multipart/alternative; boundary="inner"',
			"",
			"--inner",
			"Content-Type: text/plain; charset=utf-8",
			"Content-Transfer-Encoding: quoted-printable",
			"",
			"Amount due: $85.50 =E2=80=94 due March 20, 2026.=",
			" Thanks.",
			"--inner",
			"Content-Type: text/html; charset=utf-8",
			"",
			html ? "<html><body><p>Amount due: <b>$85.50</b></p></body></html>" : "",
			"--inner--",
			"--outer",
			'Content-Type: application/octet-stream; name="bill.pdf"',
			"Content-Disposition: attachment; filename*=utf-8''Rogers%20March.pdf",
			"Content-Transfer-Encoding: base64",
			"",
			b64.slice(0, 20),
			b64.slice(20),
			"--outer--",
			"",
		].join("\r\n"),
	);
}

/** A tiny IMAP server: one folder, messages by UID. Records every command. */
export function fakeImap(messages, { user = "me@example.com", pass = "app-pass", uidvalidity = 7 } = {}) {
	const log = [];
	const server = net.createServer((sock) => {
		sock.write("* OK fake IMAP ready\r\n");
		let buf = "";
		sock.on("data", (d) => {
			buf += d.toString("latin1");
			let i;
			while ((i = buf.indexOf("\r\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				log.push(line);
				const [tag, cmd, ...rest] = line.split(" ");
				const args = rest.join(" ");
				const C = cmd.toUpperCase();
				if (C === "LOGIN") {
					if (args === `${quote(user)} ${quote(pass)}`) sock.write(`${tag} OK logged in\r\n`);
					else sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
				} else if (C === "EXAMINE") {
					sock.write(`* ${messages.size} EXISTS\r\n* OK [UIDVALIDITY ${uidvalidity}] ok\r\n${tag} OK [READ-ONLY] done\r\n`);
				} else if (C === "UID" && rest[0] === "SEARCH") {
					sock.write(`* SEARCH ${[...messages.keys()].join(" ")}\r\n${tag} OK done\r\n`);
				} else if (C === "UID" && rest[0] === "FETCH") {
					const uid = Number(rest[1]);
					const m = messages.get(uid);
					if (!m) sock.write(`${tag} OK nothing\r\n`);
					else if (args.includes("RFC822.SIZE")) sock.write(`* 1 FETCH (UID ${uid} RFC822.SIZE ${m.length})\r\n${tag} OK done\r\n`);
					else {
						sock.write(`* 1 FETCH (UID ${uid} BODY[] {${m.length}}\r\n`);
						// Split the literal across writes to exercise buffering.
						sock.write(m.subarray(0, 10));
						setTimeout(() => sock.write(Buffer.concat([m.subarray(10), Buffer.from(`)\r\n${tag} OK done\r\n`)])), 5);
					}
				} else if (C === "LOGOUT") {
					sock.write(`* BYE\r\n${tag} OK bye\r\n`);
					sock.end();
				} else sock.write(`${tag} BAD unknown\r\n`);
			}
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, log })));
}
