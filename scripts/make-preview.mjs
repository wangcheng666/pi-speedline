/**
 * Generate the pi.dev/packages gallery preview image for pi-speedline.
 * Zero dependencies: minimal PNG encoder + hand-rolled 5x7 bitmap font.
 *
 * Usage: node scripts/make-preview.mjs  →  dist/preview.png
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Minimal PNG encoder ─────────────────────────────────────────────────
const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();
function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0; // filter: none
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	return Buffer.concat([
		sig,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ── 5x7 bitmap font (rows as 5-bit values, MSB = left) ──────────────────
const FONT = {
	" ": [0, 0, 0, 0, 0, 0, 0],
	a: [0, 0, 0x0e, 0x01, 0x0f, 0x11, 0x0f],
	c: [0, 0, 0x0e, 0x10, 0x10, 0x11, 0x0e],
	d: [0x01, 0x01, 0x09, 0x13, 0x15, 0x13, 0x09],
	e: [0, 0x0e, 0x11, 0x1f, 0x10, 0x11, 0x0e],
	f: [0x06, 0x09, 0x08, 0x1e, 0x08, 0x08, 0x08],
	i: [0x04, 0, 0x0c, 0x04, 0x04, 0x04, 0x0e],
	l: [0x0c, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
	m: [0, 0, 0x1a, 0x15, 0x15, 0x11, 0x11],
	n: [0, 0, 0x16, 0x19, 0x11, 0x11, 0x11],
	o: [0, 0, 0x0e, 0x11, 0x11, 0x11, 0x0e],
	p: [0, 0, 0x1e, 0x11, 0x0e, 0x10, 0x10],
	r: [0, 0, 0x16, 0x19, 0x10, 0x10, 0x10],
	s: [0, 0, 0x0f, 0x10, 0x0e, 0x01, 0x1e],
	t: [0x04, 0x04, 0x1e, 0x04, 0x04, 0x04, 0x0e],
	u: [0, 0, 0x11, 0x11, 0x11, 0x0b, 0x06],
	v: [0, 0, 0x11, 0x11, 0x11, 0x0a, 0x04],
	w: [0x04, 0x04, 0x0a, 0x0a, 0x0a, 0x15, 0],
	x: [0, 0, 0x11, 0x0a, 0x04, 0x0a, 0x11],
	T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
	F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
	Q: [0x0e, 0x11, 0x11, 0x11, 0x13, 0x0d, 0x02],
	"0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
	"1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
	"2": [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
	"3": [0x0e, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0e],
	"4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
	"5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
	"6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
	"7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
	"8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
	"9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
	".": [0, 0, 0, 0, 0, 0x04, 0x04],
	"/": [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
	"-": [0, 0, 0, 0x0e, 0, 0, 0],
	"·": [0, 0, 0, 0x04, 0x04, 0, 0],
	"⚡": [0x0e, 0x06, 0x06, 0x0f, 0x02, 0x06, 0x04], // custom bolt
	"~": [0, 0, 0x0c, 0x03, 0x0c, 0, 0],
	"↓": [0x04, 0x0e, 0x15, 0x04, 0x04, 0x04, 0x0e], // custom down arrow
};

// ── Canvas helpers ──────────────────────────────────────────────────────
const W = 960;
const H = 320;
const px = Buffer.alloc(W * H * 4);
const setPx = (x, y, [r, g, b]) => {
	x = Math.round(x);
	y = Math.round(y);
	if (x < 0 || y < 0 || x >= W || y >= H) return;
	const o = (y * W + x) * 4;
	px[o] = r;
	px[o + 1] = g;
	px[o + 2] = b;
	px[o + 3] = 255;
};
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const fillRect = (x, y, w, h, c) => {
	for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) setPx(x + i, y + j, c);
};
const fillTri = (x, y, h, w, c) => {
	// right-pointing powerline chevron: apex at right-middle
	for (let j = 0; j < h; j++) {
		const t = j / (h - 1); // 0..1 top→bottom
		const reach = Math.abs(1 - 2 * t) * w; // triangle width at this row
		for (let i = 0; i < Math.ceil(reach); i++) setPx(x + w - 1 - i, y + j, c);
	}
};
const drawGlyph = (g, x, y, s, c) => {
	for (let row = 0; row < 7; row++) {
		const bits = g[row];
		for (let col = 0; col < 5; col++) {
			if (bits & (0x10 >> col)) {
				fillRect(x + col * s, y + row * s, s, s, c);
			}
		}
	}
};
const ADV = (s) => 6 * s; // 5 cols glyph + 1 col space
const drawText = (text, x, y, s, c, bold = false) => {
	let cx = x;
	for (const ch of text) {
		const g = FONT[ch];
		if (g) {
			drawGlyph(g, cx, y, s, c);
			if (bold) drawGlyph(g, cx + 2, y, s, c); // pseudo-bold (2px offset)
		}
		cx += ADV(s);
	}
	return cx;
};
const textW = (text, s) => [...text].length * ADV(s);

// ── Composition ─────────────────────────────────────────────────────────
const BG = hex("#14151a");
const C_GOLD = hex("#e3ba6e");
const C_JADE = hex("#4ec7a6");
const C_SAND = hex("#a29586");
const C_ORANGE = hex("#e8934a");
const C_DIM = hex("#6f7488");
const C_TEXT = hex("#8b8fa8");
const S1_BG = hex("#262a36");
const S2_BG = hex("#1f222c");
const S3_BG = hex("#171a21");

fillRect(0, 0, W, H, BG);

// title + subtitle
drawText("pi-speedline", 24, 26, 3, C_GOLD, true);
drawText("unified speedometer for pi", 24, 62, 2, C_DIM);

// speedline segment content (shared prefix), per-row variants
const SPEED_LIVE = [
	["⚡", C_ORANGE], [" ", null], ["TTFT 312ms", C_SAND], [" ", null],
	["↓128", C_GOLD], [" ", null], ["~42t/s", C_JADE],
];
const SPEED_FINAL = [
	["⚡", C_ORANGE], [" ", null], ["TTFT 312ms", C_SAND], [" ", null],
	["↓456", C_GOLD], [" ", null], ["78.9t/s", C_JADE],
];
const speedText = (parts) => parts.map((p) => p[0]).join("");

const S = 3; // segment text scale
const PADX = 20; // horizontal padding per segment
const CHEV = 14;
const BAR_H = 62;

function drawBar(y, model, ctxLabel, parts, rateBold) {
	const s1w = textW(model, S) + PADX * 2;
	const s2w = textW(ctxLabel, S) + PADX * 2;
	const s3w = textW(speedText(parts), S) + PADX * 2;
	let x = 24;
	const segs = [
		{ w: s1w, bg: S1_BG, text: model, color: C_TEXT, isSpeed: false },
		{ w: s2w, bg: S2_BG, text: ctxLabel, color: C_DIM, isSpeed: false },
		{ w: s3w, bg: S3_BG, text: null, color: null, isSpeed: true, parts },
	];
	// backgrounds
	for (const sg of segs) {
		fillRect(x, y, sg.w, BAR_H, sg.bg);
		x += sg.w;
	}
	const xs = [24, 24 + s1w, 24 + s1w + s2w];
	// chevrons: next segment's bg color, at right edge of current
	for (let i = 0; i < segs.length - 1; i++) {
		fillTri(xs[i] + segs[i].w - CHEV, y, BAR_H, CHEV, segs[i + 1].bg);
	}
	// text
	const ty = y + (BAR_H - 7 * S) / 2;
	drawText(segs[0].text, xs[0] + PADX, ty, S, segs[0].color);
	drawText(segs[1].text, xs[1] + PADX, ty, S, segs[1].color);
	let tx = xs[2] + PADX;
	for (const [str, color] of parts) {
		if (color) tx = drawText(str, tx, ty, S, color, rateBold && str.includes("t/s"));
		else tx += ADV(S) * [...str].length;
	}
}

// labels + two bars: live (estimate) and final (exact)
drawText("live", 24, 104, 2, C_DIM);
drawBar(124, "Qwen3.8", "ctx 78", SPEED_LIVE, true);
drawText("final", 24, 204, 2, C_DIM);
drawBar(224, "Qwen3.8", "ctx 78", SPEED_FINAL, true);

// ── Write ───────────────────────────────────────────────────────────────
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "preview.png");
writeFileSync(out, encodePng(W, H, px));
console.log("wrote", out, `${W}x${H}`);
