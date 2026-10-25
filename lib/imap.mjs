// A minimal read-only IMAP4rev1 client (no dependencies): log in, open a
// folder read-only (EXAMINE, so nothing is marked as read), search by date,
// and fetch whole messages one at a time.
//
// Works with Gmail, Outlook/Microsoft 365, Fastmail, iCloud, Proton Bridge and
// most hosts over implicit TLS (port 993). Gmail and iCloud need an app password.

import net from "node:net";
import tls from "node:tls";

export class ImapError extends Error {}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** IMAP quoted string. */
export function quote(s) {
	s = String(s);
	if (/[\r\n\0]/.test(s)) throw new ImapError("value contains a line break");
	return `"${s.replace(/["\\]/g, (c) => "\\" + c)}"`;
}

export class ImapClient {
	constructor({ host, port = 993, secure = true, timeoutMs = 60_000, rejectUnauthorized = true }) {
		this.opts = { host, port, secure, timeoutMs, rejectUnauthorized };
		this.chunks = [];
		this.total = 0;
		this.need = 0; // bytes required before the pending literal can be parsed
		this.tag = 0;
		this.waiter = null; // { onLine, reject }
		this.closed = false;
	}

	connect() {
		const { host, port, secure, timeoutMs, rejectUnauthorized } = this.opts;
		return new Promise((resolve, reject) => {
			const onConnectError = (err) => reject(new ImapError(`could not connect to ${host}:${port}: ${err.message}`));
			this.socket = secure ? tls.connect({ host, port, servername: host, rejectUnauthorized }) : net.connect({ host, port });
			this.socket.once("error", onConnectError);
			this.socket.setTimeout(timeoutMs, () => this.socket.destroy(new Error(`no response from ${host} within ${timeoutMs / 1000} s`)));
			this.socket.on("data", (d) => this.onData(d));
			this.socket.on("close", () => {
				this.closed = true;
				this.waiter?.reject(new ImapError("the server closed the connection"));
			});
			this.socket.on("error", (err) => this.waiter?.reject(new ImapError(err.message)));
			this.waiter = {
				onLine: (r) => {
					this.waiter = null;
					this.socket.off("error", onConnectError);
					if (/^\* (OK|PREAUTH)/i.test(r.text)) resolve(r.text);
					else reject(new ImapError(`unexpected greeting: ${r.text.slice(0, 200)}`));
				},
				reject,
			};
		});
	}

	onData(d) {
		this.chunks.push(d);
		this.total += d.length;
		if (this.total < this.need) return;
		this.pump();
	}

	/** Reads one response line, with any {n} literals it contains, or null if more data is needed. */
	readLine() {
		if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
		const buf = this.chunks[0];
		if (!buf) return null;
		let pos = 0;
		let text = "";
		const literals = [];
		for (;;) {
			const eol = buf.indexOf("\r\n", pos);
			if (eol < 0) return null;
			const seg = buf.toString("utf8", pos, eol);
			const m = /\{(\d+)\+?\}$/.exec(seg);
			if (!m) {
				text += seg;
				pos = eol + 2;
				break;
			}
			const start = eol + 2;
			const end = start + Number(m[1]);
			if (buf.length < end) {
				this.need = end;
				return null;
			}
			literals.push(Buffer.from(buf.subarray(start, end)));
			text += seg.slice(0, m.index) + `{literal${literals.length - 1}}`;
			pos = end;
		}
		this.need = 0;
		const rest = buf.subarray(pos);
		this.chunks = rest.length > 0 ? [rest] : [];
		this.total = rest.length;
		return { text, literals };
	}

	pump() {
		while (this.waiter) {
			const r = this.readLine();
			if (!r) return;
			this.waiter.onLine(r);
		}
	}

	/** Sends a command and collects its untagged responses; throws on NO/BAD. */
	command(cmd) {
		if (this.closed) return Promise.reject(new ImapError("not connected"));
		const tag = `A${++this.tag}`;
		return new Promise((resolve, reject) => {
			const untagged = [];
			this.waiter = {
				onLine: (r) => {
					if (r.text.startsWith(tag + " ")) {
						this.waiter = null;
						const m = /^\S+ (OK|NO|BAD)\s?(.*)$/i.exec(r.text);
						if (m && m[1].toUpperCase() === "OK") resolve({ untagged, text: m[2] });
						else reject(new ImapError(m ? m[2] || m[1] : r.text));
					} else if (!r.text.startsWith("+")) untagged.push(r);
				},
				reject,
			};
			this.socket.write(`${tag} ${cmd}\r\n`);
			this.pump();
		});
	}

	async login(user, password) {
		try {
			await this.command(`LOGIN ${quote(user)} ${quote(password)}`);
		} catch (err) {
			throw new ImapError(`login failed: ${err.message}`);
		}
	}

	/** Opens a folder read-only; returns { uidvalidity, exists }. */
	async examine(folder) {
		const r = await this.command(`EXAMINE ${quote(folder)}`).catch((err) => {
			throw new ImapError(`could not open folder ${JSON.stringify(folder)}: ${err.message}`);
		});
		let uidvalidity = null;
		let exists = 0;
		for (const u of r.untagged) {
			const v = /\[UIDVALIDITY (\d+)\]/i.exec(u.text);
			if (v) uidvalidity = Number(v[1]);
			const e = /^\* (\d+) EXISTS/i.exec(u.text);
			if (e) exists = Number(e[1]);
		}
		if (uidvalidity === null) throw new ImapError("the server did not report UIDVALIDITY");
		return { uidvalidity, exists };
	}

	/** UIDs of messages received on or after the date. */
	async searchSince(date) {
		const d = `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
		const r = await this.command(`UID SEARCH SINCE ${d}`);
		const uids = [];
		for (const u of r.untagged) {
			const m = /^\* SEARCH\b(.*)$/i.exec(u.text);
			if (m) uids.push(...m[1].trim().split(/\s+/).filter(Boolean).map(Number));
		}
		return uids.sort((a, b) => a - b);
	}

	async size(uid) {
		const r = await this.command(`UID FETCH ${Number(uid)} (RFC822.SIZE)`);
		for (const u of r.untagged) {
			const m = /RFC822\.SIZE (\d+)/i.exec(u.text);
			if (m) return Number(m[1]);
		}
		return null;
	}

	/** The raw message (Buffer), without setting \Seen. */
	async fetch(uid) {
		const r = await this.command(`UID FETCH ${Number(uid)} (BODY.PEEK[])`);
		for (const u of r.untagged) if (/FETCH/i.test(u.text) && u.literals.length > 0) return u.literals[0];
		return null;
	}

	async logout() {
		if (this.closed) return;
		await this.command("LOGOUT").catch(() => {});
		this.socket.end();
	}

	close() {
		this.closed = true;
		this.socket?.destroy();
	}
}
