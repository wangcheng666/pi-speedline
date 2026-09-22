/**
 * Event-sequence simulation for pi-speedline.
 *
 * Self-consistent tokenization world:
 *   CJK  = 2.0 chars/token  (Qwen-class chinese)
 *   latin = 4.0 chars/token (english thinking / code)
 *
 * Verifies: dual-class calibration (k_cjk / k_latin), the realistic
 * "english thinking + chinese answer" pattern, and — the key case —
 * the thinking:answer ratio FLIPPING between messages, which a single
 * global factor cannot track.
 *
 * Run: node --experimental-strip-types test/sim.mts
 */
import piSpeedline from "../extensions/index.ts";

type Handler = (event: any, ctx: any) => void | Promise<void>;
const handlers: Record<string, Handler> = {};
const commands: Record<string, any> = {};
const pi: any = {
	on: (ev: string, h: Handler) => {
		handlers[ev] = h;
	},
	registerCommand: (name: string, def: any) => {
		commands[name] = def;
	},
};
piSpeedline(pi);

let lastStatus: string | null = null;
const plain = (s: string | null) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const ctx: any = {
	hasUI: true,
	ui: {
		setStatus: (k: string, t: string) => {
			lastStatus = t;
		},
		notify: (t: string) => console.log("  notify:", t),
		// bright text color ⇒ simulated dark terminal background
		theme: {
			fg: (_c: string, t: string) => t,
			getFgAnsi: () => "\x1b[38;2;212;212;212m",
			getColorMode: () => "truecolor",
		},
	},
};

const emit = (ev: string, event: any) => handlers[ev]?.(event, ctx);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (s: string | null) => plain(s);

const mkAssistant = (output = 0, stopReason = "stop") => ({
	role: "assistant",
	content: [],
	stopReason,
	usage: { input: 100, output, cacheRead: 0, cacheWrite: 0, totalTokens: 100 + output },
});

/**
 * Simulate one LLM turn made of `thinking` latin deltas ("abcd", 4 chars =
 * 1 token) followed by `answer` CJK deltas ("汉字", 2 chars = 1 token),
 * spaced `stepMs` apart, ending with real usage = thinking + answer tokens.
 */
async function simulateTurn(label: string, thinking: number, answer: number, stepMs: number) {
	await emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
	const waiting = lastStatus;
	await emit("message_start", { message: mkAssistant() });
	for (let i = 0; i < thinking; i++) {
		await new Promise((r) => setTimeout(r, stepMs));
		await emit("message_update", {
			message: mkAssistant(),
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "abcd", partial: {} },
		});
	}
	for (let i = 0; i < answer; i++) {
		await new Promise((r) => setTimeout(r, stepMs));
		await emit("message_update", {
			message: mkAssistant(),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "汉字", partial: {} },
		});
	}
	const live = lastStatus;
	const real = thinking + answer;
	await emit("message_end", { message: mkAssistant(real, "toolUse") });
	const duringTools = lastStatus; // this is what stays on screen while bash runs
	await emit("turn_end", { turnIndex: 1, message: mkAssistant(real), outcome: "completed", toolResults: [] });
	console.log(
		`[${label}] thk:${String(thinking).padStart(3)} ans:${String(answer).padStart(3)} | live: ${show(live).padEnd(24)} | during-tools: ${show(duringTools).padEnd(24)} | final: ${show(lastStatus)}`,
	);
	return { live, duringTools, final: lastStatus };
}

console.log("=== pi-speedline simulation (world: CJK 2.0 ch/tok, latin 4.0 ch/tok) ===\n");

// Session start: slot must be occupied immediately (idle skeleton).
await emit("session_start", { reason: "startup" });
console.log(`[idle  ] session_start skeleton      | ${lastStatus}\n`);

// 1) chinese answer only (thinking off)
await simulateTurn("zh-t1", 0, 100, 20);
// 2) same shape — k_cjk calibrated → live should read ≈100
await simulateTurn("zh-t2", 0, 100, 20);
// 3) english answer only (thinking off) — k_latin gets calibrated
await simulateTurn("en-t3", 0, 100, 20);
// 4) realistic: english thinking 50 + chinese answer 50 (1:1)
await simulateTurn("mix-t4", 50, 50, 20);
// 5) RATIO FLIP: short thinking 10 + long chinese answer 90.
//    A single global k chases the ratio and drifts here; per-class k should hold.
await simulateTurn("flip-t5", 10, 90, 20);
// 6) another flip back: long thinking 90 + short answer 10
await simulateTurn("flip-t6", 90, 10, 20);

// ── Per-turn independence (regression assertions) ───────────────────────
// Stats of turn N must come only from turn N — never accumulated from
// earlier turns. Capture every status write during each turn and assert.
const writes: string[] = [];
const origSetStatus = ctx.ui.setStatus;
ctx.ui.setStatus = (k: string, t: string) => {
	origSetStatus(k, t);
	writes.push(t);
};
const downTok = (s: string | null) => {
	const m = s?.match(/↓(\d+)/);
	return m ? parseInt(m[1], 10) : null;
};
let failed = 0;
const check = (label: string, got: number | null, want: number) => {
	const ok = got === want;
	if (!ok) failed++;
	console.log(`[assert] ${label}: ↓${got} (want ${want}) ${ok ? "PASS" : "FAIL"}`);
};

