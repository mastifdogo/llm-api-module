// A small RFC 5322 / MIME parser: enough to read bill emails.
//
// parseEmail(buffer) -> { subject, from, date, messageId, text, html, attachments: [{ filename, contentType, data }] }
// text is the plain-text body (or the HTML body turned into text).

function splitHeaderBody(buf) {
	let i = buf.indexOf("\r\n\r\n");
	if (i >= 0) return [buf.subarray(0, i).toString("latin1"), buf.subarray(i + 4)];
	i = buf.indexOf("\n\n");
	if (i >= 0) return [buf.subarray(0, i).toString("latin1"), buf.subarray(i + 2)];
	return [buf.toString("latin1"), Buffer.alloc(0)];
}

/** Headers as a Map of lower-case name -> list of raw (still encoded) values. */
export function parseHeaders(text) {
	const out = new Map();
	const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
	for (const line of unfolded.split(/\r?\n/)) {
		const i = line.indexOf(":");
		if (i <= 0) continue;
		const name = line.slice(0, i).trim().toLowerCase();
		if (!out.has(name)) out.set(name, []);
		out.get(name).push(line.slice(i + 1).trim());
	}
	return out;
}

function decodeBytes(bytes, charset) {
	const cs = String(charset || "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
	try {
		return new TextDecoder(cs === "us-ascii" || cs === "ascii" ? "utf-8" : cs).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

/** Raw header bytes were read as latin1; re-read 8-bit ones as UTF-8 when that's what they are. */
function fixRaw8bit(s) {
	if (!/[\u0080-ÿ]/.test(s)) return s;
	const bytes = Buffer.from(s, "latin1");
	const utf8 = bytes.toString("utf8");
	return utf8.includes("�") ? s : utf8;
}

function decodeQ(s) {
	const bytes = [];
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "_") bytes.push(0x20);
		else if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
			bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
			i += 2;
		} else bytes.push(c.charCodeAt(0) & 0xff);
	}
	return Buffer.from(bytes);
}

/** RFC 2047 encoded words: =?utf-8?B?...?= and =?iso-8859-1?Q?...?= */
export function decodeWords(value) {
	return fixRaw8bit(String(value ?? ""))
		.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1")
		.replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
			const bytes = enc.toUpperCase() === "B" ? Buffer.from(data, "base64") : decodeQ(data);
			return decodeBytes(bytes, cs);
		});
}

