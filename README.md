# pi-speedline ⚡

**A unified speedometer for the [pi](https://pi.dev) coding agent.**

Real-time calibrated tokens/s while streaming, exact per-turn TTFT and
throughput when done — merged into ONE conflict-free footer slot with a
curated, theme-adaptive palette.

```
⚡ TTFT 312ms ↓128 ~42t/s        ← live (calibrated estimate)
⚡ TTFT 312ms ↓456 78.9t/s       ← exact final, stays visible through tool runs
⚡ TTFT – ↓– –t/s                ← no data (ghost fields, structure intact)
```

pi-speedline replaces both `@gnoviawan/pi-tokens-per-second` and
`@sugarforever/pi-throughput-meter` — and fixes a class of bugs in the
former (its `setTimeout` captured a session `ctx` that goes stale after a
session replace/reload, crashing the whole pi process as an
`uncaughtException`). pi-speedline is **fully event-driven, timer-free**.

## Display lifecycle

One status slot (`speed`), one layout in every phase
(`icon · TTFT · ↓tokens · rate`). The slot is always occupied:

| Phase | Display |
|---|---|
| No previous data (fresh session) | `⚡ TTFT – ↓– –t/s` (ghost) |
| Streaming (live estimate) | `⚡ TTFT 312ms ↓128 ~42t/s` |
| Message done → **tool (bash) execution** → next segment waiting | `⚡ TTFT 312ms ↓456 78.9t/s` (exact, held) |
| Aborted turn | `⚡ ↓83 interrupted` |
| Turn with zero output | `⚡ TTFT – ↓– –t/s` (warning ghost) |

Design decisions:

- **No "streaming…" placeholder state** — the first token immediately
  shows live numbers.
- **Keep-last-display**: a new turn never blanks the slot; the next
  segment's first delta jumps straight to live. Same logic between turns
  and between conversation rounds.
- **Exact values as soon as they exist**: the final line is rendered at
  `message_end` (a pi turn = one LLM response + its tool calls), so it
  stays on screen while bash runs — not a frozen `~` estimate.
- **Per-turn stats are independent** — each turn's numbers come only from
  that turn's own stream (covered by regression assertions in the test).

## Palette — "Amber & Jade"

Curated to complement a warm orange `⚡` accent; the icon follows your
theme's `accent`, the numbers use a fixed premium palette with automatic
**dark/light variants** (detected from the theme's text color, so custom
themes work too) and a 256-color fallback for terminals without truecolor.

| Field | Dark | Light | Role |
|---|---|---|---|
| `⚡` icon | theme `accent` | theme `accent` | follows your theme |
| TTFT | `#A29586` warm sand | `#6A5E4F` | recedes into the background |
| ↓tokens | `#E3BA6E` champagne gold | `#A6782A` | warm, in-family with the icon |
| **rate** (bold) | `#4EC7A6` soft jade | `#178468` | cool counterpoint — the "money number" |
| interrupted / no data | `#D97E55` terracotta | `#B05224` | signal, still in the warm family |
| skeleton fields | 55% "ghost" of each | 55% "ghost" of each | structure stays visible |

Only the **live rate** carries `~` (it is a rolling-window estimate);
the live token counter is shown plain — it is a calibrated estimate that
converges to the exact value.

## How the numbers line up

Live estimates and final exact values use the same field structure and
converge, so the footer never shows two contradictory numbers:

- **Token estimate** — each delta's characters are split into CJK and
  latin buckets and converted with per-class chars-per-token priors
  (CJK ≈ 1.6, latin ≈ 3.8). A typical "english thinking + chinese
  answer" reply is thus estimated per content class, not with one
  blended ratio.
- **Dual-class calibration** — after each message, the real
  `usage.output` calibrates **two** factors (`k_cjk`, `k_latin`).
  Whichever content class dominates the message (≥2×) is updated from
  the residual (total minus the other class), so the thinking:answer
  ratio flipping between messages does not drag one class's factor with
  the other's. Balanced messages only re-seed both factors when the
  total drift is ≥10% (e.g. after switching models/providers).
- **Live rate** — token-weighted rolling 2 s window (falls back to the
  whole-message average for very short windows).
- **Final rate** — exact output tokens (text + thinking + tool-call
  tokens, matching `usage.output`) ÷ exact stream span (first → last
  delta).
- **TTFT** — turn start → first token delta.

Result: first message of a session carries the prior (±20% for CJK),
after one calibration round typical error is <5% — even across ratio
flips.

## Install

```bash
pi install npm:pi-speedline
```

If you use the older meters, remove them (this package replaces both):

```bash
pi remove npm:@sugarforever/pi-throughput-meter
pi remove npm:@gnoviawan/pi-tokens-per-second   # if installed
```

## Commands

| Command | Action |
|---|---|
| `/tps` | Toggle the status display (restores the current state when re-enabled) |

## Notes

- The `speed` slot renders as a single powerline-footer segment and never
  uses the `[...]` notification form, so it stays in one fixed position.
- All UI writes happen inside pi event handlers — no timers, no captured
  stale contexts, safe across `newSession`/`fork`/`switchSession`/reload.
- Status colors survive the powerline footer's normalization (it only
  strips the trailing reset code).

## Development

```bash
npm install
npm test            # event-sequence simulation with regression assertions
npm run typecheck
```

The simulation builds a self-consistent tokenization world (CJK 2.0
chars/token, latin 4.0) and asserts: live-vs-final convergence, ratio
flips, per-turn independence, tool-phase exact display, keep-last-display,
and skeleton/restore behavior.

## Credits

Merged from (both MIT):

- [`@gnoviawan/pi-tokens-per-second`](https://www.npmjs.com/package/@gnoviawan/pi-tokens-per-second) — real-time TPS concept
- [`@sugarforever/pi-throughput-meter`](https://www.npmjs.com/package/@sugarforever/pi-throughput-meter) — per-turn TTFT/throughput concept

---

## 中文简介

pi 的统一速度表:流式输出时显示**校准后的实时 tokens/s**,输出结束后显示
**精确的 TTFT + token 数 + 吞吐**,全部合并到**一个**状态栏槽位,版式
同构(`⚡ TTFT · ↓tokens · 速率`),配色为呼应橙色闪电的"琥珀 & 翡翠"
高级色板(暗/亮主题自动切换)。

**数值对齐**:每个 delta 按 CJK/拉丁分桶折算 token(≈1.6 / ≈3.8
字符/token),消息结束后用真实 `usage.output` 做**双系数残差校准**
(`k_cjk` / `k_latin`)——思考(英文)和回答(中文)比例怎么翻转都不会互相
干扰,一条消息后误差通常 <5%。实时速率是 2 秒滚动窗口(带 `~`),最终
速率 = 真实 output token ÷ 真实流式时长。

**显示逻辑**:槽位常驻不空(无数据显示幽灵字段占位);消息完成即渲染
精确终值,bash 工具执行期间保持不动;新 turn 不清屏,首 token 直接跳
实时。每轮统计完全独立,不累计。零定时器实现,无 stale-ctx 崩溃风险
(原 `pi-tokens-per-second` 的崩溃原因)。

```bash
pi install npm:pi-speedline    # 安装
/tps                           # 开关显示
```
