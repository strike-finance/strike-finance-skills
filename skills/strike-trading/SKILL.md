---
name: strike-trading
description: Strike Finance order management -- create, cancel, replace and batch orders, symbol-level quote replace, bracket TP/SL strategies, trailing stops, TWAP, leverage, margin mode, isolated margin, open-order reads. Use when building trading bots, market makers or order interfaces.
---

# Strike Finance Trading

Base URL: `https://api.strikefinance.org` (testnet `https://api-v2-testnet.strikefinance.org`). Paths are used as-is (no `/price` prefix).

All writes need API wallet auth headers (see **strike-auth**). Full schemas: `openapi/trade-api.yaml`.
Order/fill history (`/v2/history/order`, `/v2/history/fill`) is in **strike-history**.

## How it works

- **Async.** Writes are sequenced to the matching engine and answered before the engine runs them. `201 {"status":"pending"}` means accepted, not resting or filled. Engine rejections (margin, tick/step size, post-only cross, ...) arrive on the user stream (`wss://<host>/ws/user-api`, **strike-userstream**) as `ORDER_TRADE_UPDATE` with the reason code; match on client order ID `c`. The order is also readable via `GET /v2/order?symbol=..&client_order_id=..` (rejected orders included, except the silently dropped ones below).
- **Silently dropped commands.** Some rejects happen before an order event exists: the API still answers `201`/`200`, but no user-stream update follows and `GET /v2/order` returns `404`. On `POST /v2/order` and `/v2/orders/batch` items: unknown `symbol`, bad `slippage`, market not open (`order_not_allowed`), trading halted (`circuit_breaker`), and — batch items only — a missing `side`/`type`. On `/v2/order/strategy`: unknown symbol, `order_not_allowed`, a reused `strategy_id`. On the replace endpoints an unknown symbol or a create missing `side`/`type` drops the whole command (no cancels either), while bad `slippage` is a sync `400`. Validate these client-side and treat "no event within a few seconds" as a failure.
- **Errors** are `{"error": "<message>"}` (some add `failed_index`, `max_leverage`/`requested`). Binding failures return Go validator text, e.g. `Key: 'CreateOrderRequest.Side' Error:Field validation for 'Side' failed on the 'required' tag`. Binding does **not** enforce `required` on decimal fields (`size`, `amount`, leg `stop_price`) or on items inside arrays (`orders[]`, `replacements[]`): a missing `size` is accepted and rejected by the engine as `order_less_than_min_size`; a missing `side`/`type` in an array item is silently dropped (above).
- **Decimals** are strings in responses; requests accept strings or numbers. Omit optional fields instead of sending `""` — an empty string for an enum or decimal (`"time_in_force": ""`, `"price": ""`) is a `400`. Unknown fields are ignored silently.
- **Enums are case-sensitive**: `side` `buy`/`sell`, `type` lowercase, `time_in_force` `GTC`/`IOC`/`FOK`, `working_type` `mark_price`/`contract_price`. TWAP uses `BUY`/`SELL`.
- **No idempotency.** `client_order_id` is not unique-checked for single creates; a blind retry can double-place. After a timeout, look the order up by `client_order_id` first.
- **Account selectors** (every write): `vault_id` (vault leader trades the vault; vault must be `active` for creates/replaces) or `sub_account_id` (master trades an owned active sub-account). They are mutually exclusive (`400`). API wallets bound to a sub-account already act as it. Vault `403` texts differ by route: `POST /v2/order` says `only vault leader can trade on vault account` / `vault trading is <status>`; cancel, replace, strategy, leverage, margin and TWAP say `only vault leader can perform this action on vault account` (replace/strategy: `vault is <status>`).
- **Self-trade prevention** is automatic, expire-maker: an incoming order never fills against a resting order of the same account, the same master-account family, or the same server-assigned STP group. The resting order expires with `CloseReason` `order_expired_in_match`.
- **Rate limit**: per API wallet key, `429 {"error":"rate limit exceeded"}`.
- **Clock**: signatures older than 3 minutes or from the future are `401 signature expired or invalid timestamp`. Sync against `GET /v2/time` on the API host (`{"serverTime": <ms>}`); the signing timestamp is in seconds.