/** "text/plain; charset=utf-8; name=\"a b.pdf\"" -> { value, params } (RFC 2231 continuations included). */
export function parseParams(header) {
	const parts = [];
	let cur = "";
	let quoted = false;
	for (const c of String(header ?? "")) {
		if (c === '"') quoted = !quoted;
		if (c === ";" && !quoted) {
			parts.push(cur);
			cur = "";
		} else cur += c;
	}
	parts.push(cur);
	const value = parts.shift().trim().toLowerCase();
	const params = {};
	const continued = {}; // name -> { charset, parts: [{ ext, val }] }
	for (const p of parts) {
		const i = p.indexOf("=");
		if (i < 0) continue;
		const rawKey = p.slice(0, i).trim().toLowerCase();
		let v = p.slice(i + 1).trim();
		if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
		const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(rawKey);
		if (!m || (m[2] === undefined && m[3] === undefined)) {
			params[rawKey] = decodeWords(v);
			continue;
		}
		// RFC 2231: name*=utf-8''a%20b, or name*0*=...; name*1=...
		const entry = (continued[m[1]] ??= { charset: "utf-8", parts: [] });
		const ext = m[3] !== undefined;
		const idx = Number(m[2] ?? 0);
		if (ext && idx === 0) {
			const lang = /^([^']*)'[^']*'(.*)$/.exec(v);
			if (lang) {
				entry.charset = lang[1] || "utf-8";
				v = lang[2];
			}
		}
		entry.parts[idx] = { ext, val: v };
	}
	for (const [name, c] of Object.entries(continued)) {
		const bytes = Buffer.concat(
			c.parts.filter(Boolean).map((x) =>
				x.ext ? Buffer.from(x.val.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1") : Buffer.from(x.val, "latin1"),
			),
		);
		params[name] = decodeBytes(bytes, c.charset);
	}
	return { value, params };
}

function decodeQuotedPrintable(buf) {
	const s = buf.toString("latin1").replace(/=\r?\n/g, "");
	const out = [];
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
			out.push(parseInt(s.slice(i + 1, i + 3), 16));
			i += 2;
		} else out.push(s.charCodeAt(i) & 0xff);
	}
	return Buffer.from(out);
}

function decodeTransfer(body, encoding) {
	const e = String(encoding ?? "").trim().toLowerCase();
	if (e === "base64") return Buffer.from(body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
	if (e === "quoted-printable") return decodeQuotedPrintable(body);
	return body;
}

function splitMultipart(body, boundary) {
	const parts = [];
	const delim = Buffer.from(`--${boundary}`);
	let pos = body.indexOf(delim);
	while (pos >= 0) {
		let start = pos + delim.length;
		if (body.subarray(start, start + 2).toString() === "--") break; // closing delimiter
		const eol = body.indexOf("\n", start);
		if (eol < 0) break;
		start = eol + 1;
		const next = body.indexOf(delim, start);
		if (next < 0) {
			parts.push(body.subarray(start));
			break;
		}
		// The CRLF before the delimiter belongs to the delimiter.
		let end = next;
		if (body[end - 1] === 0x0a) end--;
		if (body[end - 1] === 0x0d) end--;
		parts.push(body.subarray(start, end));
		pos = next;
	}
	return parts;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Readable text from an HTML email: block elements become line breaks, tables become tab-separated rows. */
export function htmlToText(html) {
	return String(html)
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(td|th)\s*>/gi, "\t")
		.replace(/<\/(p|div|tr|li|h[1-6]|section|article|header|footer)\s*>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&(#x?[0-9a-f]+|[a-z]+[0-9]*);/gi, (m, e) => {
			const k = e.toLowerCase();
			if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
			if (k.startsWith("#") && k !== "#39") return String.fromCodePoint(Number(k.slice(1)));
			return ENTITIES[k] ?? m;
		})
		.replace(/[ \t ]+/g, (s) => (s.includes("\t") ? "\t" : " "))
		.replace(/[ \t]*\n[ \t]*/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function walk(buf, out, depth) {
	if (depth > 10) return;
	const [rawHeaders, rawBody] = splitHeaderBody(buf);
	const h = parseHeaders(rawHeaders);
	const ct = parseParams(h.get("content-type")?.[0] ?? "text/plain");
	const disp = parseParams(h.get("content-disposition")?.[0] ?? "");
	const body = decodeTransfer(rawBody, h.get("content-transfer-encoding")?.[0]);
	if (ct.value.startsWith("multipart/") && ct.params.boundary) {
		for (const part of splitMultipart(rawBody, ct.params.boundary)) walk(part, out, depth + 1);
		return;
	}
	if (ct.value === "message/rfc822") {
		walk(body, out, depth + 1);
		return;
	}
	const filename = disp.params.filename || ct.params.name || "";
	const isAttachment = disp.value === "attachment" || (filename !== "" && !ct.value.startsWith("text/"));
	if (!isAttachment && ct.value === "text/plain" && out.text === "") out.text = decodeBytes(body, ct.params.charset);
	else if (!isAttachment && ct.value === "text/html" && out.html === "") out.html = decodeBytes(body, ct.params.charset);
	else if (isAttachment || !ct.value.startsWith("text/")) {
		let contentType = ct.value;
		if ((contentType === "application/octet-stream" || contentType === "") && /\.pdf$/i.test(filename)) contentType = "application/pdf";
		out.attachments.push({ filename, contentType, data: body });
	}
}

export function parseEmail(buf) {
	const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	const [rawHeaders] = splitHeaderBody(b);
	const h = parseHeaders(rawHeaders);
	const out = { text: "", html: "", attachments: [] };
	walk(b, out, 0);
	const date = new Date(h.get("date")?.[0] ?? "");
	return {
		subject: decodeWords(h.get("subject")?.[0] ?? ""),
		from: decodeWords(h.get("from")?.[0] ?? ""),
		date: Number.isNaN(date.getTime()) ? null : date,
		messageId: (h.get("message-id")?.[0] ?? "").replace(/[<>\s]/g, "") || null,
		text: out.text.trim() !== "" ? out.text.replace(/\r\n/g, "\n").trim() : htmlToText(out.html),
		html: out.html,
		attachments: out.attachments,
	};
}
