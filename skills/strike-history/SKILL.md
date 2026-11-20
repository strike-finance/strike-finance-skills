---
name: strike-history
description: Strike Finance positions and history endpoints -- open positions, order history, fill history, position history (partial/full closes with per-fill legs), funding payments, transactions, closed positions, and whole-history exports (orders, fills, funding as gzipped JSONL). Covers account/sub-account/vault scoping, cursors and limits. Use when building trade history views, PnL analytics, tax/accounting exports, or reconciling a bot after a reconnect.
---

# Strike Finance History

| Environment | Base URL |
|-------------|----------|
| Mainnet | `https://api.strikefinance.org` |
| Testnet | `https://api-v2-testnet.strikefinance.org` |

All routes below are on the FlexibleAuth group (`GET`, plus the `POST .../export` job starters): send API wallet headers (see `strike-auth`) to read your own account, or omit them and pass a public selector. Balances and portfolio are in `strike-account`; open orders (`GET /v2/openOrders`) are in `strike-trading`; the formulas behind position fields are in `strike-calculations`.

---

## Account Selection (all endpoints below)

Resolution order (first match wins):

| Selector | Auth | Notes |
|----------|------|-------|
| `account_id` | none | Must be a UUID, else `400 {"error":"invalid account_id"}` |
| `vault_id` | none | Vault ID (not the vault's `vault_...` account ID). Unknown vault -> `400 {"error":"invalid vault id"}` |
| `blockchain` + `blockchain_address` | none | Chain-qualified wallet lookup |
| `blockchain_address` | none | Chain inferred from address shape. Max 512 bytes. No account for the address -> `404 {"error":"user not found"}` |
| *(none)* | required | The authenticated account (an API wallet bound to a sub-account reads that sub-account) |
| `sub_account_id` | required | An active sub-account owned by the caller (the caller's own ID is also accepted); ignored when a public selector is present. Not owned/not active -> `401` with the no-selector message below |

With no selector and no auth: `401 {"error":"authentication required or provide vault_id, account_id, or blockchain_address"}`.

**`scope=all`** (every endpoint below except `/v2/closedPositions`, which ignores `scope`, and the exports, which reject it): reads the master account plus its active sub-accounts. The family is the caller's, or the family of a public `account_id`/`blockchain_address` (naming a sub-account widens to its parent's family). Cannot be combined with `vault_id` or `sub_account_id` (400). Any other `scope` value -> `400 {"error":"invalid scope: only scope=all is supported"}`. API wallets bound to a sub-account get 403 for private `scope=all`. Responses then also carry `accounts: [{account_id, name, kind: "master"|"sub"}]`.

**`include_copies=true`** (`/v2/history/order`, `/v2/history/fill`, `/v2/history/position` only): authenticated reads only (`401 authentication required for include_copies`); returns the selected account's rows plus copy-trading executions (`client_order_id` prefix `copy:`) from the caller's other family accounts. Cannot be combined with `scope`, `account_id`, `blockchain_address`, or `vault_id`; accepts `sub_account_id`. API wallets bound to a sub-account get 403. The value is a boolean (`true`/`false`, `1`/`0`; anything else -> `400 include_copies must be a boolean value (for example, true/false or 1/0)`); false or omitted means a normal read. These responses also carry the `accounts` block. With `scope=all` or `include_copies=true`, `fromId`/`fromOrderID` act as a `(timestamp, id)` keyset on the cursor row rather than a plain id bound.

---

## Conventions

- Decimals are strings (full precision, e.g. `"79211.400000000000000000"`); timestamps are Unix milliseconds.
- `startTime`/`endTime` are inclusive (`>=`, `<=`). Non-integer values -> 400 `invalid startTime parameter` / `invalid endTime parameter` (`/v2/history/position` instead says `invalid startTime` / `invalid endTime` and also rejects negative values).
- `limit` above the max is clamped; `limit <= 0` uses the default; a non-integer `limit` -> 400 (except `/v2/history/position*`, which rejects values outside 1-200).
- Errors are `{"error": "<message>"}`.
- **Empty results:** `/v2/history/order`, `/v2/history/fill`, `/v2/history/funding`, `/v2/history/transaction` and `/v2/closedPositions` return `null` (not `[]`) for the list when nothing matches. Always coalesce: `data.fills ?? []`.

---

## GET /v2/positions -- Open Positions

Current non-zero positions, most recently updated first. Accepts the selectors above and `scope=all` (rows from every family account plus `accounts`).

| Param | Description |
|-------|-------------|
| `symbol` | Filter |
| `position_id` | Engine position ID (unsigned integer); requires `symbol` (else `400 symbol parameter is required when position_id is provided`) |

```json
{
  "positions": [
    {
      "id": 3232,
      "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
      "margin_mode": "cross",
      "leverage": 20,
      "size": "-0.09397",
      "entry_price": "81558.69091944",
      "iso_balance": "0",
      "accumulated_funding_fees": "270.2568393349164184",
      "create_timestamp": 1791865713298,
      "update_timestamp": 1791865713298,
      "symbol": "BTC-USD",
      "upnl": "-8.48714642",
      "maintenance_margin": "30.69022933",
      "bankruptcy_price": "157758.0419616276541",
      "liquidation_price": "156750.9643582120454"
    }
  ],
  "count": 1
}
```

- `size` is signed (negative = short); there is no separate side field. `iso_balance` is `"0"` for cross.
- `upnl` and `maintenance_margin` use the current mark price and are rounded to the market's `quote_prec`; `bankruptcy_price` / `liquidation_price` are unrounded and `"0"` when none.
- `accumulated_funding_fees` is signed (positive = received) and is not part of `upnl`.
- `update_timestamp` advances on fills, non-zero funding, margin and leverage changes; it equals the userstream position update's `T` for the same state. Millisecond values can tie.
- Unknown account: `404 {"error":"account not found"}`.
- `GET /v2/account?include_positions=true` returns the same rows (as `positions`, always an array) together with balances from one account read; add `include_snapshot_timestamp=true` for the read's Unix-ms `snapshot_timestamp` (see `strike-account`).

---

## GET /v2/history/order -- Order History

Sorted by `create_timestamp` DESC.

| Param | Description |
|-------|-------------|
| `symbol` | e.g. `BTC-USD` |
| `side` | `buy` \| `sell` |
| `type` | `market`, `limit`, `stop`, `stop_limit`, `take_profit`, `take_profit_limit`, `trailing_stop_market` |
| `status` | Integer: `1` pending, `2` open, `3` filled, `4` canceled, `5` untriggered, `6` rejected, `7` expired |
| `order_id` | Exact order ID |
| `startTime`, `endTime` | Filter on `create_timestamp` |
| `limit` | Default 100, max 1000 |
| `fromOrderID` | Cursor: returns orders with `id` **less than** this value (pass the last row's `id`) |
| `source` | `twap`, `grid`, or `copy` (filters by `client_order_id` prefix `twap-`, `grid-`, `copy:`); anything else -> 400 `invalid source parameter` |

Response:

```json
{
  "orders": [
    {
      "id": 243140293,
      "client_order_id": "my-order-001",
      "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
      "symbol": "BTC-USD",
      "strategy_id": null,
      "is_primary": null,
      "close_reason": null,
      "side": "buy",
      "status": "filled",
      "type": "limit",
      "origin_type": "",
      "auto_close_type": null,
      "stp_mode": "expire_maker",
      "time_in_force": "GTC",
      "working_type": "none",
      "size": "0.008900000000000000",
      "filled": "0.008900000000000000",
      "price": "79211.400000000000000000",
      "stop_price": "0.000000000000000000",
      "post_only": false,
      "reduce_only": false,
      "close_position": false,
      "price_protect": false,
      "create_timestamp": 1792172836754,
      "entry_timestamp": 1792172836754,
      "event_timestamp": 1792172836754
    }
  ],
  "count": 1
}
```

- `time_in_force`: `GTC` \| `IOC` \| `ALO` (post-only). Orders placed before FOK was removed keep their `FOK` label. `post_only` is `true` exactly when `time_in_force` is `ALO`; most post-only orders placed before the ALO cutover (November 2026) read `GTC` with `post_only: false` (their stored post-only flag is no longer returned).
- `stp_mode`: `expire_maker` (default) \| `expire_taker` \| `expire_both`.
- `working_type`: `none` \| `contract_price` \| `mark_price`.
- `auto_close_type`: `null`/`""` for user orders, else `liquidation`, `adl`, `bankrupt`, `if_transfer`, `vault_withdrawal`, `slp_transfer`.
- The SLP Vault's ALO (post-only) quotes that end without any fill are never written to order history (or order exports), so its quote churn is missing from `/v2/history/order?vault_id=<SLP vault>`; an SLP order that fills is recorded in full. Other accounts are unaffected.
- `error_message` (only when `close_reason` is non-empty) repeats `close_reason`. Trailing stops add `callback_rate`, `activation_price`, `trailing_extreme`, `trailing_activated`.

---

## GET /v2/history/fill -- Fill History

Sorted by `timestamp` DESC (or `trade_id` ASC with `since_trade_id`).

| Param | Description |
|-------|-------------|
| `symbol`, `side` (`buy`\|`sell`), `role` (`maker`\|`taker`) | Filters |
| `order_id` | Fills of one order |
| `auto_close_type` | e.g. `liquidation`, `adl` (matched against the order) |
| `startTime`, `endTime` | Filter on fill `timestamp` |
| `limit` | Default 500, max 1000 |
| `fromId` | Backward cursor: fills with internal `id` less than this value (pass the last row's `id`) |
| `since_trade_id` | Forward cursor: fills with `trade_id` greater than this value, ascending. **Cannot be combined with `fromId`** (400) |
| `source` | `twap`, `grid`, `copy` |
| `aggregate` | `true` = one row per order (VWAP `price`, summed `size`/`fee`/`realized_pnl`, plus `fill_count`, `notional`; `role`/`fee_type` may be `mixed`) |

Response:

```json
{
  "fills": [
    {
      "id": 36026,
      "trade_id": 18073,
      "order_id": 243140293,
      "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
      "symbol": "BTC-USD",
      "side": "buy",
      "role": "taker",
      "price": "79211.400000000000000000",
      "size": "0.008900000000000000",
      "realized_pnl": "20.890889183016000000",
      "fee": "3.563013000000000000",
      "fee_type": "commission",
      "entry_price": "81558.690919440000000000",
      "close_price": "79211.400000000000000000",
      "margin": "36.293617459150800000",
      "roi_pct": "57.560779678490627210",
      "leverage": 20,
      "timestamp": 1792172836754,
      "auto_close_type": null,
      "client_order_id": "my-order-001"
    }
  ],
  "count": 1
}
```

- `fee_type`: `none`, `commission`, `liquidation`, `funding`. `liquidation_fee` is present (positive string) when the fill paid a liquidation fee.
- `entry_price`, `close_price`, `margin`, `roi_pct`, `leverage` appear only on position-reducing fills.
- To poll new fills after a reconnect, keep the largest `trade_id` you have seen and call `?since_trade_id=<it>`.

---

## GET /v2/history/position -- Position History

One row per directional position life (open -> partial closes -> close). A flip through zero closes one row and opens another. Only rows with at least one reduction appear in `positions`; rows are sorted by `open_timestamp` DESC.

| Param | Description |
|-------|-------------|
| `symbol` | Filter |
| `side` | `long` \| `short` (else 400) |
| `status` | `closed` \| `partially_closed` (else 400) |
| `startTime`, `endTime` | Filter on `last_close_timestamp` (latest reduction); `startTime > endTime` -> 400 |
| `limit` | 1-200, default 50 (out of range -> 400) |
| `cursor` | Opaque; pass `next_cursor` from the previous page |

Response:

```json
{
  "positions": [
    {
      "id": "fill:34930",
      "position_id": "3232",
      "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
      "symbol": "BTC-USD",
      "side": "short",
      "status": "partially_closed",
      "margin_mode": "cross",
      "leverage": 20,
      "entry_price": "82278.69871920726862",
      "avg_close_price": "81613.18136829993015",
      "realized_pnl": "297.8615846216001626",
      "trading_fees": "0",
      "funding_pnl": "270.2568393349164184",
      "net_realized_pnl": "568.1184239565165810",
      "roi_pct": "39.82902353316207558",
      "max_held": "0.25787",
      "closed_size": "0.3459",
      "remaining_size": "0.09397",
      "open_timestamp": 1791865713298,
      "close_timestamp": null,
      "last_close_timestamp": 1792172836754,
      "update_timestamp": 1792407600006,
      "last_fill_id": "36026",
      "last_fill_seq": 21,
      "revision": 52,
      "data_complete": true,
      "opened_size": "0.43987",
      "entry_notional": "36191.93120561770125",
      "close_notional": "28229.99943529494584",
      "closing_margin": "1426.3930509958273",
      "funding_baseline": "0"
    }
  ],
  "position_checkpoints": [],
  "count": 1,
  "has_more": true,
  "next_cursor": "eyJ0IjoxNzkxODY1NzEzMjk4LCJpIjoiZmlsbDozNDkzMCJ9",
  "account_ids": ["01a144dc-27e4-706c-ac46-9c2c1e77d60b"]
}
```

- `realized_pnl` excludes fees and funding; `trading_fees` includes trading, builder and liquidation fees; `net_realized_pnl = realized_pnl - trading_fees + funding_pnl`; `roi_pct = net_realized_pnl / closing_margin * 100`.
- `position_checkpoints` (not filtered or paged) is the latest life per account/symbol, including never-reduced open positions and the latest closed one; seed live state from it and apply later fills whose `position_seq` is greater than `last_fill_seq`.
- `data_complete: false` = the position was already open when tracking started; its totals are partial.
- With `include_copies=true`, rows add `has_copied_fills` and the body adds `includes_copies: true`. With `scope=all` or `include_copies=true` the body adds `accounts`.

### GET /v2/history/position/:id/fills -- Position Legs

`:id` is a position-history `id` (e.g. `fill:34930`). Same account selection (`scope=all` allowed; `include_copies` is ignored). `limit` 1-200 (default 50), `cursor` from `next_cursor`.

```json
{
  "position": { "id": "fill:34930", "...": "same shape as a positions[] row, or null" },
  "fills": [
    {
      "history_id": "fill:34930",
      "fill_id": "36026",
      "trade_id": "18073",
      "order_id": "243140293",
      "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
      "symbol": "BTC-USD",
      "side": "buy",
      "action": "decrease",
      "size": "0.0089",
      "price": "79211.4",
      "realized_pnl": "20.890889183016",
      "fee": "0",
      "order_type": "market",
      "role": "taker",
      "timestamp": 1792172836754,
      "revision": 52
    }
  ],
  "count": 1,
  "next_cursor": "",
  "has_more": false,
  "account_ids": ["01a144dc-27e4-706c-ac46-9c2c1e77d60b"]
}
```

`action`: `open`, `increase`, `decrease`, `close`. IDs are strings. A flip fill appears in both lives with its size/fee allocated per leg.

---

## GET /v2/history/funding -- Funding Payments

Sorted by `id` DESC.

| Param | Description |
|-------|-------------|
| `symbol` | Filter |
| `position_side` | `Long` \| `Short` (case-sensitive) |
| `startTime`, `endTime` | Filter on `timestamp` |
| `limit` | Default 500, max 1000 |
| `fromId` | Cursor: records with `id` less than this value |

```json
{
  "funding": [
    {
      "id": 207238,
      "transaction_id": 246273,
      "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
      "position_id": 3232,
      "symbol": "BTC-USD",
      "position_size": "0.093970000000000000",
      "position_side": "Short",
      "funding_rate": "0.000012500000000000",
      "amount": "0.096349523795704004",
      "timestamp": 1792407600000
    }
  ],
  "count": 1
}
```

`amount` > 0 = received, < 0 = paid. `position_size` is absolute.

---

## GET /v2/history/transaction -- Balance Transactions

Every balance-changing event. Sorted by `timestamp` DESC, `id` DESC.

| Param | Description |
|-------|-------------|
| `type` | Comma-separated or repeated; integers or names: `1` deposit, `2` withdraw, `3` fee, `4` realized_pnl, `5` liquidation, `6` funding, `7` reward_grant, `8` reward_reclaim, `9` credit, `10` transfer, `11` liquidation_income. The name `pnl_adjustment` (no integer) selects operator PnL corrections only: `realized_pnl` rows whose `metadata` has an `adjustment_reason`, without the per-fill realized PnL rows |
| `status` | Integer only: `1` pending, `2` completed, `3` pending_settlement, `4` settled, `5` failed, `6` cancelled (else 400) |
| `startTime`, `endTime` | Filter on `timestamp` |
| `limit` | Default 100, max 1000 |
| `fromId` | Cursor: pass the last row's `id` (keyset on `(timestamp, id)`) |

```json
{
  "transactions": [
    {
      "id": 246185,
      "request_id": "fill:36026:pnl",
      "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
      "type": "realized_pnl",
      "amount": "20.890889183016000000",
      "blockchain": "",
      "blockchain_address": "",
      "tx_hash": null,
      "recipient_address": null,
      "status": "completed",
      "timestamp": 1792172836755,
      "asset_symbol": null,
      "asset_amount": null
    }
  ],
  "count": 1
}
```

Optional keys: `asset`, `metadata` (JSON object), `settlement_tx_hash`. Public-selector reads null out `recipient_address` and strip the recipient type from `metadata`.

---

## GET /v2/closedPositions -- Closed Engine Positions (legacy)

Minimal rows from the `positions` table where `close_timestamp` is set, sorted by `close_timestamp` DESC. No `scope=all`, no cursor.

| Param | Description |
|-------|-------------|
| `symbol` | Filter |
| `startTime`, `endTime` | Filter on `close_timestamp` |
| `limit` | Default 100, max 1000 |

```json
{
  "positions": [
    {
      "ID": 3232,
      "AccountID": "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
      "Symbol": "BTC-USD",
      "MarginMode": "cross",
      "OpenTimestamp": 1791865713298,
      "CloseTimestamp": 1792172836754
    }
  ],
  "count": 1
}
```

Keys are PascalCase and carry no size/PnL. Prefer `/v2/history/position?status=closed` for PnL.

---

## History Exports (orders, fills, funding)

Whole-history downloads of one account, run as background jobs. Use them instead of paging the history endpoints for tax/accounting dumps.

| Start (`POST`, no body) | Poll (`GET`) | File rows |
|-------------------------|--------------|-----------|
| `/v2/orders/export` | `/v2/orders/export/:jobId` | Order rows (below), archived orders oldest day first, then live orders by `id` ascending |
| `/v2/fills/export` | `/v2/fills/export/:jobId` | `/v2/history/fill` rows (no aggregate fields), oldest first by (`timestamp`, `id`) |
| `/v2/funding/export` | `/v2/funding/export/:jobId` | `/v2/history/funding` rows, `id` descending |

- **Account selection** is the same query string as the history reads: `account_id`, `vault_id`, `blockchain`+`blockchain_address` or `blockchain_address` export any account without auth; with no selector the signer's own account (optionally `sub_account_id`). Poll with the **same selector**: a job polled for a different account returns 404. `scope` or `include_copies` (any value) -> `400 an export covers one account; scope=all and include_copies are not supported`.
- `POST` -> `202 {"job_id":"1a2b3c4d"}`. Sign it like any POST with an empty body.
- `GET` -> `{"status":"queued"}` / `{"status":"processing"}` / `{"status":"failed","error":"export failed, please try again later"}` / `{"status":"complete","download_url":"https://...","count":12345,"expires_at":"2026-11-22T10:00:00Z"}` (orders also repeat `count` as `order_count`). `count` is the number of rows.
- `download_url` is a presigned link (no auth headers), valid until `expires_at` (24 h by default). Job status is kept 24 h. A job that waits more than 30 min in the queue, or runs more than 60 min, ends `failed`.
- The file is gzipped JSON Lines, one row per line, possibly several concatenated gzip members (standard gunzip readers handle this).
- Limits: one export queued or running per requester (the authenticated account, else the client IP) -> `429 you already have an export queued or running; wait for it to finish`; one per account and kind -> `409 an export is already in progress for this account`. Other errors: `404 export job not found or expired`, `503 history export is not configured`, plus the account-selection errors above.
- **Order rows** have the `/v2/history/order` keys plus `cost`, `fee`, `created_at`, `updated_at` (RFC 3339 strings); null fields are omitted rather than `null`, and there is no `error_message`. Live rows carry `stp_mode` but no `post_only`; archived rows written before the ALO cutover carry `post_only` and no `stp_mode`.
- **Fill rows**: a fill that paid two liquidation-fee transactions can appear twice; dedupe by `id`.

```typescript
import { gunzipSync } from "node:zlib";

// signed() adds the X-API-Wallet-* headers (see strike-auth); the signed path includes the query string.
// selector: "" for the signer's own account, or e.g. "?sub_account_id=..." / "?account_id=..." (same on POST and GET).
async function exportHistory(
  signed: (method: "GET" | "POST", pathWithQuery: string) => Promise<Response>,
  kind: "orders" | "fills" | "funding",
  selector = ""
): Promise<any[]> {
  const start = await signed("POST", `/v2/${kind}/export${selector}`);
  const started = await start.json();
  if (start.status !== 202) throw new Error(`${start.status} ${started.error}`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await signed("GET", `/v2/${kind}/export/${started.job_id}${selector}`);
    const job = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${job.error}`);
    if (job.status === "failed") throw new Error(job.error);
    if (job.status !== "complete") continue; // queued | processing
    const file = await fetch(job.download_url);
    const text = gunzipSync(Buffer.from(await file.arrayBuffer())).toString("utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
}
```

---

## Pagination Helper

```typescript
const BASE = "https://api.strikefinance.org";

interface Fill {
  id: number;
  trade_id: number;
  order_id: number;
  symbol: string;
  side: "buy" | "sell";
  role: "maker" | "taker";
  price: string;
  size: string;
  fee: string;
  realized_pnl: string;
  timestamp: number;
}

// signedGet adds the X-API-Wallet-* headers (see strike-auth). The signed path
// must include the query string exactly as sent.
async function fetchAllFills(
  signedGet: (pathWithQuery: string) => Promise<Response>,
  symbol?: string
): Promise<Fill[]> {
  const all: Fill[] = [];
  let fromId: number | undefined;
  for (;;) {
    const q = new URLSearchParams({ limit: "1000" });
    if (symbol) q.set("symbol", symbol);
    if (fromId !== undefined) q.set("fromId", String(fromId));
    const res = await signedGet(`/v2/history/fill?${q}`);
    if (!res.ok) throw new Error(`${res.status} ${(await res.json()).error}`);
    const body = await res.json();
    const page: Fill[] = body.fills ?? []; // null when empty
    all.push(...page);
    if (page.length < 1000) return all;
    fromId = page[page.length - 1].id;
  }
}

// Public read, no auth: a vault's funding payments.
async function vaultFunding(vaultId: string) {
  const res = await fetch(`${BASE}/v2/history/funding?vault_id=${vaultId}&limit=100`);
  const body = await res.json();
  return body.funding ?? [];
}
```

| Endpoint | Cursor param | Next value |
|----------|--------------|------------|
| `/v2/history/order` | `fromOrderID` | last row `id` |
| `/v2/history/fill` | `fromId` / `since_trade_id` | last row `id` / max `trade_id` |
| `/v2/history/funding` | `fromId` | last row `id` |
| `/v2/history/transaction` | `fromId` | last row `id` |
| `/v2/history/position`, `/:id/fills` | `cursor` | `next_cursor` (stop when `has_more` is false) |
| `/v2/closedPositions` | none | narrow `endTime` instead |
