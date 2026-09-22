/**
 * pi-speedline — unified speedometer for the pi coding agent.
 *
 * Merges two extensions into ONE conflict-free status slot:
 *   - @gnoviawan/pi-tokens-per-second  (real-time live TPS while streaming)
 *   - @sugarforever/pi-throughput-meter (per-turn TTFT + exact throughput)
 *
 * Status lifecycle — ONE slot ("speed"), ONE layout in every phase
 * (icon · TTFT · ↓tokens · rate), timer-free → no stale-ctx crashes.
 * Stats are per ROUND (one user prompt's agent loop: agent_start →
 * agent_end) and span ALL its LLM calls — pi's "turn" is narrower (one
 * LLM call + its tool batch), so mid-round turn_start resets nothing.
 * The slot is ALWAYS occupied — no blank, no structure breaks:
 *   idle (no previous data)
 *                     ⚡ TTFT – ↓– –t/s                   (ghost fields)
 *   live (streaming)  ⚡ TTFT 312ms ↓128 ~42t/s           (live estimate)
 *   message done      ⚡ TTFT 312ms ↓456 78.9t/s          (exact so far)
 *                    — stays visible while that message's tools (bash)
 *                      run and across the gap until the round's next
 *                      LLM call streams (keep-last-display between
 *                      rounds, too);
 *   aborted round     ⚡ ↓83 interrupted                  (coral)
 *   round, no data    ⚡ TTFT – ↓– –t/s                   (coral ghost)
 * A new round never resets a previous round's display — its first
 * delta jumps straight to live numbers.
 *
 * Unified color rule: icon = accent (theme's orange, always); TTFT = warm
 * sand; ↓tokens = champagne gold; rate = soft jade (bold, the "money
 * number"); degraded states = terracotta. The palette follows the theme's
 * light/dark mode and falls back to 256 colors on terminals without
 * truecolor. "TTFT" is prefixed so the millisecond figure is self-
 * explanatory in the footer segment. No separate "streaming…"
 * placeholder — the first token immediately shows live numbers.
 *
 * Tilde semantics: only the live RATE carries ~ (rolling-window estimate).
 * The live token counter is shown plain — it is a calibrated estimate that
 * converges to the exact usage.output value after one round.
 *
 * How the numbers line up (live estimate vs final exact value):
 *   - Each delta's characters are split into CJK and latin buckets and
 *     converted to tokens with per-class chars-per-token priors:
 *     CJK ≈ 1.6, latin ≈ 3.8. (A typical Qwen-style reply — english
 *     thinking + chinese answer — is thus estimated per content class,
 *     not with one blended ratio.)
 *   - Two correction factors (k_cjk, k_latin) are calibrated from real
 *     usage.output after each message: the dominant content class is
 *     updated from the residual (total minus the other class's estimate),
 *     so the thinking:answer ratio flipping between messages does NOT
 *     drag one class's factor with the other's.
 *   - Live rate = token-weighted rolling 2s window (marked with ~).
 *   - Final rate = EXACT round output tokens (usage.output, includes
 *     thinking and tool-call tokens) ÷ PURE streaming time (sum of each
 *     message's first→last delta span; tool runs and inter-call gaps
 *     are excluded). text, thinking AND toolcall deltas are all counted,
 *     matching what usage.output covers.
 *   - TTFT = request dispatch (first before_provider_request of the
 *     round) → first token. Local pre-request pipeline time (extension
 *     hooks, compaction) is deliberately excluded — it is not "waiting
 *     for the model". (pi's assistant message_start fires at the first
 *     SSE event ≈ the first token, so it cannot serve as the anchor.)
 *
 * Command:
 *   /tps   toggle the status display on/off
 */
import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";

// ── Tunables ────────────────────────────────────────────────────────────
const STATUS_KEY = "speed";
const ICON = "⚡";
const ROLLING_WINDOW_MS = 2000; // live-rate window
const MIN_WINDOW_SPAN_MS = 150; // below this, fall back to whole-message rate
const RENDER_THROTTLE_MS = 200; // max status redraw frequency while streaming
const CPT_CJK = 1.6; // chars per token for CJK content (Qwen-class ≈1.5–2.0)
const CPT_LATIN = 3.8; // chars per token for latin/code content
const K_EMA_ALPHA = 0.5; // calibration adaptation speed (0..1]
const K_DOMINANCE = 2.0; // a class must be ≥2× the other to calibrate alone