```typescript
import { signRequest } from "./auth"; // Ed25519 signer from strike-auth

const BASE = "https://api.strikefinance.org";
const PRIVATE_KEY: Uint8Array = loadApiWalletPrivateKey(); // your API wallet secret (32 bytes)
const PUBLIC_KEY_HEX: string = loadApiWalletPublicKeyHex(); // 64 hex chars

export async function strike<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  pathAndQuery: string,       // e.g. "/v2/openOrders?symbol=BTC-USD"
  body?: unknown,
  builderFeeBps?: number,     // optional X-Builder-Fee-Bps
): Promise<T> {
  const url = new URL(pathAndQuery, BASE);
  const signedPath = url.pathname + url.search; // sign exactly what is sent (path + ?query)
  const bodyStr = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...signRequest(method, signedPath, bodyStr, PRIVATE_KEY, PUBLIC_KEY_HEX),
  };
  if (builderFeeBps !== undefined) headers["X-Builder-Fee-Bps"] = String(builderFeeBps);
  const res = await fetch(url, { method, headers, body: bodyStr }); // body is required on the DELETE routes
  const text = await res.text();                       // PUT /v2/symbols returns 204, no body
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${res.status} ${json?.error ?? text}`);
  return json as T;
}
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v2/order` | Create order (201) |
| GET | `/v2/order` | One order by `order_id` / `client_order_id` |
| GET | `/v2/openOrders` | Pending / open / untriggered orders |
| DELETE | `/v2/order/cancel` | Cancel one order |
| DELETE | `/v2/order/cancel-all` | Cancel all (or one symbol) |
| POST | `/v2/orders/batch` | Independent creates, any symbols |
| POST | `/v2/orders/replace` | Cancel everything on a symbol + place new set (one engine command) |
| POST | `/v2/order/replace` | Cancel one + create one (one engine command) |
| POST | `/v2/order/replace-batch` | Many cancel/create pairs on one symbol (one engine command) |
| POST | `/v2/order/strategy` | Bracket: primary + TP/SL (201) |
| GET | `/v2/order/strategy` | Not implemented — always `501` |
| POST | `/v2/leverage` | Leverage for a symbol |
| POST | `/v2/marginMode` | `cross` / `isolated` for a symbol |
| GET / PUT | `/v2/symbols` | Read / bulk-update defaults + per-symbol margin mode and leverage |
| POST | `/v2/isoMargin` | Add/remove isolated margin |
| POST / GET | `/v2/algo/twap` | Create (201) / list TWAPs |
| GET / DELETE | `/v2/algo/twap/{id}` | Get / cancel a TWAP |

---

### POST /v2/order — Create Order

| Field | Type | Notes |
|---|---|---|
| `symbol` | string, required | e.g. `"BTC-USD"` |
| `side` | required | `buy` \| `sell` |
| `type` | required | `limit` \| `market` \| `stop` \| `stop_limit` \| `take_profit` \| `take_profit_limit` \| `trailing_stop_market` |
| `size` | decimal, required | Base asset. Not checked at bind time — a missing `size` becomes an engine `order_less_than_min_size` reject |
| `price` | decimal | Limit price (`limit`; post-trigger price for `stop_limit` / `take_profit_limit`) |
| `stop_price` | decimal | Trigger, required > 0 for stop / take-profit types (sync `400 invalid_stop_price`) |
| `time_in_force` | | `GTC` (default) \| `IOC` \| `FOK` |
| `working_type` | | Trigger price source. Default `mark_price`; trailing stops default `contract_price` (last trade) |
| `post_only` | bool | Rejected with `order_would_match_immediately` if it would take |
| `reduce_only` | bool | Only reduces; size clamped to the position |
| `close_position` | bool | Sized to the whole position on execution; skips min-size checks |
| `price_protect` | bool | Conditional won't trigger while last/mark deviation exceeds the market's `trigger_protect` |
| `callback_rate` | decimal | Trailing only, required, `"0.1"`–`"5"` percent |
| `activation_price` | decimal | Trailing only. Omit to start trailing immediately at the working price |
| `slippage` | decimal | Market only, fraction (`"0.01"` = 1%) from book mid; tighter of this and the market bound applies |
| `client_order_id` | string | ≤ 256 chars; UUIDv7 generated if omitted. Reserved prefixes rejected: `copy:`, `liq_`, `bankrupt_`, `adl_`, `if_transfer_`, `if_adl_`, `vault_wd_` |
| `vault_id` / `sub_account_id` | string | Account selector (see above) |

There is no per-order leverage or margin mode; set them with `/v2/leverage`, `/v2/marginMode` or `PUT /v2/symbols`.

How types execute:

| Type | On trigger / execution |
|---|---|
| `limit` | Rests (GTC) or `IOC` expires the remainder / `FOK` expires unless fully fillable |
| `market` | Takes; unfilled remainder canceled (`market_order_exceeded_slippage` if the bound stopped it) |
| `stop`, `take_profit` | Become `market`; `OriginType` keeps the original type |
| `stop_limit`, `take_profit_limit` | Become `limit` at `price` |
| `trailing_stop_market` | Must be `reduce_only: true`, no `close_position`. Sell trails the high, buy trails the low; triggers at `extreme × (1 ∓ callback_rate/100)`, becomes `market` |

Trigger direction: `stop*` sell fires at price ≤ `stop_price`, buy at ≥; `take_profit*` sell at ≥, buy at ≤. A conditional that would fire immediately is rejected (`conditional_order_triggers_immediately`), as is a trailing `activation_price` already crossed.

**Builder fee** — header `X-Builder-Fee-Bps: <0-100>` (bps of fill notional, 100 = 1%) when the API wallet has a builder code. Must be ≤ the builder's `fee_share_bps` and ≤ the account's approved max, else `400` (e.g. `X-Builder-Fee-Bps 50 exceeds your approved max of 20`); nothing is placed. For builder wallets the builder must be active and approved even with no header. Approval is looked up on the calling account, or on `sub_account_id` when one is sent — never on a vault (vault trades use the leader's approval). Builder connect only approves the wallet's own (master) account, so a builder-code wallet sending `sub_account_id` gets `400 account has not approved builder "<code>"` unless that sub-account approved the builder. Honored by `/v2/order`, `/v2/orders/batch`, `/v2/orders/replace`, `/v2/order/replace-batch`, `/v2/order/strategy` (all legs). **Not** by `/v2/order/replace` (its replacement order carries no builder code at all — no builder fee, no attribution), nor by TWAP, grid bot or copy-trading orders, which never carry a builder code.

**Response 201:**
```json
{
  "client_order_id": "my-order-001",
  "account_id": "019a0c2e-1111-7000-8000-000000000001",
  "symbol": "BTC-USD",
  "status": "pending",
  "sequence_id": 70804200,
  "message_id": "1775914565478-1"
}
```

Sync errors: `400` (binding, reserved prefix, builder fee, `invalid_stop_price`, `vault_id and sub_account_id are mutually exclusive`), `401`, `403` (`only vault leader can trade on vault account`, `vault trading is <status>`, `sub-account access denied`), `404` (`account not found`, `vault not found`).

#### Engine reject / close reasons (`CloseReason`, user stream)

| Code | Meaning |
|---|---|
| `order_less_than_min_size` | Size below `order_market_min_size` — applies to **every** type (limit too), skipped only for `close_position`; reduce-only does not skip it |
| `order_size_exceed`, `order_size_not_multiple_of_step` | Above max / off step: `order_limit_max_size`, `order_limit_step_size` for `limit`/`stop_limit`/`take_profit_limit`; `order_market_max_size`, `order_market_step_size` for `market`/`stop`/`take_profit`/trailing. A max size of `0` rejects every order of that family (not "no limit") |
| `order_less_than_min_notional` | Below `order_min_notional` (not checked for reduce-only / close-position) |
| `order_price_out_of_limit`, `order_price_exceeds_maximum`, `order_price_not_multiple_of_tick` | Price vs `order_min_price` / `order_max_price` / `order_tick_price` |
| `order_price_out_of_price_cap`, `order_price_out_of_price_floor` | Limit price too far from mark (`order_limit_price_bound`) |
| `stop_price_out_of_limit`, `stop_price_not_multiple_of_tick` | Stop price range / tick |
| `conditional_order_triggers_immediately` | Trigger or activation price already crossed |
| `order_would_match_immediately` | Post-only would take |
| `insufficient_balance`, `position_notional_exceed` | Margin / tier notional cap |
| `no_open_position`, `order_increase_position`, `order_reduce_only_reject` | Reduce-only with no position, wrong side, or no reducible size left |
| `invalid_callback_rate`, `invalid_activation_price`, `trailing_stop_requires_reduce_only`, `trailing_stop_close_position_unsupported` | Trailing stop rules |
| `slippage_must_be_positive`, `slippage_only_for_market_orders` | Bad `slippage` — silently dropped (no event) on `/v2/order` and batch items; sync `400` on replace endpoints |
| `market_order_exceeded_slippage` | Market remainder canceled at the slippage bound |
| `order_not_allowed`, `market_reduce_only` | Market not open for new orders / reduce-only market. `order_not_allowed` is silently dropped on `/v2/order`, batch and strategy (an event only on replace endpoints) |
| `liquidation`, `circuit_breaker` | Account in liquidation (reduce-only mode) / trading halted. `circuit_breaker` is silently dropped on `/v2/order` and batch (an event only on replace endpoints) |
| `order_expired_in_match` | Your resting order expired by self-trade prevention |
| `order_strategy_secondary_oco`, `order_strategy_primary_closed`, `position_closed` | Bracket leg expired by OCO / primary closed / reduce-only order canceled when the position closed or flipped |

Market rule fields are the engine's own market config, served by `GET /v2/markets` on the API host (**strike-market-data**). Don't take tick/lot filters from `/price/v2/exchangeInfo`.

---

### GET /v2/order — One Order

Query: `symbol` (required), `order_id` or `client_order_id` (client ID wins). Public reads: `account_id` (UUID), `vault_id`, `blockchain_address` (+ optional `blockchain`); authenticated: own account or `sub_account_id`. Terminal orders are served from history, so rejected orders stay retrievable.

Errors: `400 symbol parameter is required`, `400 either order_id or client_order_id parameter is required`, `400 invalid order_id format`, `401 authentication required or provide vault_id, account_id, or blockchain_address`, `404 order not found`, `404 account not found`.

Response keys are **PascalCase** (engine model). `Strategy`, `Trailing`, `Builder`, `STPGroup`, `STPAccountID`, `CopySubscriptionID`, `CopyLeadOrderID` are omitted when unset:

```json
{
  "ID": 33428500,
  "ClientOrderID": "my-order-001",
  "AccountID": "019a0c2e-1111-7000-8000-000000000001",
  "Symbol": "BTC-USD",
  "CloseReason": "",
  "Side": "sell",
  "Status": "untriggered",
  "Type": "trailing_stop_market",
  "OriginType": "",
  "AutoCloseType": "",
  "TimeInForce": "GTC",
  "WorkingType": "contract_price",
  "Size": "0.1",
  "Filled": "0",
  "Price": "0",
  "StopPrice": "68950",
  "BoundPrice": "0",
  "Trailing": { "CallbackRate": "1.5", "ActivationPrice": "67000", "Extreme": "70000", "Activated": true },
  "PostOnly": false,
  "ReduceOnly": true,
  "ClosePosition": false,
  "PriceProtect": false,
  "CreateTimestamp": 1775914565478,
  "EntryTimestamp": 1775914565480,
  "EventTimestamp": 1775914600000,
  "Builder": { "Code": "mybuilder", "FeeBps": 10 }
}
```

`WorkingType` is `none` for non-conditional orders; `OriginType`/`AutoCloseType` are `""` unless set. Bracket orders carry `"Strategy": { "ID": "<strategy_id>", "IsPrimary": true|false }`. A triggered trailing stop shows `Type: "market"`, `OriginType: "trailing_stop_market"` and keeps `Trailing`.

### GET /v2/openOrders — Open Orders

Query: `symbol` (optional), same selectors as above, `scope=all` (master + active sub-accounts; not with `vault_id`/`sub_account_id`; `403` for sub-account API wallets).

```json
{ "orders": [ /* Order, newest first; status pending | open | untriggered */ ], "count": 1 }
```
With `scope=all` adds `"accounts": [{ "account_id": "...", "name": "...", "kind": "master" | "sub" }]`.

---

### DELETE /v2/order/cancel

Body (JSON on DELETE — the signature covers its hash): `{ "symbol": "BTC-USD", "order_id": 33428500 }` or `{ "symbol": "BTC-USD", "client_order_id": "my-order-001" }`, plus optional `vault_id` / `sub_account_id`. `order_id` is a JSON number.

```json
{ "order_id": 33428500, "client_order_id": "my-order-001", "symbol": "BTC-USD", "sequence_id": 70804201, "message_id": "1775914565490-0" }
```
`client_order_id` is echoed only when used; it is resolved against working orders (newest wins) and returns `404 order not found` if none. An unknown `order_id` is accepted and silently dropped by the engine. Errors: `400 either order_id or client_order_id parameter is required`.

### DELETE /v2/order/cancel-all

Body `{}` (all symbols) or `{ "symbol": "BTC-USD" }`; an empty body is `400 {"error":"EOF"}`. Cancels open, pending and untriggered orders (TP/SL included).

**Bot orders on the same account are canceled too.** Grid bot orders (`client_order_id` `<bot_id>:grid-<n>:entry|:tp|:sl`, bot IDs start with `grid-`) are not exempt: a canceled grid **entry** permanently removes that grid level, while a canceled grid TP/SL on a filled level is re-placed by the bot (see strike-grid-bot). Copy-trading orders (`copy:<subscription_id>:<lead_order_id>`) are always market IOC and never rest, so cancel-all does not affect them in practice. To spare bots, cancel your own orders by ID instead.

```json
{ "account_id": "...", "symbol": "BTC-USD", "canceled_count": -1, "sequence_id": 70804203, "message_id": "..." }
```
`canceled_count` is always `-1` (async); `symbol` is omitted when not filtered.

---

### POST /v2/orders/batch — Independent Creates

```json
{ "orders": [ /* CreateOrder bodies, min 1 */ ], "vault_id": "optional", "sub_account_id": "optional" }
```
Each order is placed separately (own sequence ID, any symbol, no atomicity). Request-level failures reject the whole batch (binding errors, a reserved `client_order_id` prefix in any item, builder-fee errors, `vault_id` + `sub_account_id`, `403` sub-account ownership); once those pass the response is `200`:
```json
{ "successful": [ /* CreateOrder responses */ ], "failed": [ { "index": 1, "error": "invalid_symbol" } ] }
```
`successful` / `failed` are `null` (not `[]`) when empty. `failed` only holds per-item API-side failures (e.g. `invalid_symbol` for an empty symbol, vault errors); engine rejections come on the user stream, and silently-dropped items (above) still appear in `successful`. Items are not field-validated at bind time.

### Replace endpoints (one engine command each)

| Endpoint | Body |
|---|---|
| `POST /v2/order/replace` | `{ "cancel": { "order_id": 1, "symbol": "BTC-USD" }, "new_order": { /* CreateOrder */ }, "vault_id": "opt" }` — either leg optional |
| `POST /v2/order/replace-batch` | `{ "replacements": [ { "cancel": {...}, "new_order": {...} } ], "vault_id": "opt" }` |
| `POST /v2/orders/replace` | `{ "symbol": "BTC-USD", "orders": [ /* CreateOrder without symbol/vault_id/sub_account_id */ ], "vault_id": "opt" }` — cancels **every** active order on the symbol first: TP/SL and grid bot orders too (same consequences as cancel-all) |

Rules:
- One symbol per request (`mismatched_order_symbol`). Cancel legs need `order_id` (`order_id_not_set`); unknown IDs are skipped.
- Only the top-level `vault_id` selects the vault; on replace-batch an item/leg with a different `vault_id` fails `vault_id mismatch at index i` (`cancel …` / `new_order …`). `sub_account_id` falls back to the first replacement's. `/v2/order/replace` copies its top-level `vault_id` into legs.
- Array items are not field-validated at bind time; an unknown symbol or a create missing `side`/`type` drops the whole command silently (no cancels, no events).
- Max 1000 operations (cancels + creates; cancel-all counts 1). Duplicate `client_order_id` in one request → `400 duplicate_request_id`.
- If any create fails **static** market rules (size/step, tick, price range/bound, min notional), **nothing** is applied — no cancels — and that create is published as `rejected`.
- Otherwise cancels apply first, then creates in order; the first create rejected for another reason (margin, post-only cross, ...) **stops** the batch and later creates are skipped with no order event (`conditional_order_triggers_immediately` does not stop it).
- On replace-batch, per-item build errors (missing legs, vault mismatch, `order_id_not_set`, symbol errors) return `400 {"error": "...", "failed_index": i}`. Command-level errors (`duplicate_request_id`, `invalid_stop_price`, slippage errors, `batch_replace_orders: total operations exceed 1000`) and binding errors are plain `{"error"}`; the other two replace routes never add `failed_index`.

Responses:
```json
// /v2/order/replace
{ "cancel": { "order_id": 33428500, "symbol": "BTC-USD" },
  "new_order": { "client_order_id": "...", "account_id": "...", "symbol": "BTC-USD", "status": "pending" },
  "sequence_id": 70804202, "message_id": "..." }
