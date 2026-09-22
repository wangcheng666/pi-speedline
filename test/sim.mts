/**
 * Event-sequence simulation for pi-speedline.
 *
 * Models the REAL pi 0.87.0 event stream (verified with a probe
 * extension against a live pi session):
 *   agent_start                      ← user prompt submitted (round start)
 *   [local pipeline: hooks, compaction — NOT part of TTFT]
 *   turn_start idx=0                 ← pi "turn" = ONE LLM call + tool batch
 *   message_start (assistant)        ← request dispatched (TTFT anchor)
 *   message_update (deltas) …
 *   message_end (assistant)
 *   tool_execution_start/end         ← bash runs (inside the round)
 *   turn_end
 *   turn_start idx=1                 ← next LLM call, SAME round
 *   message_start (assistant)
 *   …
 *   agent_end                        ← round over
 *
 * Self-consistent tokenization world:
 *   CJK  = 2.0 chars/token (delta "汉字" = 1 token)
 *   latin = 4.0 chars/token (delta "abcd" = 1 token)
 *
 * Regression assertions:
 *   A1  TTFT is anchored at before_provider_request (request dispatch) —
 *       NOT at agent_start (local pipeline excluded), NOT at
 *       message_start (pi fires that at the first SSE event ≈ first
 *       token, which would measure ~0)
 *   A2  a multi-call round accumulates (no mid-round wipe)
 *   A3  exact values shown while tools run; live count never drops
 *   A4  per-round independence (no cross-round accumulation)
 *   A5  aborted round shows partial usage as "interrupted"
 *   A6  display kept across rounds; first delta jumps straight to live
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
const writes: string[] = [];
const plain = (s: string | null) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const ctx: any = {
	hasUI: true,
	ui: {
		setStatus: (k: string, t: string) => {
			lastStatus = t;
			writes.push(t);
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
const downTok = (s: string | null) => {
	const m = s?.match(/↓(\d+)/);
	return m ? parseInt(m[1], 10) : null;
};
const ttftMs = (s: string | null) => {
	const m = s?.match(/TTFT (\d+)ms/);
	return m ? parseInt(m[1], 10) : null;
};

let failed = 0;
const check = (label: string, got: number | null, want: number, tol = 0) => {
	const ok = got !== null && Math.abs(got - want) <= tol;
	if (!ok) failed++;
	console.log(`[assert] ${label}: ${got} (want ${want}${tol ? `±${tol}` : ""}) ${ok ? "PASS" : "FAIL"}`);
};
const checkTrue = (label: string, ok: boolean, detail = "") => {
	if (!ok) failed++;
	console.log(`[assert] ${label} ${ok ? "PASS" : `FAIL ${detail}`}`);
};

const mkAssistant = (output = 0, stopReason = "stop") => ({
	role: "assistant",
	content: [],
	stopReason,
	usage: { input: 100, output, cacheRead: 0, cacheWrite: 0, totalTokens: 100 + output },
});

async function delta(type: "thinking_delta" | "text_delta" | "toolcall_delta", delta: string) {
	await emit("message_update", {
		message: mkAssistant(),
		assistantMessageEvent: { type, contentIndex: 0, delta, partial: {} },
	});
}

/**
 * One LLM call: before_provider_request → (requestMs of "network+
 * prefill") → message_start (first SSE) → `thinking` latin deltas →
 * `answer` CJK deltas (stepMs apart) → message_end with real usage.
 */
async function simulateCall(thinking: number, answer: number, stepMs: number, stopReason: string, requestMs = 10) {
	const tRequest = Date.now();
	await emit("before_provider_request", { payload: {} });
	await sleep(requestMs);
	const tMsgStart = Date.now();
	await emit("message_start", { message: mkAssistant() });
	await sleep(stepMs);
	const tFirstDelta = Date.now();
	for (let i = 0; i < thinking; i++) {
		await delta("thinking_delta", "abcd");
		await sleep(stepMs);
	}
	for (let i = 0; i < answer; i++) {
		await delta("text_delta", "汉字");
		await sleep(stepMs);
	}
	const live = lastStatus;
	const real = thinking + answer;
	await emit("message_end", { message: mkAssistant(real, stopReason) });
	return { tRequest, tMsgStart, tFirstDelta, live, during: lastStatus };
}

interface CallSpec {
	thinking: number;
	answer: number;
	stepMs?: number;
	stopReason?: string;
	toolMs?: number; // bash runs after this call
}