// ── Palette ────────────────────────────────────────────────────────────
// "Amber & jade" — curated to complement a warm orange ⚡ accent:
//   gold  — token count (warm champagne, same family as the icon, soft)
//   jade  — rate (cool counterpoint; the "money number", bold, eye-catching
//           but not neon)
//   sand  — TTFT meta (warm neutral, recedes)
//   coral — degraded states (terracotta, in-family but clearly a signal)
// The active set follows the theme's light/dark mode (detected from the
// resolved "text" color), with a 256-color fallback for terminals without
// truecolor. Ghost variants (55%) are used for skeleton placeholders.
type Field = "gold" | "jade" | "sand" | "coral";

const DARK_PAL: Record<Field, [number, number, number]> = {
	gold: [227, 186, 110],
	jade: [78, 199, 166],
	sand: [162, 149, 134],
	coral: [217, 126, 85],
};
const LIGHT_PAL: Record<Field, [number, number, number]> = {
	gold: [166, 120, 42],
	jade: [23, 132, 104],
	sand: [106, 94, 79],
	coral: [176, 82, 36],
};
const GHOST = 0.55;

let paintCache: {
	key: string;
	paint: (f: Field, t: string, opts?: { ghost?: boolean; bold?: boolean }) => string;
} | null = null;

function rgb256ToRgb(n: number): [number, number, number] {
	if (n < 16) {
		const base: [number, number, number][] = [
			[0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238],
			[205, 0, 205], [0, 205, 205], [229, 229, 229], [127, 127, 127],
			[255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255],
			[0, 255, 255], [255, 255, 255],
		];
		return base[n]!;
	}
	if (n < 232) {
		const v = n - 16;
		const ch = (x: number) => (x === 0 ? 0 : 55 + x * 40);
		return [ch((v / 36) | 0), ch(((v / 6) | 0) % 6), ch(v % 6)];
	}
	const g = (n - 232) * 10 + 8;
	return [g, g, g] as [number, number, number];
}

function nearest256([r, g, b]: [number, number, number]): number {
	let best = 0;
	let bestD = Infinity;
	for (let n = 0; n < 256; n++) {
		const [cr, cg, cb] = rgb256ToRgb(n);
		const d = (cr - r) ** 2 * 2 + (cg - g) ** 2 * 4 + (cb - b) ** 2 * 3;
		if (d < bestD) {
			bestD = d;
			best = n;
		}
	}
	return best;
}

