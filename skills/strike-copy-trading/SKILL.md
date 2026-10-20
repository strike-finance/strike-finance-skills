---
name: strike-copy-trading
description: Strike Finance copy trading -- follow a Strike account or an external Hyperliquid wallet, subscribe/update/stop (fixed ratio or fixed margin per entry, ratio multiplier, minimum entry, per-symbol and total margin caps, excluded symbols, stop loss, following the lead's leverage/margin mode, copying open positions, managed copy sub-accounts), funds reservation, Strike-lead profit share, copied orders and positions, trader discovery, leaderboard, copiers, lead stats and bookmarks. Use when building a copy-trading UI or bot, picking traders to copy, or reconciling copy-placed orders.
---

# Strike Finance Copy Trading

| Environment | Base URL |
|-------------|----------|
| Mainnet | `https://api.strikefinance.org` |
| Testnet | `https://api-v2-testnet.strikefinance.org` |

Writes need API wallet auth headers (see **strike-auth**). Copied orders are ordinary orders on the follower account: see **strike-trading** (order model), **strike-history** (history, `source=copy`, `include_copies`), **strike-userstream** (events).

## Concepts

- **Lead**: either a Strike account (`platform: "strike"`, `lead_account_id` = Strike account UUID) or a Hyperliquid wallet (`platform: "hyperliquid"`, `lead_account_id` = `0x` + 40 hex, stored lowercase). A Hyperliquid lead is an external trader with no Strike account. Any non-vault Strike account can be copied; there is no lead opt-in.
- **Follower**: the account that receives copied orders -- the caller, an owned sub-account (`sub_account_id`), or a managed copy sub-account created for the copy (`auto_create_sub_account`).
- **Subscription**: one follower copying one lead. One `active` subscription per (follower account, lead); the same lead can be copied from different sub-accounts.
- **Copying is fill-based**: when the lead's trade executes, each follower gets a **market IOC** order (same side; reduce-only for lead reductions). Followers are placed one after another, oldest subscription first (ties by subscription id), so earlier copiers hit the book first. Resting lead orders and lead cancels are not mirrored.
- Decimals are strings in responses; requests accept strings or numbers. Timestamps are Unix ms. Unknown body fields are ignored.

## Auth groups

| Group | Routes |
|-------|--------|
| Public (no auth) | `GET /v2/copy/lead-traders`, `/v2/copy/leaderboard`, `/v2/copy/copiers`, `/v2/copy/discover`, `/v2/copy/discover/filters`, `/v2/copy/discover/:address` |
| API wallet or JWT required | `POST /v2/copy/saved`, `DELETE /v2/copy/saved/:account_id` |
| Trading (API wallet or JWT) | `POST /v2/copy/subscribe`, `PATCH /v2/copy/subscribe/:id`, `DELETE /v2/copy/subscribe/:id` |
| Read (FlexibleAuth) | `GET /v2/copy/subscriptions`, `/v2/copy/orders`, `/v2/copy/positions` (own account, owned `sub_account_id`, or public via `account_id` / `blockchain_address` / `vault_id`); `GET /v2/copy/lead/stats`, `/v2/copy/saved` (own account only: `401 {"error":"account_id not found in auth context"}` without auth) |
| JWT-only (Strike app) | `/v2/copy/labels` (private trader nicknames/notes) |

- No copy route is masterOnly. An API wallet bound to a sub-account acts on that sub-account (subscribe, stop, list, bookmarks), but gets `403` for managed copy accounts (`copy accounts must be created by their parent account`) and for private `scope=all` (`scope=all is not available to sub-account API keys`).
- `sub_account_id` must be an owned, active sub-account: `403 {"error":"sub-account access denied"}` otherwise (also on the read routes above). Copy writes have no `vault_id` selector; vaults can neither copy nor be copied.
- Every route returns `503 {"error":"copy trading is disabled"}` when the feature is off.

```typescript
import { authenticatedFetch } from "./auth"; // Ed25519 signer from strike-auth

const BASE = "https://api.strikefinance.org";
const PRIVATE_KEY: Uint8Array = loadApiWalletPrivateKey(); // your API wallet secret (32 bytes)
const PUBLIC_KEY_HEX: string = loadApiWalletPublicKeyHex(); // 64 hex chars
const SUB_ID = "019a0c2e-3333-7000-8000-000000000003";     // an owned sub-account to copy from

export async function copyApi<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  pathAndQuery: string,      // e.g. "/v2/copy/orders?limit=50"
  body?: unknown,
): Promise<T> {
  const res = await authenticatedFetch(BASE, pathAndQuery, { method, body }, PRIVATE_KEY, PUBLIC_KEY_HEX);
  const text = await res.text();                         // PATCH / DELETE subscribe return 204, no body
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${json?.error ?? text}`), { status: res.status, body: json });
  return json as T;
}
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v2/copy/subscribe` | Start copying (201; 202 while a managed account is being set up) |
| PATCH | `/v2/copy/subscribe/:id` | Change settings of an active subscription (204) |
| DELETE | `/v2/copy/subscribe/:id` | Stop and close copied positions (204) |
| GET | `/v2/copy/subscriptions` | Follower's subscriptions with live PnL |
| GET | `/v2/copy/orders` | Copy-triggered orders (incl. skipped/failed attempts) |
| GET | `/v2/copy/positions` | Open positions split per subscription |
| GET | `/v2/copy/lead/stats` | Strike lead dashboard (copiers, volume, profit share) |
| POST / DELETE / GET | `/v2/copy/saved[/:account_id]` | Bookmarks (no copying) |
| GET | `/v2/copy/lead-traders` | Leads with active followers + platform limits |
| GET | `/v2/copy/leaderboard` | Every subscription row by status |
| GET | `/v2/copy/copiers` | Everyone who copied a lead, one row per person |
| GET | `/v2/copy/discover`, `/discover/filters`, `/discover/:address` | Trader discovery (Hyperliquid + Strike) |

---

### POST /v2/copy/subscribe

| Field | Type | Notes |
|---|---|---|
| `lead_account_id` | string, required | Strike account UUID, or Hyperliquid `0x` address (42 chars, any case) |
| `platform` | string | `strike` (default when omitted) \| `hyperliquid`. A `0x` address with the default platform is looked up as a Strike account and fails `404` |
| `copy_mode` | string, required | `fixed_ratio` \| `fixed_amount` |
| `copy_amount` | decimal | `fixed_ratio` only, required, > 0 and ≥ `min_copy_amount`; must not be sent with `fixed_amount` |
| `margin_per_entry_order` | decimal | `fixed_amount` only, required, > 0 and ≥ `min_margin_per_entry_order`; must not be sent with `fixed_ratio` |
| `ratio_multiplier` | decimal | `fixed_ratio` only. Integer `1`–`10`, default `1` |
| `minimum_entry` | decimal | `fixed_ratio` only. Minimum USD **notional** per entry, ≥ 0, default `0` (off) |
| `max_margin_per_symbol` | decimal | Optional cap on margin in any one market. Must be > 0 (and ≥ `margin_per_entry_order`) when sent |
| `max_margin_total` | decimal | Optional cap on margin across all markets. Same rules |
| `excluded_symbols` | string[] | Strike markets never opened/increased, e.g. `["DOGE-USD"]`. ≤ 500 items, each 1–32 chars; upper-cased, de-duplicated; not checked against listed markets |
| `stop_loss_amount` | decimal | USD loss that ends the copy. ≥ 0; `0`/omitted = none |
| `margin_mode_source`, `leverage_source` | string | `account` (default) \| `lead`. `lead` only with `auto_create_sub_account` |
| `max_leverage` | integer | Cap on a followed lead leverage; `0`/omitted = none; ≤ highest market max leverage |
| `copy_existing_positions` | bool | Also mirror the lead's open positions once, right after subscribing (not stored) |
| `sub_account_id` | string | Follow from an owned sub-account |
| `auto_create_sub_account`, `request_id`, `source_account_id`, `funding_amount`, `margin_settings` | | Managed copy account, see below |

Checks at subscribe: `fixed_ratio` needs available balance ≥ `copy_amount`; `fixed_amount` needs available ≥ `margin_per_entry_order` (available is after existing copy holds, see Funds). Current minimums and the follower cap come from `GET /v2/copy/lead-traders`.

**Response 201:** `{ "subscription_id": "019a0c2e-4444-7000-8000-000000000004", "status": "active" }`

| Status | `error` |
|---|---|
| 400 | Binding text (Go validator message for a missing `lead_account_id` / `copy_mode`, JSON decode message for a malformed decimal); `invalid inputs` (bad platform/mode, wrong-mode field, malformed HL address, below minimum, above available balance, bad multiplier/minimum/cap/symbols, `max_leverage` too high, negative stop loss, `margin_settings` without `auto_create_sub_account`); `cannot follow yourself` (self, your master, sub-accounts or siblings); `cannot follow a vault account`; `hyperliquid copy trading is disabled` / `strike copy trading is disabled`; `only a copy with its own account can follow the trader's margin mode or leverage`; `sub_account_id cannot be combined with auto_create_sub_account` |
| 403 | `sub-account access denied` |
| 404 | `lead trader account not found` (Strike lead unknown -- also returned when the follower account has no balance record yet) |
| 409 | `already following this trader`; `this trader has reached the maximum number of copiers` (`max_followers_per_lead`, 40); `this account belongs to another copy; choose a different account to copy from` (account is a managed copy's own account) |

#### Managed copy account (`auto_create_sub_account: true`)

Creates a sub-account named after the lead (`Copy · <name>`), optionally applies `margin_settings`, funds it from `source_account_id`, then starts the copy there with `own_account: true` (the only kind that may use `*_source: "lead"`).

```json
{
  "auto_create_sub_account": true,
  "request_id": "d945c718-3349-46fe-aa55-6d224d772cc2",
  "source_account_id": "019a0c2e-1111-7000-8000-000000000001",
  "lead_account_id": "019a0c2e-2222-7000-8000-000000000002",
  "copy_mode": "fixed_amount",
  "margin_per_entry_order": "20",
  "funding_amount": "200",
  "leverage_source": "lead",
  "max_leverage": 10,
  "margin_settings": { "default_margin_mode": "isolated", "default_leverage": 5,
                       "symbol_settings": { "BTC-USD": { "margin_mode": "cross", "leverage": 20 } } }
}
```

- Caller must be a master account; `source_account_id` (required) is the master or an owned active sub-account. `request_id` (required) is your UUID; no `sub_account_id`.
- Funding: `fixed_ratio` funds exactly `copy_amount` (omit `funding_amount`); `fixed_amount` needs `funding_amount` ≥ `margin_per_entry_order`. `margin_settings` takes the `PUT /v2/symbols` fields; disallowed per-market values are skipped.
- Setup advances in the background (about every 2 s) and on each repeated POST. **Read its status by repeating the identical POST** with the same `request_id`; there is no setup-status event (funding/refund only show up as internal-transfer events, below). `202` + `status` `creating_account` | `funding` | `refunding`; `201` + `status: "active"` + `subscription_id`. Body always carries `sub_account_id`, `sub_account_name`, `subscription_id` (`""` until active) and, when relevant, `error`.
- Terminal `409` bodies keep the same shape with `status` `failed` | `stopped` | `refunded` | `refund_failed`. If activation fails after funding (e.g. follower cap reached) the exact funding is transferred back (`refunding` → `refunded`, or `refund_failed`).
- Extra errors: `400 fixed ratio requires copy_amount; fixed margin requires funding_amount at least margin_per_entry_order`, `400 funding_amount exceeds available balance`, `400 maximum sub-account limit reached` (20), `400 invalid margin mode` / `invalid leverage`, `403 copy accounts must be created by their parent account`, `403 source_account_id must be an active account you own`, `409 request_id is already bound to different copy settings`, `409 a copy portfolio for this trader already exists or is being set up`.
- PATCH/DELETE a managed copy with `sub_account_id` = the new sub-account. Stopping leaves the funds in that sub-account; sub-account transfers are JWT-only (Strike app).

### PATCH /v2/copy/subscribe/:id

Body: any of `copy_amount` (fixed_ratio), `margin_per_entry_order` (fixed_amount), `minimum_entry`, `ratio_multiplier`, `max_margin_per_symbol`, `max_margin_total`, `excluded_symbols`, `margin_mode_source`, `leverage_source`, `max_leverage`, `stop_loss_amount`, plus `sub_account_id`. `copy_mode`, lead and platform cannot change. Returns **204**.

- Omitted = unchanged. `0` clears `max_margin_*`, `max_leverage`, `stop_loss_amount`; `[]` clears `excluded_symbols`; `"0"` / `"1"` reset `minimum_entry` / `ratio_multiplier`.
- `copy_amount` increase needs available ≥ the increase; decreases only need ≥ minimum. A kept cap is revalidated when `margin_per_entry_order` grows past it.
- A new `stop_loss_amount` the copy has already lost (Total PnL ≤ −amount) → `400 this copy has already lost more than this stop loss; set a higher one`.
- Changes apply to future entries; open positions are not resized or re-levered.
- Errors: `400 invalid inputs` (empty patch, field of the other mode, ratio fields on `fixed_amount`, invalid values), `400 only a copy with its own account …`, `403 sub-account access denied`, `404 copy subscription not found` (unknown, another account's, or already stopped). A non-UUID `:id` is a `500` (also on DELETE).

### DELETE /v2/copy/subscribe/:id

Query: `sub_account_id` (optional). No body. Returns **204**.

1. The subscription flips to `stopped` immediately (no new copies) and its PnL is snapshotted into `closed_pnl` (realized net of fees + unrealized at mark).
2. **Copied positions are always closed**: one reduce-only market IOC per market, sized to this subscription's attributed size (your manual size and other subscriptions' size stay); a whole-position close is sent as `close_position`. Each close waits up to 30 s for the copy ledger to catch up; if it doesn't, that market is skipped.
3. Resting copy orders are **not** canceled (a `cancel_open_orders` query is ignored).
4. Fixed-ratio reservation is released; a Strike-lead profit share is attempted (below).

If any close fails the response is `500 internal server error` although the subscription is already stopped -- **call DELETE again**: on a stopped subscription it re-runs the close (idempotent) and returns 204. Unknown id → `404 copy subscription not found`; non-UUID id → `500`.

---

## How copies are sized

**Entries (opens and adds)**

| Mode | Size |
|---|---|
| `fixed_ratio` | `ratio = min(copy_amount / lead equity, 1)`; `size = lead fill size × ratio × ratio_multiplier`, raised to `minimum_entry / price` if below (the floor rounds **up** to a valid lot; normal sizing rounds down). Lead equity: Hyperliquid account value, or the Strike lead's cross margin balance + isolated margin balances, read per lead fill |
| `fixed_amount` | One entry per **lead order** (all partial fills of one lead order = one copy). Skipped (`insufficient_balance`) unless available ≥ `margin_per_entry_order`, never sized down (not checked for the open leg of a lead flip -- the engine decides after the close leg frees margin); then sized to fit that margin at the follower's leverage using Strike's execution estimate. Not a loss cap |

- `copy_amount` is a ratio input and a reservation, not a spending budget: placing copies never reduces it.
- Hyperliquid fills in one received batch are merged per (coin, order id, block time, open/close) before per-subscription sizing, in both modes: openings, and reductions that carry the lead's start position, become one copy; flips pass through unmerged.
- An entry must pass the market's order rules (min/max size, step, min notional) or it is skipped. The engine can still reject the market IOC on margin (`insufficient_balance` etc.); the subscription stays active either way.

**Reductions** close the same fraction of *this subscription's* copied size that the lead closed of its position: `follower close = attributed size × (lead fill size / lead position before fill)` (capped at 100%; partial closes round down; a full close takes the exact attributed size, as `close_position` when it is your whole position). Never balance-checked; mirrored even for excluded markets. Lead liquidations/ADL/backstop closes count as reductions. If the lead's pre-fill position is unknown, `fixed_amount` falls back to its entry formula clamped to your copied size, while `fixed_ratio` does not place the close (it is retried). Reductions are skipped when you hold no copied position for that subscription.

**Caps and filters** (entries only, both platforms): `max_margin_per_symbol` / `max_margin_total` count margin held by the subscription (isolated balance or cross initial margin share), margin of entries still in flight (~1 minute), and the new entry (`margin_per_entry_order`, or notional ÷ your leverage). An entry that would exceed a cap is skipped whole. `excluded_symbols` blocks entries only; on a lead flip the close leg is mirrored and the open leg skipped.

**Leverage / margin mode**: by default copies use the follower's own settings per market (account default leverage else market default; account default margin mode, initially cross). With `*_source: "lead"` (managed accounts only) each entry first sets your market to the lead's mode/leverage (capped by `max_leverage` and the market max); closes are never re-levered. If the lead setting can't be read, your setting is kept. These setting changes produce no user-stream event.

**Stop loss**: when the subscription's Total PnL (`pnl` in `/v2/copy/subscriptions`) reaches −`stop_loss_amount`, the copy is stopped with `stop_reason: "stop_loss"`, its resting copy orders are canceled and positions closed at market. Not exact: closes slip, the watcher checks every 200 ms against mark prices refreshed every 500 ms, and funding is not part of copy PnL.

**Copy existing positions**: each lead position is treated as one opening fill at mark price (same sizing, balance check, caps). Runs in the background after the 201; each skipped position appears in `/v2/copy/orders` as a `failed` row (`error_message` e.g. `insufficient_balance`, `max_margin_per_symbol`, `max_margin_total`, `market_order_rule_violation`, `strike_market_not_tradable`, `excluded_symbol`, `zero_size`).

**Not copied**: fills from before the subscription; Hyperliquid opening fills older than 5 minutes (late reductions still apply); Hyperliquid spot/outcome coins and coins with no trading Strike market (native and HIP-3 `dex:COIN` coins resolve by base asset, e.g. `xyz:ZHIPU` → `ZHIPU-USD`; a server-side symbol map is only the fallback for other names, and `copy_existing_positions` reads only the HIP-3 dexes in that map); a Strike lead's system orders other than its own liquidation/ADL/backstop reductions; Strike lead orders that are themselves copies, TWAP (`twap-`) or grid (`grid-`, `:grid-`) orders. Copied orders carry no builder code (no builder fee).

## Funds reservation and profit share

- **Fixed-ratio reservation**: the sum of active `fixed_ratio` `copy_amount`s is held until stop (liquidations don't release it). Only the unused part overlays balances: `max(0, copy_reserved_balance − copy_deployed_margin)`, because copy position margin is already in the engine figure. Fixed-amount subscriptions reserve nothing.
- **Profit-share hold** (Strike leads): while active, `profit_share_rate × positive realized PnL`; after stop, `rate × min(closed_pnl, realized_pnl)` (both positive) until the share is paid.
- Both holds lower the available / withdrawable figures of `GET /v2/account` (which also returns `copy_reserved_balance`, `copy_deployed_margin`, `copy_profit_share_reserved`) and `GET /v2/balances` (see **strike-account** / **strike-calculations**), withdraw quotes, and the subscribe/PATCH/fixed-amount balance checks. They are an API overlay: the matching engine does not see them, so your own manual orders can still use that margin.
- **Profit share**: when a **Strike-lead** subscription stops with `closed_pnl > 0`, `profit_share_rate × closed_pnl` (`profit_share_rate` from `/v2/copy/lead-traders`, currently `"0.1"`) is transferred follower → lead as an internal transfer, also when some closes failed. After the engine confirms it, `closed_pnl` drops by the share. Losses and Hyperliquid leads share nothing. A rejected transfer is retried by stopping again.

---

### GET /v2/copy/subscriptions

Query: `status` (empty → `active`; `active` \| `stopped` \| `all`; any other value returns an empty list), `sub_account_id`, public `account_id` / `blockchain_address` / `vault_id` (public-selector errors as in **strike-history**; no selector and no auth → `401 {"error":"account_id not found in auth context"}`, also on orders/positions), `scope=all` (master + active sub-accounts; also allowed with a public `account_id`/`blockchain_address`; without either it needs auth: `401 authentication required for scope=all`; not with `vault_id`/`sub_account_id`; other `scope` values → `400 invalid scope: only scope=all is supported`). Newest first.

```json
{ "subscriptions": [ {
  "subscription_id": "01a10d99-52cf-7d75-8099-954b56c9f432",
  "lead_account_id": "0xbf732ea04197942783e34730ed6e0f6099575d58",
  "lead_platform": "hyperliquid",
  "lead_address": "0xbf732ea04197942783e34730ed6e0f6099575d58",
  "copy_mode": "fixed_ratio",
  "copy_amount": "200", "budget_remaining": "200", "minimum_entry": "0", "ratio_multiplier": "1",
  "max_margin_per_symbol": "150", "excluded_symbols": ["DOGE-USD"], "stop_loss_amount": "100",
  "margin_mode_source": "account", "leverage_source": "account", "own_account": false,
  "status": "active", "created_at_ms": 1791229514468,
  "total_margin": "572.89725600", "total_worth": "530.78218600",
  "realized_pnl": "12.89551926901000000", "pnl": "-29.21", "filled_order_count": 179, "total_volume": "4685.907303"
} ] }
```

- `copy_amount`, `budget_remaining` (= `copy_amount`), `minimum_entry`, `ratio_multiplier`: fixed_ratio only. `margin_per_entry_order`: fixed_amount only. `max_margin_per_symbol`, `max_margin_total`, `excluded_symbols`, `max_leverage` (number), `stop_loss_amount`, `lead_nickname`, `lead_avatar_url`, `lead_address` are omitted when unset. `lead_address` is the Strike lead's wallet or the Hyperliquid address.
- `realized_pnl` is net of fees; `pnl` = realized + unrealized of copy-attributed size. Stopped rows: `stopped_at_ms`, `stop_reason` (`stop_loss`, legacy `liquidation`; omitted for a manual stop), `realized_pnl` = `pnl` = `closed_pnl`, `total_margin`/`total_worth` `"0"`.
- `scope=all` rows add `account_id`; the body adds `accounts: [{account_id, name, kind}]`.

### GET /v2/copy/orders

One row per copy attempt, newest first. Query:

| Param | Notes |
|---|---|
| `status` | Empty/`all` = everything. `pending`, `failed` filter the copy row; `open`, `rejected`, `filled`, `canceled` filter the follower engine order. Else `400 status must be all, pending, failed, canceled, open, rejected, or filled` |
| `lead_account_id` (alias `trader`) | One lead |
| `symbol`, `symbols`, `market`, `markets` | CSV and/or repeated |
| `side` | `buy` \| `sell` (`400 side must be buy or sell`) |
| `type`, `types` | REST order types (`400 type must be a valid order type`) |
| `role` | `maker` \| `taker` (`400 role must be maker or taker`) |
| `limit` | Default 50, max 100 |
| `before` + `before_id` | Cursor from `next_before_ms` / `next_before_id` (`400 before must be a positive unix timestamp in milliseconds`, `400 before_id is required when before is set`) |
| selectors | As subscriptions. `scope=all` here is private only (no auth → `401 account_id not found in auth context`; `400 scope=all cannot be combined with <selector>`); any other `scope` value is ignored (no 400). Rows add `account_id`, the body adds `accounts` and `next_before_time` (pass back as `before_time` with `before`/`before_id`) |

```json
{
  "orders": [ {
    "id": "01a156dc-18bf-72b6-b62a-b05d08ec766f",
    "subscription_id": "01a0f32e-2602-7254-a80f-6ac30a088abc",
    "lead_account_id": "0xbf732ea04197942783e34730ed6e0f6099575d58",
    "lead_order_id": 1414928137641,
    "lead_client_order_id": "hl:oid:579859408005",
    "symbol": "ETH-USD",
    "status": "placed",
    "follower_client_order_id": "copy:01a0f32e-2602-7254-a80f-6ac30a088abc:1414928137641",
    "follower_order": { "order_id": 11129541469, "status": "filled", "side": "sell", "type": "market",
      "size": "0.007", "filled": "0.007", "price": "2379.57366481", "fee": "0.00749354", "pnl": "-0.22753043" },
    "created_at_ms": 1792458627263, "updated_at_ms": 1792458632009
  } ],
  "traders": [ { "account_id": "0xbf732ea04197942783e34730ed6e0f6099575d58", "platform": "hyperliquid" } ],
  "next_before_ms": 1792458627263,
  "next_before_id": "01a156dc-18bf-72b6-b62a-b05d08ec766f"
}
```

- Row `status`: `pending` → `placed` | `failed`; `canceled` after a stop-loss cancel. `placed` means published -- the engine outcome is in `follower_order.status` (the order's status, e.g. `filled`, `canceled`, `rejected`, `expired`; `failed` for a failed row). Until the follower order is persisted, `follower_order` shows the intended side/size/price with `order_id: 0` and `status: ""`.
- `error_message`: skip/cap reason, placement error, or the engine close reason (e.g. `insufficient_balance`). **Dropped on public reads.**
- `lead_order_id` is the lead fill id (Hyperliquid `tid`, Strike fill id), or the lead order id for fixed-amount entries and flip-open legs; seeded positions use synthetic ids ≥ 2^62 (beyond JS safe integers -- use `follower_client_order_id`). `lead_client_order_id`: `hl:oid:<oid>` or `strike:oid:<order id>`.
- `traders` lists every lead this follower ever subscribed to (for filters). `next_before_*` appear only when the page is full; the single-account cursor is millisecond-precision.

### GET /v2/copy/positions

Query: `lead_account_id` (alias `trader`), `symbol`, selectors / private `scope=all` as orders.

```json
{
  "positions": [ {
    "id": "227762", "subscription_id": "01a0aae5-10c8-7396-b454-1a6212559422",
    "lead_account_id": "0x52b1b41d1492608400e9ff89078f8cbabb959b32",
    "market": "BTC-USD", "side": "long", "margin_mode": "cross", "collateral": "549.58", "leverage": 10,
    "entry_price": "82127.33", "mark_price": "81541.85", "liquidation_price": "71294.72",
    "size": "0.0673988859147466449", "pnl": "-39.46"
  } ],
  "traders": [ { "account_id": "0x52b1b41d1492608400e9ff89078f8cbabb959b32", "platform": "hyperliquid" } ],
  "total_margin": "722.65", "total_worth": "586.99", "realized_pnl": "863.71", "total_pnl": "728.05"
}
```

- One slice per subscription holding the market (`id` is the engine position id and repeats); `size` is absolute with `side` `long`/`short`; `pnl` unrealized; `collateral` the slice's margin share.
- Without a lead filter, the follower's own remainder in those markets appears as a slice with `"own": true` and no `subscription_id` (empty `lead_account_id`); own slices are excluded from totals.
- `realized_pnl` is lifetime copy PnL (net of fees) of all this follower's subscriptions, active and stopped, restricted to `lead_account_id` / `symbol` when given; `total_pnl` = that + open copy unrealized.

### GET /v2/copy/lead/stats

For a Strike lead (auth required; `sub_account_id` optional). Query `days`: default 30, max 90 (clamped), or `all`; negative → `400 days must be a non-negative integer or "all"`.

```json
{
  "lead_account_id": "019a0c2e-2222-7000-8000-000000000002",
  "profit_share_rate": "0.1",
  "today": { "date": "2026-10-20", "copier_count": 12, "volume": "48210.5", "unrealized_shared_profit": "31.2", "shared_profit": "4.1" },
  "daily": [ { "date": "2026-10-20", "copier_count": 12, "volume": "48210.5", "shared_profit": "4.1" } ],
  "profit_shares": [ { "address": "0xabc...", "nickname": "alice", "copy_mode": "fixed_ratio", "copy_amount": "500",
      "total_volume": "9120.4", "filled_order_count": 88, "closed_pnl": "36.9", "amount": "4.1", "stopped_at_ms": 1792458000000 } ]
}
```
`daily` is newest first, one row per UTC day; `profit_shares` are engine-confirmed shares in the window (`margin_per_entry_order` for fixed_amount; `address`/`nickname`/`avatar_url` omitted when unknown).

### Bookmarks: /v2/copy/saved

- `POST {"lead_account_id": "..."}` → `201` new / `200` existing: `{"lead_account_id": "...", "saved_at_ms": 1792458000000}`. Platform is inferred from the id shape (send Hyperliquid addresses lowercase: deletes match exactly). Errors: `400` Go validator text when `lead_account_id` is missing, `400 invalid inputs` when blank, `400 cannot save yourself`, `400 cannot follow a vault account`, `400 <platform> copy trading is disabled`, `404 lead trader account not found`.
- `DELETE /v2/copy/saved/:account_id` → `{"lead_account_id": "..."}`; `404 saved trader not found`.
- `GET` → `{"saved_traders": [{"account_id": "..."}]}`, newest first. Stored per authenticated account (no `sub_account_id`).

---

### GET /v2/copy/lead-traders (public)

```json
{
  "auto_create_sub_account_enabled": true,
  "min_copy_amount": "20", "min_margin_per_entry_order": "20",
  "max_followers_per_lead": 40, "profit_share_rate": "0.1",
  "lead_traders": [
    { "account_id": "019d8bdd-eeee-76e2-8f37-a330c60527e1", "platform": "strike", "follower_count": 15 },
    { "account_id": "0xbf732ea04197942783e34730ed6e0f6099575d58", "platform": "hyperliquid", "follower_count": 12,
      "top_assets": [{ "asset": "ZEC", "symbol": "ZEC-USD" }], "style": "algo", "bias": "long",
      "recommended_direction": "none", "last_traded_at_ms": 1792446448498, "stats_updated_at_ms": 1792446481112 }
  ]
}
```
Leads with ≥ 1 active subscription; `follower_count` counts active subscriptions. `nickname`, `avatar_url` and the discovery fields are omitted when unknown (`copy_score` string).

### GET /v2/copy/leaderboard (public)

Query: `status` `active` (default) \| `stopped` \| `liquidated` (else `400 invalid inputs`), `lead_account_id` (case-insensitive). Returns **every** subscription row of that status, best `realized_pnl` first, cached ~10 min per status.

```json
{ "entries": [ {
  "follower": { "account_id": "019f18f8-...", "nickname": "cao", "address": "addr_test1..." },
  "lead_account_id": "01a0c198-9844-7a7f-a51b-7d36845de881", "follower_count": 1,
  "copy_mode": "fixed_amount", "copy_amount": "0", "margin_per_entry_order": "20",
  "status": "active", "created_at": 1789997449294, "platform": "strike",
  "closed_pnl": "0", "realized_pnl": "0", "filled_order_count": 0, "total_volume": "0"
} ] }
```
Here `follower_count` is how many accounts **bookmarked** the lead; `created_at`/`stopped_at` are ms. `liquidated` = legacy rows stopped with reason `liquidation` (liquidations no longer stop copies).

### GET /v2/copy/copiers (public)

Query `lead_account_id` (required, else `400 invalid inputs`). Computed per request; responses carry `Cache-Control: public, max-age=30`.

```json
{
  "lead_account_id": "019d8bdd-eeee-76e2-8f37-a330c60527e1",
  "summary": { "copiers": 65, "profitable": 7, "liquidated": 0, "net_pnl": "-2568.41" },
  "copiers": [ { "copier": { "account_id": "019d109b-...", "nickname": "PREEB", "avatar_url": "...", "address": "addr1..." },
    "status": "active", "copy_count": 1, "copied_at": 1791229514468, "first_copied_at": 1791229514468,
    "allocated": "200", "pnl": "12.89", "total_volume": "4685.90", "filled_order_count": 179 } ]
}
```
One row per person (sub-account copies roll up to the owning master). Order: active, stopped, liquidated, each by `pnl` desc. `stopped_at` only when nothing is active; `allocated` counts `copy_amount` / `margin_per_entry_order` of active copies.

### Discovery (public)

`GET /v2/copy/discover` -- cursor-paginated traders (`Cache-Control: public, max-age=60`):

| Param | Default | Values |
|---|---|---|
| `platform` | `hyperliquid` | `hyperliquid` \| `strike` \| `all` (merged by sort) |
| `search` | | `0x…` hex prefix (≤ 42 chars) matches Hyperliquid addresses (forces enriched only) and Strike wallets; other text matches Strike account id/wallet prefix, nickname, ADA handle only |
| `sort` / `order` | `pnl_30d` / `desc` | `pnl_*`, `roi_*`, `volume_*` (`1d`,`7d`,`30d`,`all`), `equity`, `copy_score`, `max_drawdown` / `asc` |
| `top` + `rank_by` | / `pnl_30d` | Global rank cutoff 1–10000, applied before filters; `pnl_30d` \| `equity` \| `volume_30d` |
| `asset` / `assets`, `assets_mode` | / `any` | CSV; `any` \| `only` (legacy `all`) |
| `style`, `bias` | | CSV of `market_maker`, `algo`, `scalper`, `day`, `swing`, `position`, `inactive`, `unknown`; `long` \| `short` \| `neutral` |
| `equity_min/max`, `pnl_min/max`, `volume_min/max` | | Decimals; `pnl_window` (`30d`; `1d`,`7d`,`30d`,`all`) picks the PnL/volume window |
| `min_copy_score` (0–100), `score_window` (`30d`; `7d`,`30d`,`all`) | | |
| `strike_copyable_min` (0–1), `drawdown_min/max` (0–1), `drawdown_window` (= `score_window`; `1d`,`7d`,`30d`,`1y`,`all`) | | |
| `enriched_only` | `true` | `false` adds rows still `pending`; ignored (forced `true`) with `sort=copy_score`, `sort=max_drawdown` or a `0x` search on Hyperliquid |
| `limit`, `cursor` | `50` | 1–200; `cursor` = `next_cursor`, bound to the same filters and sort |

Any invalid value → `400 invalid copy trader discovery query`; discovery off → `503 copy trader discovery is disabled`.

```json
{
  "items": [ {
    "address": "0xbf732ea04197942783e34730ed6e0f6099575d58", "platform": "hyperliquid",
    "account_value": "7228212.80",
    "pnl": { "1d": "1143745.82", "7d": "108792.95", "30d": "-1840768.14", "all": "20590546.86" },
    "roi": { "1d": "0.175734", "7d": "-0.263283", "30d": "0.055922", "all": "-1.000000" },
    "volume": { "1d": "54329889.12", "7d": "591717849.86", "30d": "1424661107.84", "all": "11738917958.54" },
    "enrichment_state": "ready",
    "equity_curve_30d": [[1789944600041, "6164341.80"]], "pnl_curve_30d": [[1791240600065, "3101738.23"]],
    "top_assets": [{ "asset": "ZEC", "symbol": "ZEC-USD" }], "style": "algo", "bias": "long",
    "copy_amount_coverage": [{ "copy_amount": "1000.000", "coverage": "0.099086" }],
    "copy_scores": { "7d": "38", "30d": "37", "all": "32" }, "copy_score": "37",
    "copy_score_breakdowns": { "7d": {}, "30d": {}, "all": {} }, "copy_score_breakdown": {},
    "score_version": 7, "recommended_direction": "none", "last_traded_at_ms": 1792446448498,
    "peak_concurrent_entries": "48.000000", "fills_window_days": "0.041667"
  } ],
  "next_cursor": "eyJ2IjoxLCJzb3J0Ijoi...", "total": 947, "data_as_of_ms": 1792458000569
}
```

- **`address`**: for `platform: "hyperliquid"` the trader's Hyperliquid wallet (an external trader; copy it with `platform: "hyperliquid"`); for `platform: "strike"` the Strike **account_id**, with the owner's wallet in `blockchain_address` and the nickname in `display_name` (use `address` as `lead_account_id`; vaults are never listed). `avatar_url`, `ada_handle` only for Strike rows.
- `top_assets[].symbol` is the Strike market, `""` when not copyable. `copy_amount_coverage` (fixed ratio: share of the lead's opening notional a given `copy_amount` could have copied under Strike order rules) and `peak_concurrent_entries` × margin per entry (fixed amount: estimated margin need over `fills_window_days`) are historical guidance; both can be empty/omitted. Score fields are omitted/`{}` when unavailable.
- `total` counts all matches (after `top` and filters, before `cursor`/`limit`); `next_cursor` is omitted on the last page.

`GET /v2/copy/discover/:address` -- one item (same shape) for a Hyperliquid address or Strike account id; `404 copy trader not found`. `GET /v2/copy/discover/filters` -- the accepted `platforms`, `styles`, `biases`, `sort_keys`, `rank_keys`, `asset_modes`, `pnl_windows`, `score_windows`, `drawdown_windows`, `score_version`, `enabled`.

---

## Copied orders elsewhere and real-time updates

- Every copy order is a normal order on the follower account with `client_order_id` **`copy:<subscription_id>:<lead_order_id>`** (stop-time closes: `copy:<subscription_id>:<n>`). `copy:` is reserved -- your own orders can't use it. Mirrored lead orders also carry `CopySubscriptionID` and `CopyLeadOrderID` in `GET /v2/order` (**strike-trading**); stop-time closes carry only the client order id.
- History: `source=copy` filters `/v2/history/order` / `/v2/history/fill`; `include_copies=true` adds copy executions from the caller's other family accounts (**strike-history**).
- User stream (subscribe the follower account -- the sub-account for sub-account or managed copies): copy orders and fills arrive as `ORDER_TRADE_UPDATE` with `c` = the `copy:` id (engine rejects too, e.g. `cr: "insufficient_balance"`); positions as `ACCOUNT_UPDATE` position updates. A profit share arrives on the follower's stream as wrapped `INTERNAL_TRANSFER_COMPLETED` / `INTERNAL_TRANSFER_FAILED` with `transfer_kind: "strike_account"`, `recipient_type: "copy_profit_share"` (balance updates `r: INTERNAL_TRANSFER_OUT` follower / `INTERNAL_TRANSFER_IN` lead). Managed funding/refund use `transfer_kind: "sub_account"` with `recipient_type` `copy_portfolio_funding` / `copy_portfolio_refund` (see **strike-userstream**).
- There are **no** copy-specific events: subscription start/stop, stop-loss triggers, skipped copies and lead-setting changes must be polled (`/v2/copy/subscriptions?status=all`, `/v2/copy/orders`).

## Lifecycle

| Object | States |
|---|---|
| Subscription | `active` → `stopped` (DELETE, or stop loss with `stop_reason: "stop_loss"`). Follower liquidation/ADL does **not** stop it; to copy again, subscribe again |
| Managed setup | `creating_account` → `funding` → `active`; failures `failed`, `refunding` → `refunded` \| `refund_failed`; `stopped` once its subscription stopped |
| Copy order row | `pending` → `placed` \| `failed`; `placed` → `canceled` (stop-loss cancel) |
| Profit share | on stop with `closed_pnl > 0` (Strike lead): transfer pending → confirmed (`closed_pnl` reduced) |

## Gotchas

- `platform` defaults to `strike`; Hyperliquid wallets need `platform: "hyperliquid"`. `/v2/copy/discover` defaults to `platform=hyperliquid`.
- `DELETE` can return `500` after it already stopped the copy (a close failed or the ledger lagged): retry it until `204`.
- Subscribe/PATCH only change the subscription; copies happen asynchronously as the lead trades. A skipped live copy (balance, rules, caps, excluded symbol) is only logged, except cap/ledger skips and placement failures, which appear as `failed` rows.
- The fixed-ratio reservation does not stop *your* manual orders from using that margin; it only lowers reported available/withdrawable balance and new-copy checks.
- `max_margin_per_symbol: 0` / `max_margin_total: 0` on subscribe is `400` (omit instead); on PATCH `0` clears.
- `lead_order_id` can exceed 2^53; parse with a BigInt-safe JSON reader or rely on `follower_client_order_id`.
- Public reads (`account_id=...`) expose a follower's subscriptions, orders (minus `error_message`) and positions.

## Example

```typescript
// 1. Pick a Hyperliquid trader from discovery (public)
const { items } = await (await fetch(`${BASE}/v2/copy/discover?sort=copy_score&min_copy_score=60&limit=10`)).json();
const lead = items[0].address;                           // 0x… Hyperliquid wallet

// 2. Limits
const limits = await (await fetch(`${BASE}/v2/copy/lead-traders`)).json();

// 3. Subscribe from a dedicated sub-account
const copyAmount = Math.max(500, Number(limits.min_copy_amount)).toString();
const { subscription_id } = await copyApi<{ subscription_id: string; status: string }>("POST", "/v2/copy/subscribe", {
  lead_account_id: lead, platform: "hyperliquid", copy_mode: "fixed_ratio",
  copy_amount: copyAmount,
  max_margin_per_symbol: "150", excluded_symbols: ["DOGE-USD"], stop_loss_amount: "100",
  sub_account_id: SUB_ID,
});

// 4. Watch copies: ORDER_TRADE_UPDATE on the SUB_ID user stream with c.startsWith(`copy:${subscription_id}:`),
//    or poll the copy rows
const { orders } = await copyApi<any>("GET", `/v2/copy/orders?sub_account_id=${SUB_ID}&lead_account_id=${lead}&limit=50`);

// 5. Tighten settings, then stop (retry until 204)
await copyApi("PATCH", `/v2/copy/subscribe/${subscription_id}`, { sub_account_id: SUB_ID, stop_loss_amount: "60" });
for (let i = 0; i < 5; i++) {
  try { await copyApi("DELETE", `/v2/copy/subscribe/${subscription_id}?sub_account_id=${SUB_ID}`); break; }
  catch (e: any) { if (e.status !== 500) throw e; await new Promise(r => setTimeout(r, 2000)); }
}
```