/** One full round (agent_start … agent_end), any number of LLM calls. */
async function simulateRound(label: string, calls: CallSpec[], preRequestGapMs = 0) {
	writes.length = 0;
	const tAgentStart = Date.now();
	await emit("agent_start", {});
	const roundMsgs: any[] = [];
	let duringTools: string | null = null;
	for (const c of calls) {
		await emit("turn_start", { turnIndex: 0, timestamp: Date.now() }); // must be ignored
		const r = await simulateCall(
			c.thinking,
			c.answer,
			c.stepMs ?? 20,
			c.stopReason ?? "stop",
		);
		roundMsgs.push(mkAssistant(c.thinking + c.answer, c.stopReason ?? "stop"));
		if (c.toolMs) {
			await emit("tool_execution_start", { toolName: "bash" });
			await sleep(c.toolMs);
			await emit("tool_execution_end", { toolName: "bash" });
			duringTools = lastStatus;
		}
		await emit("turn_end", { turnIndex: 0, message: roundMsgs[roundMsgs.length - 1], outcome: "completed", toolResults: [] });
	}
	await emit("agent_end", { messages: roundMsgs });
	const total = calls.reduce((s, c) => s + c.thinking + c.answer, 0);
	console.log(
		`[${label}] calls:${calls.length} ↓${String(total).padStart(3)} | during-tools: ${show(duringTools ?? "–").padEnd(26)} | final: ${show(lastStatus)}`,
	);
	return { tAgentStart, final: lastStatus, duringTools, writes: writes.slice() };
}

console.log("=== pi-speedline simulation (world: CJK 2.0 ch/tok, latin 4.0 ch/tok) ===\n");

// Session start: slot must be occupied immediately (idle skeleton).
await emit("session_start", { reason: "startup" });
console.log(`[idle  ] session_start skeleton      | ${lastStatus}\n`);

// Calibration sequence (single-call rounds)
await simulateRound("zh-t1 ", [ { thinking: 0, answer: 100 } ]);
await simulateRound("zh-t2 ", [ { thinking: 0, answer: 100 } ]);
await simulateRound("en-t3 ", [ { thinking: 0, answer: 100 } ]);
await simulateRound("mix-t4", [ { thinking: 50, answer: 50 } ]);
await simulateRound("flip-t5", [ { thinking: 10, answer: 90 } ]);
await simulateRound("flip-t6", [ { thinking: 90, answer: 10 } ]);
console.log("");

// ── A1: TTFT anchored at before_provider_request (request dispatch) ──
{
	// 400ms of "local pipeline" (extension hooks / compaction) between
	// agent_start and the request going out, then 30ms of "network +
	// prefill" before the first SSE/first token.
	const tAgentStart = Date.now();
	await emit("agent_start", {});
	await sleep(400);
	const tRequest = Date.now();
	await emit("before_provider_request", { payload: {} });
	await sleep(30);
	await emit("message_start", { message: mkAssistant() });
	await sleep(20);
	const tFirstDelta = Date.now();
	for (let i = 0; i < 10; i++) {
		await delta("text_delta", "汉字");
		await sleep(20);
	}
	await emit("message_end", { message: mkAssistant(10, "stop") });
	await emit("agent_end", { messages: [mkAssistant(10, "stop")] });
	const shown = ttftMs(lastStatus);
	const want = tFirstDelta - tRequest;
	const fromAgentStart = tFirstDelta - tAgentStart;
	console.log(`[A1 ttft] shown: ${shown}ms | request→firstDelta: ${want}ms | agentStart→firstDelta: ${fromAgentStart}ms`);
	check("A1 TTFT ≈ request→firstDelta", shown, want, 5);
	checkTrue("A1 TTFT excludes the 400ms local pipeline", shown !== null && shown < 200, `shown=${shown}`);
}

// ── A2/A3: multi-call round (bash between two LLM calls) ────────────────
{
	const r = await simulateRound("A2 multi", [
		{ thinking: 10, answer: 10, stopReason: "toolUse", toolMs: 60 },
		{ thinking: 5, answer: 5 },
	]);
	check("A2 final = BOTH calls (20+10)", downTok(r.final), 30);
	check("A3 exact while bash runs (call 1 only, 20)", downTok(r.duringTools), 20);
	// Live counts from call 2 onward must never drop below call 1's 20
	// (call 1's OWN live display legitimately starts at ↓1).
	const duringIdx = r.duringTools !== null ? r.writes.indexOf(r.duringTools) : -1;
	const afterLives = r.writes.slice(duringIdx + 1).map(downTok).filter((v): v is number => v !== null);
	const minAfter = afterLives.length ? Math.min(...afterLives) : 0;
	checkTrue("A3 live never drops mid-round (min ≥ 20)", afterLives.length > 0 && minAfter >= 20, `min=${minAfter} n=${afterLives.length}`);
}