function parseFgAnsi(ansi: string): [number, number, number] | null {
	const m24 = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (m24) return [+m24[1]!, +m24[2]!, +m24[3]!];
	const m256 = ansi.match(/\x1b\[38;5;(\d+)m/);
	if (m256) return rgb256ToRgb(+m256[1]!);
	return null;
}

function getPaint(theme: SpeedCtx["ui"]["theme"]) {
	const ansi = typeof theme.getFgAnsi === "function" ? theme.getFgAnsi("text") : "";
	const mode = typeof theme.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	const key = `${ansi}|${mode}`;
	if (paintCache?.key === key) return paintCache.paint;
	const textRgb = parseFgAnsi(ansi);
	// Bright text color ⇒ dark terminal background ⇒ dark palette (and vice versa).
	const lum = textRgb
		? (0.2126 * textRgb[0] + 0.7152 * textRgb[1] + 0.0722 * textRgb[2]) / 255
		: 0;
	const pal = lum > 0.5 ? DARK_PAL : LIGHT_PAL;
	const to256 = mode !== "truecolor";
	const codeCache: Record<string, string> = {};
	const codeFor = (rgb: [number, number, number]) => {
		const k = rgb.join(",");
		if (!codeCache[k]) codeCache[k] = to256 ? `38;5;${nearest256(rgb)}` : `38;2;${rgb.join(";")}`;
		return codeCache[k]!;
	};
	const paint: (f: Field, t: string, opts?: { ghost?: boolean; bold?: boolean }) => string = (f, t, opts) => {
		const rgb = pal[f]!;
		const out: [number, number, number] = opts?.ghost
			? [Math.round(rgb[0] * GHOST), Math.round(rgb[1] * GHOST), Math.round(rgb[2] * GHOST)]
			: rgb;
		const bold = opts?.bold ? "\x1b[1m" : "";
		return `${bold}\x1b[${codeFor(out)}m${t}\x1b[0m${bold ? "\x1b[22m" : ""}`;
	};
	paintCache = { key, paint };
	return paint;
}

// ── Minimal structural ctx type (keeps helpers decoupled) ──────────────
interface SpeedCtx {
	hasUI: boolean;
	ui: {
		setStatus: (key: string, text: string) => void;
		notify: (text: string, level?: "info" | "warning" | "error") => void;
		theme: {
			fg: (color: ThemeColor, text: string) => string;
			getFgAnsi?: (color: ThemeColor) => string;
			getColorMode?: () => "truecolor" | "256color";
		};
	};
}

// ── State (plain data only; reset on session boundaries) ───────────────
let displayEnabled = true;

// calibration — PER-CLASS factors (thinking is usually english, answer often
// chinese; one global factor chases the thinking:answer ratio instead of
// converging). Reset on session boundary.
let kCjk = 1; // correction for CJK content
let kLatin = 1; // correction for latin/code content
let hasCalCjk = false;
let hasCalLatin = false;

// per-round (one user prompt's agent loop: agent_start … agent_end).
// NOTE: pi's "turn" is NARROWER — agent-loop.js emits turn_start/turn_end
// around EACH LLM call + its tool batch, so one round may contain several
// turns. All stats below span the whole round and must never be reset on
// turn_start (that would wipe mid-round state between calls).
let roundRequestAt: number | undefined; // first before_provider_request of the round — TTFT anchor
let roundMsgStartAt: number | undefined; // first assistant message_start (fallback only; pi
// fires it at the FIRST SSE event, i.e. ≈ the first token — never use it as a TTFT anchor)
let roundFirstDeltaAt: number | undefined;
let roundLastDeltaAt: number | undefined;
let roundOutputTokens = 0; // Σ usage.output of the round's assistant messages
let roundStreamSpanMs = 0; // Σ (lastDelta - firstDelta) per message — pure streaming time
let roundSawMsgEnd = false;
let roundActive = false;
let lastCompleted = true; // outcome of the most recent agent_end (for /tps restore)

// per-message (current streaming message)
let msgEstCJK = 0; // CJK chars / CPT_CJK so far in this message
let msgEstLatin = 0; // latin chars / CPT_LATIN so far in this message
let msgFirstDeltaAt: number | undefined;
let msgLastDeltaAt: number | undefined;
let msgEvents: { t: number; estCJK: number; estLatin: number }[] = [];
let lastRenderAt = 0;

function resetRound() {
	roundRequestAt = undefined;
	roundMsgStartAt = undefined;
	roundFirstDeltaAt = undefined;
	roundLastDeltaAt = undefined;
	roundOutputTokens = 0;
	roundStreamSpanMs = 0;
	roundSawMsgEnd = false;
	lastRenderAt = 0; // first live render fires immediately
	resetMessage();
}

function hasRoundData(): boolean {
	return (
		roundOutputTokens > 0 &&
		roundFirstDeltaAt !== undefined &&
		roundLastDeltaAt !== undefined
	);
}

/**
 * TTFT anchor: when the round's first provider request went out.
 * pi's assistant message_start fires at the FIRST SSE event (≈ the first
 * token itself), so it is only a fallback, never the primary anchor.
 */
function ttftAnchor(): number | undefined {
	return roundRequestAt ?? roundMsgStartAt;
}

function resetMessage() {
	msgEstCJK = 0;
	msgEstLatin = 0;
	msgFirstDeltaAt = undefined;
	msgLastDeltaAt = undefined;
	msgEvents.length = 0;
}

function resetAll() {
	kCjk = 1;
	kLatin = 1;
	hasCalCjk = false;
	hasCalLatin = false;
	roundActive = false;
	lastCompleted = true;
	roundRequestAt = undefined;
	roundMsgStartAt = undefined;
	roundFirstDeltaAt = undefined;
	roundLastDeltaAt = undefined;
	roundOutputTokens = 0;
	roundStreamSpanMs = 0;
	roundSawMsgEnd = false;
	resetMessage();
	lastRenderAt = 0;
}

// ── Math ────────────────────────────────────────────────────────────────
function isCjk(cp: number): boolean {
	return (
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
		(cp >= 0x3040 && cp <= 0x30ff) || // kana
		(cp >= 0xac00 && cp <= 0xd7af) // hangul
	);
}

/** Count CJK characters in a string. */
function countCjk(s: string): number {
	let cjk = 0;
	for (const ch of s) {
		if (isCjk(ch.codePointAt(0)!)) cjk++;
	}
	return cjk;
}

/** Estimated tokens for the current message, corrected per class. */
function estTokens(): number {
	return msgEstCJK * kCjk + msgEstLatin * kLatin;
}

/** Token-weighted rolling-window TPS estimate for the current message. */
function rollingTps(now: number): number | null {
	const cutoff = now - ROLLING_WINDOW_MS;
	while (msgEvents.length > 0 && msgEvents[0]!.t < cutoff) msgEvents.shift();

	const spanMs =
		msgEvents.length >= 2 ? msgEvents[msgEvents.length - 1]!.t - msgEvents[0]!.t : 0;
	if (spanMs >= MIN_WINDOW_SPAN_MS) {
		let tok = 0;
		for (const e of msgEvents) tok += e.estCJK * kCjk + e.estLatin * kLatin;
		return tok / (spanMs / 1000);
	}
	// Window too short → whole-message average rate instead
	if (msgFirstDeltaAt !== undefined && msgLastDeltaAt !== undefined) {
		const s = msgLastDeltaAt - msgFirstDeltaAt;
		if (s > 0) return estTokens() / (s / 1000);
	}
	return null;
}

/**
 * Calibrate the per-class correction factors from a finished message's
 * real usage.output. The message total is one equation; when one class
 * dominates (≥2×), the other class's corrected estimate is subtracted as
 * a residual, giving an unbiased update for the dominant class.
 * Balanced messages update both with the total ratio.
 */
function blendK(cur: number, raw: number, has: boolean): number {
	if (!Number.isFinite(raw) || raw <= 0.05 || raw >= 20) return cur;
	return has ? cur * (1 - K_EMA_ALPHA) + raw * K_EMA_ALPHA : raw;
}

function calibrate(realOutputTokens: number) {
	if (realOutputTokens <= 0) return;
	const eC = msgEstCJK;
	const eL = msgEstLatin;
	if (eC <= 0 && eL <= 0) return;
	const corrC = eC * kCjk;
	const corrL = eL * kLatin;
	if (eC <= 0) {
		kLatin = blendK(kLatin, realOutputTokens / eL, hasCalLatin);
		hasCalLatin = true;
		return;
	}
	if (eL <= 0) {
		kCjk = blendK(kCjk, realOutputTokens / eC, hasCalCjk);
		hasCalCjk = true;
		return;
	}
	if (corrC >= K_DOMINANCE * corrL) {
		const res = realOutputTokens - corrL;
		if (res > 0) {
			kCjk = blendK(kCjk, res / eC, hasCalCjk);
			hasCalCjk = true;
		}
	} else if (corrL >= K_DOMINANCE * corrC) {
		const res = realOutputTokens - corrC;
		if (res > 0) {
			kLatin = blendK(kLatin, res / eL, hasCalLatin);
			hasCalLatin = true;
		}
	} else {
		// Balanced message: the total only confirms the AVERAGE error. If
		// both factors are already good (total within 10%), do nothing —
		// pushing both toward the total ratio would de-calibrate the
		// individual factors. Otherwise re-seed both (stale-factor recovery,
		// e.g. after a model/provider switch).
		const total = corrC + corrL;
		const drift = Math.abs(total - realOutputTokens) / total;
		if (drift >= 0.1) {
			const kt = realOutputTokens / total;
			kCjk = blendK(kCjk, kt, hasCalCjk);
			hasCalCjk = true;
			kLatin = blendK(kLatin, kt, hasCalLatin);
			hasCalLatin = true;
		}
	}
}

// ── Rendering (all UI writes happen inside event handlers — never a timer) ──
function iconOf(ctx: SpeedCtx): string {
	return ctx.ui.theme.fg("accent", ICON);
}

/** Full field skeleton for states without data (idle / waiting / no-data turn). */
function renderSkeleton(ctx: SpeedCtx, warn: boolean) {
	if (!displayEnabled || !ctx.hasUI) return;
	const paint = getPaint(ctx.ui.theme);
	const body = warn
		? paint("coral", "TTFT – ↓– –t/s", { ghost: true })
		: `${paint("sand", "TTFT –", { ghost: true })} ${paint("gold", "↓–", { ghost: true })} ${paint("jade", "–t/s", { ghost: true })}`;
	ctx.ui.setStatus(STATUS_KEY, `${iconOf(ctx)} ${body}`);
}

function renderWaiting(ctx: SpeedCtx) {
	renderSkeleton(ctx, false);
}

function renderLive(ctx: SpeedCtx, now: number) {
	if (!displayEnabled || !ctx.hasUI || roundFirstDeltaAt === undefined) return;
	if (now - lastRenderAt < RENDER_THROTTLE_MS) return;
	lastRenderAt = now;
	const paint = getPaint(ctx.ui.theme);
	// TTFT = request dispatch (first assistant message_start) → first
	// token. Local pre-request pipeline time (extension hooks, compaction
	// etc.) is deliberately excluded — it is not "waiting for the model".
	const anchor = ttftAnchor();
	const ttft =
		anchor !== undefined
			? paint("sand", `TTFT ${roundFirstDeltaAt - anchor}ms`)
			: paint("sand", "TTFT –", { ghost: true });
	// Tokens = completed messages of the round + current message estimate
	// (no mid-round reset, so the count only ever climbs within a round).
	const tok = paint("gold", `↓${Math.max(1, Math.round(roundOutputTokens + estTokens()))}`);
	const tps = rollingTps(now);
	const rate =
		tps !== null
			? paint("jade", `~${Math.round(tps)}t/s`, { bold: true })
			: paint("jade", "–t/s", { ghost: true });
	ctx.ui.setStatus(STATUS_KEY, `${iconOf(ctx)} ${ttft} ${tok} ${rate}`);
}

function renderFinal(ctx: SpeedCtx, completed: boolean) {
	if (!displayEnabled || !ctx.hasUI) return;
	const paint = getPaint(ctx.ui.theme);

	if (!completed) {
		// Aborted/error round: show what we have (estimate if no usage yet)
		const est = Math.round(estTokens());
		const tok =
			roundOutputTokens > 0
				? paint("gold", `↓${roundOutputTokens}`)
				: est > 0
					? paint("gold", `↓${est}`)
					: null;
		if (tok === null) {
			renderSkeleton(ctx, true); // aborted before any token: warn skeleton
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, `${iconOf(ctx)} ${tok} ${paint("coral", "interrupted")}`);
		return;
	}

	// Final rate = exact round tokens ÷ pure streaming time (sum of each
	// message's first→last delta span; tool execution and inter-call gaps
	// are excluded, matching what the live rate measures).
	const anchor = ttftAnchor();
	const ttft =
		roundFirstDeltaAt !== undefined && anchor !== undefined
			? paint("sand", `TTFT ${roundFirstDeltaAt - anchor}ms`)
			: paint("sand", "TTFT –", { ghost: true });
	const tok = paint("gold", `↓${roundOutputTokens}`);
	const rate =
		roundStreamSpanMs > 0
			? paint("jade", `${(roundOutputTokens / (roundStreamSpanMs / 1000)).toFixed(1)}t/s`, { bold: true })
			: paint("jade", "–t/s", { ghost: true });
	if (roundOutputTokens > 0) {
		ctx.ui.setStatus(STATUS_KEY, `${iconOf(ctx)} ${ttft} ${tok} ${rate}`);
		return;
	}
	renderSkeleton(ctx, true);
}

// ── Extension ───────────────────────────────────────────────────────────
export default function piSpeedline(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		resetAll();
		renderWaiting(ctx); // keep the slot occupied from the very start
	});

	pi.on("session_shutdown", async () => {
		resetAll();
	});

	// A round = one user prompt's agent loop (agent_start … agent_end).
	// pi's "turn" is narrower (each LLM call + its tool batch), so rounds
	// are NOT reset on turn_start — that would wipe stats mid-round
	// between calls. (Verified against pi 0.87.0's agent-loop.js.)
	pi.on("agent_start", async (_event, ctx) => {
		// Keep the previous round's final display on screen; the first
		// delta of the new round jumps straight to live. The skeleton is
		// only shown when there is NO previous data to keep (fresh
		// session, or a zero-output previous round).
		const hadPreviousData = hasRoundData();
		resetRound();
		roundActive = true;
		if (!hadPreviousData) renderWaiting(ctx);
	});

	// TTFT anchor: before_provider_request fires right before the HTTP
	// request goes out. (pi's assistant message_start fires at the FIRST
	// SSE event — ≈ the first token — so it cannot measure TTFT.)
	pi.on("before_provider_request", async () => {
		if (roundRequestAt === undefined) roundRequestAt = Date.now();
	});

	pi.on("message_start", async (event) => {
		if (event.message?.role !== "assistant") return;
		if (roundMsgStartAt === undefined) roundMsgStartAt = Date.now();
		resetMessage();
	});

	pi.on("message_update", async (event, ctx) => {
		const ev = event.assistantMessageEvent;
		if (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta") {
			return;
		}
		const now = Date.now();
		const cjk = countCjk(ev.delta);
		const estCJK = cjk / CPT_CJK;
		const estLatin = (ev.delta.length - cjk) / CPT_LATIN;
		msgEstCJK += estCJK;
		msgEstLatin += estLatin;
		if (msgFirstDeltaAt === undefined) msgFirstDeltaAt = now;
		msgLastDeltaAt = now;
		if (roundFirstDeltaAt === undefined) roundFirstDeltaAt = now;
		roundLastDeltaAt = now;
		msgEvents.push({ t: now, estCJK, estLatin });
		renderLive(ctx, now);
	});

	pi.on("message_end", async (event, ctx) => {
		const m = event.message;
		if (m?.role !== "assistant") return;
		if (msgFirstDeltaAt !== undefined && msgLastDeltaAt !== undefined) {
			// Accumulate this message's pure streaming time (tool runs and
			// inter-call gaps stay out of the final rate).
			roundStreamSpanMs += msgLastDeltaAt - msgFirstDeltaAt;
		}
		const out = m.usage?.output ?? 0;
		if (out > 0) {
			roundOutputTokens += out;
			roundSawMsgEnd = true;
			calibrate(out);
		}
		// As soon as a message completes normally we have exact stats for
		// everything streamed so far. Render the exact line NOW — it then
		// stays on screen during the message's tool execution (bash) and
		// across the gap until the round's next LLM call, instead of
		// showing a frozen live estimate.
		if (m.stopReason === "stop" || m.stopReason === "length" || m.stopReason === "toolUse") {
			renderFinal(ctx, true);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		// The round is over. Interrupted = the round's last assistant
		// message ended in "aborted"/"error" (or no assistant message at
		// all).
		const msgs = (event.messages ?? []) as any[];
		let lastStop: string | undefined;
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i]!.role === "assistant") {
				lastStop = msgs[i]!.stopReason;
				// Aborted round: message_end may never have fired — fall
				// back to whatever usage the final message carries.
				if (!roundSawMsgEnd && msgs[i]!.usage?.output) {
					roundOutputTokens += msgs[i]!.usage.output;
				}
				break;
			}
		}
		const completed = lastStop === "stop" || lastStop === "length" || lastStop === "toolUse";
		renderFinal(ctx, completed);
		roundActive = false;
		lastCompleted = completed;
	});

	pi.registerCommand("tps", {
		description: "Toggle the speedline status display on/off",
		handler: async (_args, ctx) => {
			displayEnabled = !displayEnabled;
			if (!displayEnabled) {
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "");
				ctx.ui.notify("speedline: OFF", "info");
			} else {
				if (ctx.hasUI) {
					// Restore the display to the current state
					if (roundActive) {
						if (roundFirstDeltaAt !== undefined) {
							lastRenderAt = 0; // bypass throttle
							renderLive(ctx, Date.now());
						} else {
							renderWaiting(ctx);
						}
					} else if (hasRoundData()) {
						renderFinal(ctx, lastCompleted);
					} else {
						renderWaiting(ctx);
					}
				}
				ctx.ui.notify("speedline: ON", "info");
			}
		},
	});
}