// X: big turn (30 thinking + 70 answer = 100 tokens)
const x = await simulateTurn("X-big  ", 30, 70, 20);
check("X final (own turn only)", downTok(lastStatus), 100);
check("X during bash (exact, no ~ drift)", downTok(x.duringTools), 100);

// Y: small turn right after — must show 10, not 100+10; live must never
// climb toward the previous turn's total.
writes.length = 0;
await simulateTurn("Y-small", 5, 5, 20);
check("Y final (own turn only)", downTok(lastStatus), 10);
const yLives = writes.map(downTok).filter((v): v is number => v !== null);
if (yLives.length > 0) {
	const maxLive = Math.max(...yLives);
	const ok = maxLive <= 14;
	if (!ok) failed++;
	console.log(`[assert] Y live max ↓${maxLive} (want ≤14) ${ok ? "PASS" : "FAIL"}`);
} else {
	failed++;
	console.log("[assert] Y live max: no live samples FAIL");
}

// Interrupted turn with partial usage (40), then Z — Z must not inherit it.
await emit("turn_start", { turnIndex: 10, timestamp: Date.now() });
await emit("message_start", { message: mkAssistant() });
for (let i = 0; i < 20; i++) {
	await sleep(20);
	await emit("message_update", {
		message: mkAssistant(),
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "汉字", partial: {} },
	});
}
await emit("turn_end", {
	turnIndex: 10,
	message: mkAssistant(40), // partial usage
	outcome: "aborted",
	toolResults: [],
});
check("aborted final (own partial usage)", downTok(lastStatus), 40);

await simulateTurn("Z-small", 0, 5, 20);
check("Z final (no inheritance from aborted 40)", downTok(lastStatus), 5);

// Next turn_start must NOT jump to the skeleton when the previous turn
// had data — keep the previous final display; first delta jumps to live.
const prevFinal = lastStatus;
await emit("turn_start", { turnIndex: 11, timestamp: Date.now() });
{
	const ok = lastStatus === prevFinal;
	if (!ok) failed++;
	console.log(`[assert] turn_start keeps previous display: ${lastStatus} ${ok ? "PASS" : "FAIL"}`);
}
await emit("message_start", { message: mkAssistant() });
await sleep(20);
await emit("message_update", {
	message: mkAssistant(),
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd", partial: {} },
});
{
	const s = lastStatus ?? "";
	const isLive = /↓\d/.test(s) && /(t\/s)/.test(s) && s !== prevFinal;
	if (!isLive) failed++;
	console.log(`[assert] first delta jumps to live: ${s} ${isLive ? "PASS" : "FAIL"}`);
}
await emit("message_end", { message: mkAssistant(1, "stop") });
await emit("turn_end", {
	turnIndex: 11,
	message: mkAssistant(1),
	outcome: "completed",
	toolResults: [],
});

ctx.ui.setStatus = origSetStatus;
console.log(failed === 0 ? "\nAll independence assertions PASS.\n" : `\n${failed} ASSERTION(S) FAILED\n`);

// Aborted mid-stream (no message_end; provider sent partial usage).
await emit("turn_start", { turnIndex: 7, timestamp: Date.now() });
await emit("message_start", { message: mkAssistant() });
for (let i = 0; i < 20; i++) {
	await new Promise((r) => setTimeout(r, 20));
	await emit("message_update", {
		message: mkAssistant(),
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "汉字", partial: {} },
	});
}
await emit("turn_end", {
	turnIndex: 7,
	message: mkAssistant(40), // partial usage
	outcome: "aborted",
	toolResults: [],
});
console.log(`[abrt ] aborted                     | final: ${lastStatus}`);

// Zero-output turn → warning skeleton.
await emit("turn_start", { turnIndex: 8, timestamp: Date.now() });
await emit("turn_end", {
	turnIndex: 8,
	message: mkAssistant(0),
	outcome: "completed",
	toolResults: [],
});
console.log(`[n/a  ] zero-output turn            | final: ${lastStatus}`);

// /tps toggle: OFF clears; ON restores (no-data → skeleton).
await commands.tps.handler("", ctx);
await commands.tps.handler("", ctx);
console.log(`[on   ] no data → skeleton          | ${lastStatus}`);

// mid-turn toggle restore
await emit("turn_start", { turnIndex: 9, timestamp: Date.now() });
await emit("message_start", { message: mkAssistant() });
for (let i = 0; i < 30; i++) {
	await new Promise((r) => setTimeout(r, 20));
	await emit("message_update", {
		message: mkAssistant(),
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "abcd", partial: {} },
	});
}
await commands.tps.handler("", ctx); // off mid-turn
await commands.tps.handler("", ctx); // on mid-turn → live display restored
console.log(`[on   ] mid-turn restore            | ${lastStatus}`);
await emit("message_end", { message: mkAssistant(30) });
await emit("turn_end", { turnIndex: 9, message: mkAssistant(30), outcome: "completed", toolResults: [] });

// session boundary resets calibration → fresh skeleton
handlers["session_shutdown"]?.({} as any, ctx);
await emit("session_start", { reason: "new" });
console.log(`[idle ] after reset                 | ${lastStatus}\n`);
console.log("OK — all phases rendered.");
if (failed > 0) process.exitCode = 1;