// /v2/order/replace-batch
{ "sequence_id": 70804204, "message_id": "...", "results": [ { "cancel": {...}, "new_order": {...} } ] }
// /v2/orders/replace
{ "sequence_id": 70804205, "message_id": "...", "account_id": "...", "symbol": "BTC-USD",
  "cancel_all": true, "new_orders": [ { "client_order_id": "...", "account_id": "...", "symbol": "BTC-USD", "status": "pending" } ] }
```

---

### POST /v2/order/strategy — Bracket (TP/SL)

```json
{
  "strategy_id": "019a0c2e-2222-7000-8000-000000000002",
  "client_order_id": "entry-1",
  "symbol": "BTC-USD",
  "side": "buy",
  "type": "limit",
  "size": "0.1",
  "price": "50000",
  "tp_order": { "type": "take_profit", "size": "0.1", "stop_price": "55000" },
  "sl_order": { "type": "stop", "size": "0.1", "stop_price": "48000", "working_type": "mark_price" }
}
```
- `strategy_id` (yours) is required; at least one of `tp_order` / `sl_order` (`400 at least one of tp_order or sl_order must be provided`).
- Primary takes the CreateOrder fields except `callback_rate`, `activation_price`, `slippage` — those are not part of this body and are **silently ignored** if sent (so no trailing primary, no slippage bound).
- Leg fields: `type`, `size`, `stop_price` (required, > 0 — missing or ≤ 0 is `400 invalid_stop_price`), optional `client_order_id`, `price`, `time_in_force`, `working_type`, `post_only`, `price_protect`. Legs are placed on the opposite side with `reduce_only` forced.
- `tp_order.type` ∈ `take_profit`/`take_profit_limit`, `sl_order.type` ∈ `stop`/`stop_limit`; with both legs, TP `stop_price` ≥ SL `stop_price` for a buy primary (≤ for sell). Violations: `400 invalid_secondary_order`.
- Lifecycle: legs stay `pending` until the primary fills, then become `untriggered`. One leg triggering expires the other (`order_strategy_secondary_oco`); a primary that closes unfilled expires the legs (`order_strategy_primary_closed`).

```json
{ "strategy_id": "...", "primary_client_order_id": "entry-1", "tp_client_order_id": "...", "sl_client_order_id": "...",
  "account_id": "...", "symbol": "BTC-USD", "sequence_id": 70804206, "message_id": "..." }
