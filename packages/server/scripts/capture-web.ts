// Download the real FMS Angular web UI (shell + JS/CSS bundles + lazy chunks + assets) so we can
// serve a real-looking /FieldMonitor and read how the UI / report viewer work. Pure GET only.
//
//   bun run scripts/capture-web.ts <host> <outDir>

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HOST = process.argv[2] ?? "192.168.0.129";
const OUT = join(process.argv[3] ?? "./fms-capture", "web");
mkdirSync(OUT, { recursive: true });

const seen = new Set<string>();
const queue: string[] = ["/", "/index.html", "/styles.css", "/polyfills.js", "/scripts.js", "/main.js", "/runtime.js"];

function save(path: string, body: Uint8Array): void {
	const clean = path.split("?")[0]!.replace(/^\//, "") || "index.html";
	const full = join(OUT, clean);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body);
}

function extractRefs(text: string): string[] {
	const refs = new Set<string>();
	// Quoted asset paths and Angular hashed chunk filenames.
	for (const m of text.matchAll(/["'`(]\s*(\/?[\w./-]+\.(?:js|css|svg|png|jpe?g|gif|ico|woff2?|ttf|json))\b/g)) {
		refs.add(m[1] as string);
	}
	for (const m of text.matchAll(/\b(\d+\.[A-Za-z0-9]+\.js|chunk-[A-Za-z0-9]+\.js|\d+\.js)\b/g)) {
		refs.add(m[1] as string);
	}
	return [...refs];
}

function norm(ref: string): string | null {
	if (!ref) return null;
	if (/^https?:\/\//.test(ref) && !ref.includes(HOST)) return null; // external
	let p = ref.replace(/^https?:\/\/[^/]+/, "");
	if (!p.startsWith("/")) p = "/" + p;
	if (p.startsWith("/api/") || p.includes("negotiate")) return null;
	return p;
}

async function main(): Promise<void> {
	let count = 0;
	while (queue.length && count < 400) {
		const path = queue.shift()!;
		const key = path.split("?")[0]!;
		if (seen.has(key)) continue;
		seen.add(key);
		let res: Response;
		try {
			res = await fetch(`http://${HOST}${path}`);
		} catch {
			continue;
		}
		if (!res.ok) continue;
		const buf = new Uint8Array(await res.arrayBuffer());
		save(path, buf);
		count++;
		const ctype = res.headers.get("content-type") ?? "";
		if (/javascript|css|html|json/.test(ctype) || /\.(js|css|html|json)$/.test(key)) {
			const text = new TextDecoder().decode(buf);
			for (const ref of extractRefs(text)) {
				const n = norm(ref);
				if (n && !seen.has(n.split("?")[0]!)) queue.push(n);
			}
		}
	}
	console.log(`Saved ${count} web files to ${OUT}`);
}

void main();
