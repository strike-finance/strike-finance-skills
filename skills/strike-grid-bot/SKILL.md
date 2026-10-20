---
name: strike-grid-bot
description: Strike Finance grid trading bots -- create (LONG / SHORT / NEUTRAL, LIMIT_ONLY or MARKET_SEEDED), stop (with or without canceling orders), list / get / order-history reads (public with redaction, scope=all), how the grid places entries, take-profits, stop-losses and re-grids, sizing and validation rules, status lifecycle, liquidation handling, grid client order IDs, and strategyUpdate grid events. Use when building or monitoring grid bots, or when a bot needs to recognize grid-managed orders on an account.
---

# Strike Finance Grid Bots

Base URL: `https://api.strikefinance.org` (testnet `https://api-v2-testnet.strikefinance.org`). Paths are used as-is.

A grid bot is server-side order automation on one symbol of one account: it rests post-only limit entries at evenly spaced prices, arms a take-profit (and optional stop-loss) when an entry fills, and re-places the entry when the take-profit fills. It trades the account's normal one-way position and margin — nothing is segregated.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v2/grid/bot` | Trading (API wallet or JWT) | Create (201) |
| DELETE | `/v2/grid/bot/{id}` | Trading | Stop |
| GET | `/v2/grid/bot` | FlexibleAuth (public selectors) | List bots |
| GET | `/v2/grid/bot/{id}` | FlexibleAuth | One bot with its levels |
| GET | `/v2/grid/bot/{id}/orders` | FlexibleAuth | Live levels + filled-exit history |

Sign requests with **strike-auth** (`signRequest` / `authenticatedFetch`). There is no update/modify endpoint and no preview endpoint: to change range, count or stops, stop the bot and create a new one. Routes are not served on the DMA host.

## How it works

- **Async.** `POST` validates and publishes a command; the grid service creates the bot moments later. `201 {"status":"SUBMITTED"}` means accepted, not running. Until the grid service saves the bot, `GET /v2/grid/bot/{id}` is `404 bot not found`.
- **Silent rejects.** The grid service re-checks balance (`balance >= collateral`) and mark price before saving anything. If that fails the bot is never stored: `GET` stays `404` forever and no event is sent. Treat "still 404 after ~10 s" as a failed create.
- **Decimals** are strings in responses; requests accept strings or numbers. `mode` is case-sensitive (`LONG`), `initialization_mode` is trimmed and upper-cased.
- **Errors** are `{"error": "..."}`. Service validation errors are `400` and prefixed: `invalid grid bot request: <reason>`.
- **Account selectors** (body on POST/DELETE, query on GETs): `vault_id` (vault leader runs a bot on the vault account) or `sub_account_id` (master runs a bot on an owned active sub-account); mutually exclusive (`400`). API wallets bound to a sub-account already act as it. Vault status is **not** checked for grid bots (unlike `POST /v2/order`).
- **No builder fee.** `X-Builder-Fee-Bps` is ignored on grid routes; grid orders carry no builder code, no builder fee and no builder-approval check.
- **No per-account bot limit** is enforced, and several bots may run on the same symbol (they share one net position).

## Grid mechanics

`spacing = (upper_price − lower_price) / grid_count` (arithmetic only — no geometric mode). Levels are `lower_price + i × spacing` for `i = 0 … grid_count−1` (`upper_price` itself is never an entry). Each level's take-profit is one spacing away.

| Mode | `LIMIT_ONLY` (default) | Exit side |
|---|---|---|
| `LONG` | Post-only **buy** at every level strictly below the mark; levels at/above the mark are dropped for the bot's life | TP sell at `entry + spacing` |
| `SHORT` | Post-only **sell** at every level strictly above the mark; levels at/below are dropped | TP buy at `entry − spacing` |
| `NEUTRAL` | Buy below the mark, sell above, skip a level exactly at the mark | Buy levels TP at `+spacing`, sell levels at `−spacing` |