```
`tp_client_order_id` / `sl_client_order_id` are omitted when that leg wasn't sent. Read legs via `GET /v2/openOrders` (`Strategy.ID`); `GET /v2/order/strategy` returns `501 not implemented`.

---

### POST /v2/leverage

`{ "symbol": "BTC-USD", "leverage": 10 }` (1–125 and within the market's margin tiers).
```json
{ "leverage": 10, "maxNotionalValue": "1000000", "symbol": "BTC-USD", "request_id": "019a..." }
```
Applies to the open position too (initial margin recomputed). Async engine rejects (user stream, by `request_id`): decrease on an isolated position (`leverage_decrease_not_allowed`), cross decrease without balance, position above the new tier cap (`position_notional_exceed`). Sync: `400 invalid symbol`, `400 {"error":"leverage exceeds maximum allowed","max_leverage":50,"requested":100}`, `404 account not found`.

### POST /v2/marginMode

`{ "symbol": "BTC-USD", "marginMode": "isolated" }` → `{ "marginMode": "isolated", "symbol": "BTC-USD" }`.
`400 cannot change margin mode while position is open`. The engine also refuses while the symbol has active orders, but this command carries no `request_id`: the refusal is dropped with **no** user-stream event and the API already returned `200`. Confirm with `GET /v2/symbols`.

### GET / PUT /v2/symbols

GET (auth required; `vault_id` / `sub_account_id` query):
```json
{ "default_margin_mode": "cross", "default_leverage": 20,
  "symbol_settings": { "BTC-USD": { "margin_mode": "cross", "leverage": 20 } } }