// ── A4: per-round independence ──────────────────────────────────────────
{
	const x = await simulateRound("A4 X-big ", [{ thinking: 30, answer: 70 }]);
	check("A4 X final (own round only)", downTok(x.final), 100);
	const y = await simulateRound("A4 Y-small", [{ thinking: 5, answer: 5 }]);
	check("A4 Y final (no X inheritance)", downTok(y.final), 10);
	const yLives = y.writes.map(downTok).filter((v): v is number => v !== null);
	const maxLive = yLives.length ? Math.max(...yLives) : 0;
	checkTrue("A4 Y live max ≤ 14", maxLive <= 14, `max=${maxLive}`);
}

// ── A5: aborted round shows partial usage, next round is clean ─────────
{
	await emit("agent_start", {});
	await emit("message_start", { message: mkAssistant() });
	for (let i = 0; i < 20; i++) {
		await delta("text_delta", "汉字");
		await sleep(20);
	}
	await emit("message_end", { message: mkAssistant(40, "aborted") });
	await emit("agent_end", { messages: [mkAssistant(40, "aborted")] });
	check("A5 aborted final (partial usage)", downTok(lastStatus), 40);
	checkTrue("A5 shows 'interrupted'", /interrupted/.test(plain(lastStatus)), plain(lastStatus));
	const z = await simulateRound("A5 Z-small", [{ thinking: 0, answer: 5 }]);
	check("A5 Z final (no inheritance from aborted 40)", downTok(z.final), 5);
}

// ── A6: keep-last-display across rounds; first delta jumps to live ─────
{
	const prevFinal = lastStatus;
	await emit("agent_start", {});
	checkTrue("A6 agent_start keeps previous display", lastStatus === prevFinal, `${plain(lastStatus)}`);
	await emit("message_start", { message: mkAssistant() });
	await sleep(20);
	await delta("text_delta", "abcd");
	const s = plain(lastStatus ?? "");
	checkTrue("A6 first delta jumps to live", /↓\d/.test(s) && /t\/s/.test(s) && lastStatus !== prevFinal, s);
	await emit("message_end", { message: mkAssistant(1, "stop") });
	await emit("agent_end", { messages: [mkAssistant(1, "stop")] });
}

// ── Zero-output round → warning skeleton ────────────────────────────────
{
	await emit("agent_start", {});
	await emit("agent_end", { messages: [{ role: "user", content: "hi" }] });
	checkTrue("zero-output round → ghost fields", /TTFT –/.test(plain(lastStatus)), plain(lastStatus ?? ""));
}

// ── /tps toggle: OFF clears; ON restores (no data → skeleton) ──────────
await commands.tps.handler("", ctx);
await commands.tps.handler("", ctx);
checkTrue("toggle ON with no data → skeleton", /TTFT –/.test(plain(lastStatus)), plain(lastStatus ?? ""));

// mid-round toggle restore
await emit("agent_start", {});
await emit("message_start", { message: mkAssistant() });
for (let i = 0; i < 30; i++) {
	await delta("thinking_delta", "abcd");
	await sleep(20);
}
await commands.tps.handler("", ctx); // off mid-round
await commands.tps.handler("", ctx); // on mid-round → live display restored
checkTrue("mid-round restore → live", /t\/s/.test(plain(lastStatus)) && /↓\d/.test(plain(lastStatus)), plain(lastStatus ?? ""));
await emit("message_end", { message: mkAssistant(30) });
await emit("agent_end", { messages: [mkAssistant(30, "stop")] });

// session boundary resets calibration → fresh skeleton
handlers["session_shutdown"]?.({} as any, ctx);
await emit("session_start", { reason: "new" });
console.log(`[idle ] after reset                 | ${lastStatus}\n`);
console.log("OK — all phases rendered.");
console.log(failed === 0 ? "All assertions PASS." : `${failed} ASSERTION(S) FAILED`);
if (failed > 0) process.exitCode = 1;