`MARKET_SEEDED` (`LONG`/`SHORT` only) treats each level as an interval `[lower+i·s, lower+(i+1)·s]`. `LONG` enters at the interval bottom and exits at its top; every interval whose top is above the mark (including the one containing the mark) is opened immediately by **one market FOK order** for `seeded_intervals × size_per_grid`, and the rest get resting post-only buys. `SHORT` mirrors it (enter at top, exit at bottom, seed intervals whose bottom is below the mark). The seed VWAP becomes those levels' entry price.

Per-level orders (all GTC):

| Order | Type | Notes |
|---|---|---|
| Entry | `limit`, post-only | Size `size_per_grid` |
| Take-profit | `limit`, **not** post-only | Placed only after the entry is **fully** filled (partial entry fills arm nothing). Reduce-only for LONG/SHORT; plain (not reduce-only) for NEUTRAL |
| Stop-loss | `stop` (stop-market, mark-price trigger) at the bot's SL price | Only when an SL price was set; same reduce-only rule. If the engine refuses it as already triggered (`conditional_order_triggers_immediately`) or the triggered market leg is cut by slippage (`market_order_exceeded_slippage`), the grid closes the level with an IOC market order instead |

- **Re-grid**: when a level's take-profit fully fills, a new post-only entry is placed at the same price/side/TP/SL (new strategy ID `…:regrid-<ns>`).
- **Stop-loss fill** closes that level for good (no re-grid); the bot keeps running with its remaining levels. There is no bot-wide take-profit, stop or trigger price, and nothing closes the position when a bot stops.
- **Partial exit fill**: each piece is recorded (history row + `GRID_BOT_FILL` with `partial: true`); the sibling exit is canceled and re-placed for the remainder; the level closes and re-grids only when the exit fully fills.
- **Entry retries**: an unfilled level whose entry (initial or re-grid) is rejected `order_would_match_immediately`, or whose re-grid fails to publish, is kept and retried (1 s doubling to 30 s). While the mark is on the wrong side it waits (re-checks every 30 s) without using an attempt; after 10 failed attempts it gives up — the level stays without an entry, `last_error` is set and `GRID_BOT_FAILED` is sent.
- **Levels disappear permanently** when their entry is canceled or engine-rejected for any other reason (e.g. `insufficient_balance`) — including by your own `DELETE /v2/order/cancel-all` or `/v2/orders/replace` on that symbol — or when their exits are canceled because the position is gone (`no_open_position`, `position_closed`, `order_increase_position`, `order_reduce_only_reject`). A canceled TP/SL of a held level is re-placed instead (retry 1 s doubling to 30 s, 10 attempts, then `exit_retry_exhausted`).
- Grid TPs are plain limits, so the engine's bracket OCO (`order_strategy_secondary_oco`) does not apply. When a level's SL (or TP) fully fills, the grid cancels the sibling exit itself and drops the level once that cancel is confirmed (a TP fill re-grids right away under a new strategy ID).
- **NEUTRAL** exits net against the one position: run one NEUTRAL bot per symbol and don't trade the symbol manually beside it.

**Sizing**: `size_per_grid = collateral × leverage / grid_count / ((upper_price + lower_price) / 2)`, rounded **down** to the limit and market step sizes. `leverage` is the account's current leverage for the symbol (set via `/v2/leverage` / `PUT /v2/symbols`, else the market default), snapshotted at create and only used for sizing; total notional ≈ `collateral × leverage`. `collateral` is only checked against the wallet balance — the engine reserves margin per resting entry like any order. Prices are tick-aligned: buy entries round down and sell entries up; TPs and SLs round away from the entry (buy level: TP up, SL down; sell level: TP down, SL up).

### Recognizing grid orders

Bot ID: `grid-<account_id>-<symbol>-<uuidv7>`. Grid orders are ordinary orders on the account (visible in `GET /v2/openOrders`, history and `ORDER_TRADE_UPDATE`) with:

| Client order ID | Order |
|---|---|
| `<bot_id>:grid-<i>:entry` / `:tp` / `:sl` | Initial level `i` |
| `<bot_id>:regrid-<unix_ns>:entry` / `:tp` / `:sl` | Re-gridded level |
| `<bot_id>:initial-seed:entry` | MARKET_SEEDED seed (market FOK) |

`Strategy.ID` is the level's strategy ID (client ID without the suffix); entries have `IsPrimary: true`, exits `false`. Grid orders carry no `Builder`. Don't create your own orders with a `<bot_id>:` client ID prefix: a cancel-on-stop reconcile cancels every active order on that account+symbol with that prefix.

---

## POST /v2/grid/bot — Create

```json
{
  "symbol": "BTC-USD",
  "mode": "NEUTRAL",
  "initialization_mode": "LIMIT_ONLY",
  "lower_price": "60000",
  "upper_price": "70000",
  "grid_count": 20,
  "collateral": "500",
  "long_sl_price": "58000",
  "short_sl_price": "72000"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `symbol` | string | yes | e.g. `BTC-USD` |
| `mode` | string | yes | `LONG` \| `SHORT` \| `NEUTRAL` (exact case) |
| `initialization_mode` | string | no | `LIMIT_ONLY` (default) \| `MARKET_SEEDED` (LONG/SHORT only) |
| `lower_price`, `upper_price` | decimal | yes | `> 0`, `upper > lower`; the mark must be strictly inside `(lower, upper)` |
| `grid_count` | integer | yes | `2`–`200` |
| `collateral` | decimal | yes | `> 0`; USD amount used for sizing; wallet balance must be `>=` it |
| `sl_price` | decimal | no | LONG: `< lower_price`; SHORT: `> upper_price`; not allowed for NEUTRAL |
| `long_sl_price` / `short_sl_price` | decimal | no | NEUTRAL only: buy levels' SL `< lower_price` / sell levels' SL `> upper_price` |
| `vault_id` / `sub_account_id` | string | no | Account selector (see above) |

Validation also requires:
- **Fees**: `spacing > mid × (maker_rate + taker_rate)` using the account's effective fee tier (overrides, referral and staking discounts applied), `mid = (upper+lower)/2`.
- **MARKET_SEEDED**: every seeded interval must net `> 0` per unit with a taker entry at the mark and a maker exit at its TP; the aggregate seed must pass market size rules and the leverage tier's max notional.
- **Orders**: every entry that would be placed must pass the market rules from `GET /v2/markets` (min/step size, tick, min notional at its own price). For MARKET_SEEDED, seeded levels' future re-grid entries must also clear min notional.

**Response 201:**
```json
{ "bot_id": "grid-019d06d9-d337-7169-af03-2ea759f7a6aa-BTC-USD-019e63da-5684-7c16-b990-6f0c4c5637ce", "status": "SUBMITTED" }
```

**Errors** — `400 invalid grid bot request: …`, e.g.: `mode must be LONG, SHORT, or NEUTRAL`, `initialization_mode must be LIMIT_ONLY or MARKET_SEEDED`, `initialization_mode MARKET_SEEDED is only supported for LONG or SHORT mode`, `upper_price must be positive`, `lower_price must be positive`, `upper_price must be greater than lower_price`, `grid_count must be between 2 and 200`, `collateral must be positive`, `sl_price must be positive` (likewise `long_sl_price`/`short_sl_price`), `sl_price must be below lower_price for LONG mode`, `sl_price must be above upper_price for SHORT mode`, `sl_price is not supported for NEUTRAL mode; use long_sl_price and/or short_sl_price`, `long_sl_price and short_sl_price are only supported for NEUTRAL mode`, `long_sl_price must be below lower_price for NEUTRAL mode`, `short_sl_price must be above upper_price for NEUTRAL mode`, `unknown symbol <s>`, `mark price unavailable for <s>`, `current price <p> is outside grid range [<lower>, <upper>]`, `grid spacing <s> is too small to cover trading fees (minimum <m>)`, `seeded grid <i> is not profitable after the account fee tier at current price <p>`, `insufficient balance: have <b>, need <c>`, `account not found`, `grid size <s> below market minimum`, `per-grid notional <n> is below <symbol> minimum <m>; increase collateral or reduce grid_count`, `no grid orders are placeable at current price <p>`, `grid order <i> is invalid: <engine code>`; MARKET_SEEDED also: `per-grid notional <n> at price <p> is below <symbol> minimum <m>; increase collateral or reduce grid_count`, `seeded take profit <i> is invalid: <code>`, `resting seeded-grid order <i> is invalid: <code>`, `aggregate market seed order is invalid: <code>`, `aggregate market seed leverage <l> exceeds market tier constraints`, `aggregate market seed notional <n> exceeds leverage-<l> tier maximum <t>`.

Other: `400` binding errors (missing `symbol`/`mode`/`grid_count` → `Key: 'CreateGridBotRequest.GridCount' Error:Field validation for 'GridCount' failed on the 'required' tag`; missing decimals fall through to the `must be positive` checks), `400 vault_id and sub_account_id are mutually exclusive`, `403 only vault leader can perform this action on vault account`, `403 sub-account access denied`, `404 vault not found`, `500 internal server error`, `503 grid bot service not configured`.

## DELETE /v2/grid/bot/{id} — Stop

Body is optional (sign its hash if you send one):

| Field | Type | Default | Notes |
|---|---|---|---|
| `cancel_orders` | bool | `false` | `true`: cancel every live order of the bot (including ones not yet echoed — matched by the `<bot_id>:` prefix) and finish `STOPPED` once none remain. `false`: bot goes `STOPPED` at once and **all its orders stay on the book unmanaged** (entries that fill later get no TP) |
| `vault_id` / `sub_account_id` | string | — | Required to address a bot on a vault / sub-account |

```json
{ "bot_id": "grid-…", "status": "STOPPING" }
```
`status` is `STOPPED` only if the stored bot was already stopped (nothing is published then); otherwise always `STOPPING`, even with `cancel_orders: false`. Watch `GET` or `GRID_BOT_STOPPED` for the end state. Stopping never closes positions: inventory stays open (and with `cancel_orders: true` loses its TP/SL). Errors: `404 bot not found` (unknown, or owned by another account), `400 <JSON bind error>` (malformed body), `400 vault_id and sub_account_id are mutually exclusive`, `403`/`404` vault and sub-account errors as above, `500 internal server error`.

---

## Reads (public with redaction)

Selectors (query): none → the caller's own account (`401 {"error":"account_id not found in auth context"}` without auth); `sub_account_id` → owned sub-account (`403 sub-account access denied`); `vault_id` → vault account (unredacted for its leader, public view otherwise); `account_id` (UUID) or `blockchain_address` (+ optional `blockchain`) → that account, **always redacted**, even when it is your own. `account_id` wins over `vault_id`. Selector errors: `400 invalid account_id`, `400 invalid vault id` (anonymous) / `404 vault not found` (authenticated), `400 invalid address format`, `400 blockchain_address is too long`, `404 user not found`.

**Redacted (public) view** removes: bot `sl_price`, `long_sl_price`, `short_sl_price`, `last_error`, `stop_reason`, `market_seed`, `cancel_on_stop`; per level `sl_price`, `sl_order_id`, `needs_exit_orders`, `tp_order_pending`, `sl_order_pending`, `closing`, `exit_retry_count`, `last_exit_error`, `exit_retry_exhausted`. On `/orders`, `LIVE` rows lose `sl_price`/`sl_order_id`; `FILLED` rows stay complete.

### GET /v2/grid/bot — List

Query: `limit` (default 100, max 500; `0`/negative → 100; non-integer → `400 limit must be an integer`), selectors, `scope=all`. Returns every bot ever created on the account (stopped ones included — no status or symbol filter), newest `created_at_ms` first. `count` = bots returned.

```json
{ "bots": [ /* bot objects as in GET /v2/grid/bot/{id} */ ], "count": 1 }
```

`scope=all`: bots of the master + active sub-accounts, merged newest-first. Each account contributes up to `limit` clamped to 1–500 (`0`/negative → 100); the merged list is then cut to the raw `limit` only when `limit > 0` (so `limit=0` returns up to 100 per account with no overall cap, and `limit=1000` can exceed 500 in total). The response adds `"accounts": [{ "account_id": "...", "name": "Master Account", "kind": "master" }, { "account_id": "...", "name": "BTC", "kind": "sub" }]`. Seeded from the caller, or publicly (redacted) from `account_id` / `blockchain_address` (a sub-account seeds its parent's family). Errors: `400 invalid scope: only scope=all is supported`, `400 scope=all cannot be combined with vault_id` (or `sub_account_id`), `401 authentication required for scope=all`, `403 scope=all is not available to sub-account API keys`. On the list, profit fields are omitted on every bot if history is unavailable.

### GET /v2/grid/bot/{id} — One Bot

```json
{
  "id": "grid-019a…-BTC-USD-019e…",
  "account_id": "019a0c2e-1111-7000-8000-000000000001",
  "symbol": "BTC-USD",
  "status": "RUNNING",
  "mode": "LONG",
  "initialization_mode": "LIMIT_ONLY",
  "upper_price": "70000",
  "lower_price": "60000",
  "grid_count": 10,
  "leverage": 20,
  "collateral": "500",
  "sl_price": "58000",
  "orders": [
    { "strategy_id": "grid-…:grid-3", "price": "63000", "tp_price": "64000", "sl_price": "58000",
      "side": "buy", "size": "0.0015", "filled": true, "entry_type": "LIMIT",
      "entry_filled_size": "0.0015", "entry_fee": "0.0189", "tp_order_id": 243140301, "sl_order_id": 243140302 },
    { "strategy_id": "grid-…:grid-2", "price": "62000", "tp_price": "63000", "sl_price": "58000",
      "side": "buy", "size": "0.0015", "filled": false, "entry_type": "LIMIT", "entry_order_id": 243140288 }
  ],
  "grid_profit": "4.5",
  "grid_fees": "0.08",
  "grid_profit_net": "4.42",
  "created_at_ms": 1779791713927,
  "updated_at_ms": 1780548161566
}
```

| Bot field | Type | Notes |
|---|---|---|
| `status` | string | `CREATED` \| `RUNNING` \| `STOPPING` \| `STOPPED` |
| `leverage`, `grid_count` | number | `leverage` = snapshot used for sizing |
| `orders` | array | Tracked levels (resting entries, held levels, closing levels); `[]` when none. Kept as-is after a `cancel_orders: false` stop |
| `grid_profit` / `grid_fees` / `grid_profit_net` | decimal | Sum of recorded exits' per-level gross PnL / exit fees + entry-fee shares / difference. Omitted when history is unavailable (GET by id then returns `500`) |
| `last_error` | string | Latest operational error (retries, failed create); cleared on a clean stop |
| `stop_reason` | string | Set when the grid stopped the bot itself, e.g. `liquidation closed grid inventory (fill 123)`, `aggregate market seed expired without fills: <reason>`; survives `STOPPED` |
| `cancel_on_stop` | bool | `true` while a cancel-orders stop is reconciling |
| `market_seed` | object | MARKET_SEEDED only, until the seed finalizes: `strategy_id`, `order_id`, `target_size`, `filled_size`, `terminal` |

| Level field | Notes |
|---|---|
| `strategy_id` | `<bot_id>:grid-<i>` or `<bot_id>:regrid-<ns>` |
| `price`, `tp_price`, `sl_price` | Entry, TP and SL prices (`sl_price` omitted when no SL) |
| `side` | Entry side `buy` \| `sell` |
| `size`, `filled` | Planned size; `filled` = entry fully filled (level holds inventory) |
| `entry_type` | `LIMIT` \| `MARKET_SEED` |
| `entry_filled_size`, `entry_average_fill_price`, `entry_fee`, `exit_filled_size` | Execution; `entry_average_fill_price` only for `MARKET_SEED` levels (seed VWAP) |
| `entry_order_id`, `tp_order_id`, `sl_order_id` | Engine order IDs (numbers) once observed |
| `needs_exit_orders`, `tp_order_pending`, `sl_order_pending`, `exit_retry_count`, `last_exit_error`, `exit_retry_exhausted`, `closing` | Exit lifecycle. `filled` + `needs_exit_orders` without `tp_order_id` = inventory without a TP (retrying). `exit_retry_exhausted` = gave up after 10 attempts — stop the bot / close manually |

Zero decimals and false/zero lifecycle fields are omitted. Errors: `404 bot not found`, selector errors above.

### GET /v2/grid/bot/{id}/orders — Levels + Exit History

Query: `limit` (default 100, max 500), `fromId` (the previous page's `next_from_id`), selectors (`scope` is ignored here and on `GET /v2/grid/bot/{id}`). Every page returns **all** `LIVE` rows (one per tracked level, not counted in `limit`) followed by up to `limit` `FILLED` rows, newest `filled_at_ms` first. One `FILLED` row per recorded exit fill (partial fills and multi-level auto-close fills produce several).

```json
{
  "bot_id": "grid-…",
  "orders": [
    { "status": "LIVE", "strategy_id": "grid-…:grid-2", "symbol": "BTC-USD", "side": "buy", "size": "0.0015",
      "entry_price": "62000", "tp_price": "63000", "sl_price": "58000", "entry_order_id": 243140288 },
    { "id": 31, "status": "FILLED", "strategy_id": "grid-…:grid-6", "symbol": "BTC-USD", "side": "sell",
      "size": "0.01532", "entry_price": "73776.00", "fill_price": "64030.80", "tp_price": "74544.50",
      "sl_price": "68200.00", "filled_at_ms": 1780547995899, "fill_id": 22271,
      "realized_pnl": "-149.2964640", "fee": "0", "entry_fee": "0", "close_type": "stop_loss" }
  ],
  "count": 2,
  "grid_profit": "-4697.8315920",
  "grid_fees": "0",
  "grid_profit_net": "-4697.8315920",
  "next_from_id": 31,
  "has_more": true
}
```

- `LIVE.side` is the entry side; `FILLED.side` is the exit fill's side (opposite). `LIVE.entry_price` is the seed VWAP for seeded levels.
- `realized_pnl` = `(fill_price − entry_price) × size`, negated for `buy` exits — the level's own PnL, not the position-average PnL on fills. Row net = `realized_pnl − fee − entry_fee`.
- `close_type`: `take_profit`, `stop_loss`, `liquidation`, `adl`, `bankrupt`, `if_transfer`, `vault_withdrawal`, `slp_transfer`, `unknown`.
- Aggregates cover all of the bot's exits, not just the page. `next_from_id` is present only when `has_more`.

Errors: `400 limit must be an integer`, `400 invalid fromId parameter`, `400 fromId does not identify a filled order of this bot`, `404 bot not found`.

---

## Lifecycle

```
POST → SUBMITTED (API only) → CREATED → RUNNING → STOPPING → STOPPED
                                  └─────────────→ STOPPED (create failed, nothing placed)