```
`vault_id` here is leader-only (`403 only vault leader can perform this action on vault account`, `404 vault not found`); `400 vault_id and sub_account_id are mutually exclusive`; `401 account_id not found in auth context` without auth.

PUT takes the same keys (all optional) plus `vault_id` / `sub_account_id` and returns **204** with no body. Disallowed per-symbol changes are skipped silently (mode change with position or orders, leverage decrease with a position, above market max); unknown symbols ignored. Like `/v2/marginMode`, engine-side refusals produce no event — re-read `GET /v2/symbols`. `400 invalid margin mode`, `400 invalid leverage` (default above the highest market max).

### POST /v2/isoMargin

`{ "symbol": "BTC-USD", "amount": "100", "modify_type": "add" }` (`add` | `remove`).
```json
{ "symbol": "BTC-USD", "request_id": "019a...", "sequence_id": 70804207, "message_id": "..." }
```
Sync `400`: `no position found for symbol`, `position must be in isolated margin mode`, `invalid margin amount`. Remove is capped at `IsoBalance − max(InitialMargin − UPnL, MaintenanceMargin)`; engine rejects `invalid_add_margin` / `invalid_reduce_margin` async.

---

### POST /v2/algo/twap — Create TWAP

```json
{ "symbol": "BTC-USD", "side": "BUY", "total_size": "1.5", "duration_sec": 3600,
  "limit_price": "52000", "reduce_only": false, "randomize": true }