```

| Situation | Status | Fields | Events |
|---|---|---|---|
| Grid service rejects before saving (balance, mark price) | never stored (`404`) | — | none |
| LIMIT_ONLY entries published | `RUNNING` | — | `GRID_BOT_STARTED` (sent when published, before the engine accepts them) |
| MARKET_SEEDED seed in flight | `RUNNING` + `market_seed` | — | none yet |
| Seed filled, exits placed | `RUNNING` | — | `GRID_BOT_STARTED` with seed fields |
| Planning/validation failed in grid service, or nothing published | `STOPPED` | `last_error` | `GRID_BOT_FAILED` only |
| LIMIT_ONLY: some entries failed to publish | `STOPPING` → `STOPPED` (cancels the rest) | `last_error` while stopping | `GRID_BOT_FAILED`, `GRID_BOT_STOPPED` |
| MARKET_SEEDED: some resting entries failed to publish (seed fine) | `RUNNING` with fewer levels | `last_error` | none |
| Seed FOK expired/rejected or failed to publish | `STOPPING` → `STOPPED` | `stop_reason` | `GRID_BOT_FAILED`, `GRID_BOT_STOPPED` |
| Entry or exit retries exhausted | `RUNNING` | `last_error`, level flags | `GRID_BOT_FAILED` (status `RUNNING`) |
| Liquidation / ADL / bankruptcy / insurance-fund / vault-withdrawal / SLP-transfer fill closes grid inventory | `STOPPING` → `STOPPED` | `stop_reason` | `GRID_BOT_FILL` per level, `GRID_BOT_FAILED`, `GRID_BOT_STOPPED` |
| User stop | `STOPPING` → `STOPPED` | — | `GRID_BOT_STOPPED` |

Auto-close handling: the fill is split across the account's bots on that symbol (oldest bot first; within a bot only levels the fill's side can close — a sell closes buy levels — highest entry first for long levels, lowest entry first for short levels), each closed piece is recorded at the auto-close price, and **every bot it touched is stopped with cancel** — even if only partly hit. Size beyond the bots' inventory is treated as the manual position.

## Real-time: strategyUpdate

Grid events arrive on the userstream (`wss://<host>/ws/user-api`, `userstream` channel of the bot's account — owned sub-account via `sub_account_id`, vault via `vault_id`, which is public and so exposes a vault bot's events to anyone; see **strike-userstream**). Entry fills produce no grid event — only the normal `ORDER_TRADE_UPDATE` with the grid client order ID.

```json
{ "e": "strategyUpdate", "E": 1780547995899, "s": "BTC-USD",
  "data": { "event_type": "GRID_BOT_FILL", "account_id": "019d06d9-…", "bot_id": "grid-…", "symbol": "BTC-USD",
            "strategy_id": "grid-…:grid-6", "side": "sell", "size": "0.01532", "entry_price": "73776",
            "fill_price": "64030.8", "realized_pnl": "-149.296464", "close_type": "stop_loss",
            "timestamp": 1780547995899 } }
```

| `event_type` | Extra `data` fields |
|---|---|
| `GRID_BOT_STARTED` | `initialization_mode`, `status` (`RUNNING`), `resting_entries`; MARKET_SEEDED adds `seed_filled_size`, `seed_average_fill_price`, `seeded_levels` |
| `GRID_BOT_FILL` | One per recorded exit fill: `strategy_id`, `side` (exit side), `size`, `entry_price`, `fill_price`, `realized_pnl`, `fee`, `entry_fee`, `close_type`, `partial` (`true` until the exit fully fills) |
| `GRID_BOT_FAILED` | `status` (bot status at that moment), `error` (= `last_error`) |
| `GRID_BOT_STOPPED` | `status` (`STOPPED`), `error` (= `stop_reason`, only when the grid stopped it) |