```
- `side` uppercase `BUY` | `SELL`; `duration_sec` 300–86400; `limit_price` optional (> 0) — slices that would cross it are skipped and the shortfall rolls forward.
- Slices: `clamp(duration_sec / 30, 5, 120)` market IOC child orders, `client_order_id` `twap-{strategy_id}-{n}`. `total_size` is rounded down to the market step; each slice must meet min size and min notional.
- Max 20 `active` + `cancelling` TWAPs per account. Optional `vault_id` / `sub_account_id`.
- `X-Builder-Fee-Bps` is ignored: TWAP child orders never carry a builder code (no builder fee or attribution).

`201 { "strategy_id": "019a...", "status": "active" }`. Errors: `400 invalid twap request: duration_sec must be >= 300` (and similar), `409 twap concurrent limit exceeded`, `503 algo twap service not configured`.

### GET /v2/algo/twap · GET /v2/algo/twap/{id} · DELETE /v2/algo/twap/{id}

List query: `status` (empty/`active` → active + cancelling, `all`, or an exact status), `scope=all`, selectors (`account_id`, `vault_id`, `blockchain_address`, `sub_account_id`). Public reads omit `last_error`.
```json
{ "strategies": [ {
  "strategy_id": "019a...", "account_id": "...", "market": "BTC-USD", "status": "active", "side": "BUY",
  "total_size": "1.5", "filled_size": "0.75", "duration_sec": 3600, "slices_fired": 60, "nominal_slices": 120,
  "created_at_ms": 1775914565478, "updated_at_ms": 1775916365478
} ] }
```
`completed_at_ms` and `last_error` appear only when set. Statuses: `pending`, `active`, `cancelling`, `completed`, `cancelled`, `expired`, `failed`, `liquidated`. GET by id: `404 strategy not found`.

DELETE (query `vault_id` / `sub_account_id` if needed) → `{ "strategy_id": "...", "status": "cancelling" }`; the worker finishes any in-flight slice, then `cancelled`. `404 strategy not found or not active`.

---

## Examples

```typescript
// Post-only bid
await strike("POST", "/v2/order", {
  client_order_id: `bid-${Date.now()}`, symbol: "BTC-USD", side: "buy",
  type: "limit", size: "0.1", price: "50000", post_only: true,
});