Always present: `event_type`, `account_id`, `bot_id`, `symbol`, `timestamp` (= `E`, ms). Zero decimals (`realized_pnl`, `fee`, `entry_fee`, …), `false` and `0` are **omitted** — default missing values to `"0"`/`false`. TWAP events share `strategyUpdate`; grid events are the ones with `data.event_type`. Delivery is best effort: after a reconnect, re-read `GET /v2/grid/bot`.

## TypeScript Example

```typescript
import { authenticatedFetch } from "./auth"; // strike-auth helper

const BASE = "https://api.strikefinance.org";
declare const PRIVATE_KEY: Uint8Array, PUBLIC_KEY_HEX: string;

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await authenticatedFetch(BASE, path, { method, body }, PRIVATE_KEY, PUBLIC_KEY_HEX);
  const json = await res.json();
  if (!res.ok && res.status !== 404) throw new Error(`${res.status} ${json.error}`);
  return { status: res.status, json };
}

// Client-side preview (there is no preview endpoint). Fee rates are fractions, e.g. 0.0002.
function previewGrid(lower: number, upper: number, count: number, collateral: number, leverage: number,
                     makerRate: number, takerRate: number, stepSize: number) {
  const spacing = (upper - lower) / count;
  const mid = (upper + lower) / 2;
  const sizePerGrid = Math.floor((collateral * leverage) / count / mid / stepSize) * stepSize;
  return { spacing, sizePerGrid, feeFloor: mid * (makerRate + takerRate),
           levels: Array.from({ length: count }, (_, i) => lower + i * spacing) };
}

// Create, then wait for the grid service to store the bot
const { json: created } = await call<{ bot_id: string }>("POST", "/v2/grid/bot", {
  symbol: "BTC-USD", mode: "LONG", lower_price: "60000", upper_price: "70000",
  grid_count: 10, collateral: "500", sl_price: "58000",
});
let bot: any;
for (let i = 0; i < 15 && !bot; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const r = await call<any>("GET", `/v2/grid/bot/${created.bot_id}`);
  if (r.status === 200 && r.json.status !== "CREATED") bot = r.json;
}
if (!bot) throw new Error("grid service dropped the create (e.g. balance) — no event is sent");
if (bot.status === "STOPPED") throw new Error(`create failed: ${bot.last_error ?? bot.stop_reason}`);

// Recognize grid-managed orders among open orders
const GRID_CID = /^(grid-.+?):(?:grid-\d+|regrid-\d+|initial-seed):(entry|tp|sl)$/;
const { json: open } = await call<{ orders: any[] }>("GET", "/v2/openOrders?symbol=BTC-USD");
const mine = open.orders.filter((o) => GRID_CID.exec(o.ClientOrderID)?.[1] === bot.id);

// strategyUpdate handler (wire into the strike-userstream client)
function onStrategyUpdate(msg: { data: any }) {
  const d = msg.data;
  if (!d.event_type || d.bot_id !== bot.id) return;          // TWAP event or another bot
  if (d.event_type === "GRID_BOT_FILL") console.log(d.close_type, d.realized_pnl ?? "0", d.partial ?? false);
  if (d.event_type === "GRID_BOT_FAILED" || d.event_type === "GRID_BOT_STOPPED") console.warn(d.status, d.error);
}

// Stop and cancel everything the bot placed (positions stay open)
await call("DELETE", `/v2/grid/bot/${bot.id}`, { cancel_orders: true });

// Public read of someone's bots (redacted, no auth)
const pub = await (await fetch(`${BASE}/v2/grid/bot?account_id=${bot.account_id}&scope=all&limit=50`)).json();
```

## Gotchas

- A `201` is not a running bot; a create can vanish silently (still `404`) — poll, don't assume.
- `cancel_orders` defaults to `false`: a bare `DELETE` leaves every grid order resting and unmanaged.
- `DELETE /v2/order/cancel-all`, `/v2/orders/replace` and manual cancels hit grid orders too: canceled entries drop their level for good; canceled TP/SL are re-placed.
- Closing the position manually cancels the reduce-only exits (`position_closed`) and removes those levels without re-grid; the bot keeps running.
- `LIMIT_ONLY` LONG/SHORT never place levels on the "wrong" side of the creation mark, even after price moves there — use `MARKET_SEEDED` to start with inventory.
- Several bots on one symbol (or a bot plus manual trading) share one net position; reduce-only exits can then be canceled by the engine and levels lost.
- Passing your own `account_id` on a read returns the redacted view; omit selectors (or use `sub_account_id` / leader `vault_id`) to see stop-loss and retry state.