// Market sell, 1% max slippage, 10 bps builder fee
await strike("POST", "/v2/order",
  { symbol: "BTC-USD", side: "sell", type: "market", size: "0.1", slippage: "0.01" }, 10);

// Reduce-only stop loss and trailing stop on a long
await strike("POST", "/v2/order", {
  symbol: "BTC-USD", side: "sell", type: "stop", size: "0.1", stop_price: "48000", reduce_only: true,
});
await strike("POST", "/v2/order", {
  symbol: "BTC-USD", side: "sell", type: "trailing_stop_market", size: "0.1",
  callback_rate: "1.5", activation_price: "67000", reduce_only: true,
});

// Market maker: replace the whole quote set on one symbol atomically
await strike("POST", "/v2/orders/replace", {
  symbol: "BTC-USD",
  orders: [
    { client_order_id: "q-bid-1", side: "buy",  type: "limit", size: "0.2", price: "49990", post_only: true },
    { client_order_id: "q-ask-1", side: "sell", type: "limit", size: "0.2", price: "50010", post_only: true },
  ],
});

// Cancel by client ID, then confirm state
await strike("DELETE", "/v2/order/cancel", { symbol: "BTC-USD", client_order_id: "q-bid-1" });
const o = await strike<any>("GET", "/v2/order?symbol=BTC-USD&client_order_id=q-bid-1");
console.log(o.Status, o.CloseReason);

// TWAP
await strike("POST", "/v2/algo/twap", { symbol: "BTC-USD", side: "BUY", total_size: "5", duration_sec: 3600 });
```

---

## Order Statuses

| Status | Description |
|--------|-------------|
| `pending` | Sequenced, not yet processed (also bracket legs waiting for the primary fill) |
| `open` | Resting on the book (may be partially filled) |
| `untriggered` | Conditional order waiting for its trigger |
| `filled` | Fully executed |
| `canceled` | Canceled by user/system, or market remainder canceled |
| `rejected` | Failed engine validation — see `CloseReason` |
| `expired` | IOC/FOK remainder, OCO leg, or resting order removed by self-trade prevention |

## Auto Close Types (`AutoCloseType`, system orders)

| Type | Description |
|------|-------------|
| `liquidation` | Liquidation order |
| `adl` | Auto-deleveraging |
| `bankrupt` | Bankruptcy close |
| `if_transfer` | Insurance-fund position transfer |
| `vault_withdrawal` | Position close for a vault withdrawal |
| `slp_transfer` | SLP position transfer |

## Notes

- Direct Market Access (`direct-eu.strikefinance.org`) is provisioned by Strike per API wallet (IP allowlist + scopes). It serves only: `POST /v2/order`, `/v2/orders/batch`, `/v2/orders/replace`, `/v2/order/replace`, `/v2/order/replace-batch`, `DELETE /v2/order/cancel`, `/v2/order/cancel-all`, and `GET /v2/order`, `/v2/openOrders`, `/v2/history/order`, `/v2/history/fill`, `/v2/account`, `/v2/symbols`, `/v2/balances`, `/v2/positions`, `/v2/closedPositions`, `/v2/history/funding` (plus a few public market routes). Strategy, leverage, marginMode, `PUT /v2/symbols`, isoMargin and TWAP return `403 route is not available on the direct endpoint`. Unprovisioned wallets get `403 direct market access denied`; exceeding the profile quota gives `429 direct market access denied`.
- Related skills: `strike-grid-bot` (grid bots), `strike-copy-trading` (copy trading), `strike-rfq` (request-for-quote), `strike-vaults` (vault management; the `vault_id` selector above is how a vault leader trades).
