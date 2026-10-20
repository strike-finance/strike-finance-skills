---
name: strike-userstream
description: Strike Finance user stream -- authenticated WebSocket for API wallets (session.logon), sub-account and vault subscriptions, ORDER_TRADE_UPDATE (orders and fills), ACCOUNT_UPDATE (balances, positions, transfer statuses, async leverage/margin/transfer outcomes, vault events), strategyUpdate (TWAP, grid bots), rfqUpdate and the RFQ quoter feed, errors, keepalive and resync rules. Critical for trading bots.
---

# Strike Finance User Stream WebSocket

## Connection

| Environment | URL |
|-------------|-----|
| Mainnet | `wss://api.strikefinance.org/ws/user-api` |
| Testnet | `wss://api-v2-testnet.strikefinance.org/ws/user-api` |

- API wallet endpoint. (`/ws/user` is the Strike app's JWT endpoint with an `AUTH` message; `AUTH` is rejected here.) Allowlisted DMA profiles connect to `wss://direct-eu.strikefinance.org/ws/user-api` with the same protocol and a per-profile connection limit.
- **Keepalive:** the server sends a WebSocket ping frame every 54 s and closes the socket if no pong arrives within 60 s. Only pong frames extend the deadline -- application messages do not. Standard clients (browser `WebSocket`, Node `ws`/undici) answer pings automatically. An application ping `{"method":"ping","id":1}` gets `{"method":"pong","id":1}` but does not count as a pong.
- **Frames:** a text frame may carry several JSON objects separated by `\n` (write coalescing is a server option). Always split each frame on `\n` and parse each line.
- Inbound messages are limited to 4 KiB. `permessage-deflate` is negotiated if the client offers it.
- Decimals are strings; timestamps are Unix milliseconds.
- **No replay, no snapshot:** delivery is best effort. If your client falls behind and the server's per-socket queue fills, the server closes the socket. After any disconnect: reconnect, `session.logon`, subscribe, then resync from REST.

## Authentication: `session.logon`

Sign the ASCII string `session.logon:{timestamp}:{apiKey}` with the API wallet's Ed25519 private key.

- `timestamp`: Unix **milliseconds**, sent as a JSON number. Accepted window: at most 30 s in the future and at most 3 minutes old.
- `apiKey`: the API wallet public key (64 hex chars), exactly as registered.
- `signature`: hex-encoded 64-byte Ed25519 signature.
- No nonce, body hash, path or HTTP headers (that is the REST scheme).

```json
SEND:    {"id": 1, "method": "session.logon", "params": {"apiKey": "<PUBLIC_KEY_HEX>", "signature": "<SIG_HEX>", "timestamp": 1792440000000}}
RECEIVE: {"id": 1, "status": 200, "result": {"authenticated": true, "account_id": "<ACCOUNT_ID>"}}
```

- `id` is echoed as sent (number or string).
- `account_id` is the wallet's bound account; for a wallet created on a sub-account it is the sub-account ID.
- Every logon failure (bad signature, unknown/expired/revoked wallet, timestamp outside the window, DMA denial or DMA connection limit) returns the same `401 Authentication failed` error and leaves the socket open, so you can retry.
- A socket is bound to one account for its lifetime. Logging on again as the same account succeeds and re-sends the `200` reply; a different account gets `403 Connection is already authenticated as a different account`.

## Subscribe

```json
SEND:    {"method": "subscribe", "channel": "userstream", "id": 2}
RECEIVE: {"result": null, "id": 2}
```

| Target | Message | Auth |
|--------|---------|------|
| Own account | `{"method":"subscribe","channel":"userstream","id":2}` (or add `"account_id":"<own id>"`) | required; `account_id` must equal the logged-on account |
| Owned sub-account (master wallet) | `{"method":"subscribe","channel":"userstream","sub_account_id":"<SUB_ID>","id":3}` | required; sub-account must be active and owned |
| Vault | `{"method":"subscribe","channel":"userstream","vault_id":"<VAULT_ID>","id":4}` or `"account_id":"vault_..."` | none |

- One socket can hold many subscriptions (master + sub-accounts + vaults), but **balance updates, transfer statuses and order-state updates do not identify the account** (only position updates, and fill updates with position context, carry `account_id`). Use one socket per account if you need attribution. Unsubscribe with `"method":"unsubscribe"` and the same fields.
- Binance-style requests also work: `{"method":"SUBSCRIBE","params":["<ACCOUNT_ID>@userstream"],"id":5}` (`id` must be an integer; owned sub-account IDs are allowed here as well).
- Only the `userstream` channel carries account data (plus `rfq` for allowlisted quoters, below). Other channel names are accepted but never receive anything.
- No snapshot is sent on subscribe. Subscribe first, then load REST state (`/v2/openOrders`, `/v2/positions`, `/v2/balances`), then apply events.

## Errors

Errors are not correlated by `id`:

```json
{"e": "error", "E": 1792440000123, "error": {"code": 401, "msg": "Authentication required: use AUTH or session.logon before subscribing to user data streams"}}
```

| code | msg |
|------|-----|
| 400 | `Invalid JSON format`, `Missing channel in subscribe request`, `Missing symbol or account_id in subscribe request` (subscribe sent before the logon reply, without `account_id`), `Unknown method: <m>`, `Invalid params format`, `Missing required parameters (apiKey, signature, timestamp)`, `Authentication not available on this endpoint`, `RFQ sockets cannot have ordinary subscriptions` |
| 401 | `Authentication failed`, `Authentication required: use AUTH or session.logon before subscribing to user data streams`, `Authentication required: use AUTH or session.logon before subscribing to sub-account user data streams` |
| 403 | `Unauthorized: cannot subscribe to another account's data`, `Unauthorized: cannot subscribe to another account's sub-account data`, `Connection is already authenticated as a different account` |
| 404 | `Vault not found` |
| 500 | `Unable to verify sub-account subscription`, `Unable to verify userstream subscription` (Binance-style form) |

## Message Envelope

```json
{"e": "<EVENT_TYPE>", "E": 1792440000123, "s": "BTC-USD", "data": { }}
```

`E` is the server send time, except grid-bot `strategyUpdate` (`E` = bot event time) and `rfqUpdate` (`E` = the RFQ's `updated_at_ms`). `s` is present only on `strategyUpdate` and `rfqUpdate`.

| `e` | Content |
|-----|---------|
| `ORDER_TRADE_UPDATE` | Order state changes and fills |
| `ACCOUNT_UPDATE` | Balance changes, position changes, transfer statuses, wrapped async outcomes |
| `strategyUpdate` | TWAP terminal events, grid bot events |
| `rfqUpdate` | Status of RFQs you requested |

Ordering: events for one account keep their order within the order/fill path and within the account/position/strategy path, but `ORDER_TRADE_UPDATE` and `ACCOUNT_UPDATE` can interleave in either order.

## ORDER_TRADE_UPDATE

Two producers share this shape: **order updates** (state changes) and **fill updates** (one per execution). Every key below is always present unless marked optional.

```json
{
  "e": "ORDER_TRADE_UPDATE",
  "E": 1792440000200,
  "data": {
    "s": "BTC-USD", "c": "my-order-001", "S": "BUY", "o": "LIMIT", "f": "GTC",
    "q": "0.5", "p": "80000", "ap": "", "sp": "0",
    "x": "TRADE", "X": "OPEN", "i": 243140293, "cr": "",
    "l": "0.1", "z": "0.1", "L": "80000", "N": "USDT", "n": "4",
    "ott": 1792440000150, "t": 18073, "b": "", "a": "",
    "m": false, "R": false, "wt": "", "ot": "LIMIT", "ps": "BOTH", "cp": false,
    "rp": "0", "act": "", "E": 1792440000150, "T": 1792440000150,
    "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
    "fill_id": "36026", "position_id": "3232", "position_seq": 22,
    "position_context": {"known": true, "size": "0", "entry_price": "0", "margin_mode": "cross", "leverage": 20, "funding": "0", "open_timestamp": 0},
    "builder_fee": "0", "order_id": "243140293", "trade_id": "18073"
  }
}
```

| Field | Meaning |
|-------|---------|
| `s` | Symbol |
| `c` | Client order ID |
| `S` | `BUY` \| `SELL` |
| `o` / `ot` | Order type / original type before trigger: `MARKET`, `LIMIT`, `STOP_MARKET` (stop), `STOP` (stop-limit), `TAKE_PROFIT_MARKET` (take-profit), `TAKE_PROFIT` (take-profit-limit), `TRAILING_STOP_MARKET`. Note these differ from REST type names. |
| `f` | `GTC` \| `FOK` \| `IOC` |
| `q`, `p`, `sp` | Original size, limit price, stop price |
| `x` | Execution type. Order updates: `NEW` (pending or untriggered), `TRADE` (open **or** filled), `CANCELED`, `REJECTED`, `EXPIRED`. Fill updates: always `TRADE` |
| `X` | Order status: `NEW` (pending or untriggered), `OPEN` (resting, possibly partially filled -- check `z`), `FILLED`, `CANCELED`, `REJECTED`, `EXPIRED`. `PARTIALLY_FILLED` appears only on a fill update whose order snapshot was unavailable; in that case `c`, `o`, `ot`, `f`, `q`, `p`, `sp`, `z`, `wt` are `""` |
| `i` | Order ID (number) |
| `cr` | Close reason (free text, e.g. `order_would_match_immediately` for a post-only reject, `order_expired_in_match` for self-trade prevention) |
| `z` | Cumulative filled size |
| `l`, `L` | This fill's size and price (`""` on order updates) |
| `n`, `N` | This fill's commission (negative = maker rebate) and asset `USDT` (`""` on order updates) |
| `t` | Trade ID (`0` on order updates) |
| `m` | Fill was maker |
| `rp` | Realized PnL of this fill, gross of fees (`""` on order updates) |
| `R`, `cp` | Reduce-only, close-position |
| `wt` | `""`, `CONTRACT_PRICE`, `MARK_PRICE` |
| `act` | Auto-close type: `""` for user orders, else `liquidation`, `adl`, `bankrupt`, `if_transfer`, `vault_withdrawal`, `slp_transfer` |
| `ps` | `BOTH` on fill updates, `""` on order updates (one-way mode) |
| `ott`, `T`, `E` | Order updates: order event time (`E` = send time). Fill updates: fill time |
| `ap`, `b`, `a` | Always `""` |
| `AP`, `CR` | Optional: trailing-stop activation price and callback rate |
| `lf` | Optional: liquidation fee charged on this fill |
| `account_id`, `fill_id`, `position_id`, `position_seq`, `position_context`, `builder_fee`, `order_id`, `trade_id` | Optional (fill updates with position context). IDs are exact strings; `position_context` is the position **before** this fill; `builder_fee` is charged separately from `n` |
| `closing_margin` | Optional: margin released by a position-reducing fill |

**Detecting fills:** a message is a fill exactly when `t > 0` (only fill updates set `t`, `l`, `L`, `n`). `x == "TRADE"` alone is not enough because resting orders also report `x: "TRADE"`. Fill updates and order updates are separate messages; the order update after a fill carries the new `z` and `X`.

**Terminal statuses:** `FILLED`, `CANCELED`, `REJECTED`, `EXPIRED`.

## ACCOUNT_UPDATE

Check `data.event_type` first; if absent, `data.e` tells you which variant it is.

### Balance update

```json
{
  "e": "ACCOUNT_UPDATE", "E": 1792440000300,
  "data": {
    "e": "ORDER",
    "B": [{"a": "USDT", "wb": "10012.5", "cw": "10012.5", "bc": "0"}],
    "P": [],
    "r": "FILL",
    "E": 1792440000300, "T": 1792440000300
  }
}
```

- `B[0].wb` is the new wallet balance (`cw` repeats it; `bc` is always `"0"`).
- `r` is the engine reason: `FILL`, `FUNDING`, `DEPOSIT`, `WITHDRAWAL`, `ADL`, `LIQUIDATION_FEE`, `MARGIN_ADJUST`, `LEVERAGE_CHANGE`, `INTERNAL_TRANSFER_IN`, `INTERNAL_TRANSFER_OUT`, vault reasons (your account: `VAULT_CREATE`, `VAULT_DEPOSIT`, `VAULT_DEPOSIT_FROM_STAKING`, `VAULT_WITHDRAWAL`; the vault account: `VAULT_CREATE_RECEIVED`, `VAULT_DEPOSIT_RECEIVED`, `VAULT_WITHDRAWAL_EXECUTED`), reward/staking reasons, and others.
- `data.e` maps `FILL` -> `ORDER`, `FUNDING` -> `FUNDING`, `DEPOSIT` -> `DEPOSIT`, `WITHDRAWAL` -> `WITHDRAW`, anything else -> `ACCOUNT_UPDATE`.
- Optional: `staking_reward_balance`, `locked_reward_credit` (only when changed; keep the last value otherwise); inventory fields `custody_balances` and `inventory_costs_usd` (maps of asset -> decimal string), `conversion_reserved_usd` (string) and `slp_adl` (ADL profile view), present only on events that change an account's collateral inventory (vault/SLP accounts).

### Position update

```json
{
  "e": "ACCOUNT_UPDATE", "E": 1792440000310,
  "data": {
    "e": "POSITION_UPDATE",
    "B": [{"a": "USDT", "wb": "10012.5", "cw": "10012.5", "bc": "0"}],
    "P": [{
      "s": "BTC-USD", "pa": "-0.09397", "ep": "81558.69091944", "mt": "cross", "ib": "0", "ps": "SHORT", "i": 3232,
      "position_id": "3232", "position_seq": 22, "leverage": 20, "funding_total": "270.2568393349164184",
      "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b"
    }],
    "r": "",
    "E": 1792440000310, "T": 1792440000250
  }
}
```

- `data.e`: `POSITION_OPENED`, `POSITION_UPDATE`, `POSITION_CLOSED`, `PARTIAL_LIQUIDATED`, `FULLY_LIQUIDATED`, `ADL`. `r` is `""`.
- `P` holds exactly one position with its full current state: `pa` signed size (`"0"` when closed), `ep` entry price, `mt` `cross`|`isolated`, `ib` isolated margin, `ps` `LONG`|`SHORT`|`BOTH` (zero), `i` numeric ID, `position_id` exact ID, `position_seq` fill watermark, `funding_total` accumulated funding.
- `B` carries the wallet balance read at send time. `T` is the position update time (funding/settings updates stamp their event time).
- Derived values (uPnL, margin, liquidation price) are not included -- compute them (see `strike-calculations`) or poll `/v2/positions`.
- Key positions by `account_id` + `s` (one-way mode: one position per symbol per account); remove on `pa == "0"`. Ignore an update whose `position_seq` is lower than the one you hold for the same `position_id`.

### Transfer status

`data.e` is `DEPOSIT_PENDING`, `DEPOSIT_FAILED`, `WITHDRAWAL_SETTLED` or `WITHDRAWAL_FAILED`; `B` and `P` are empty; `r` is `DEPOSIT` for deposit statuses and equals `data.e` for withdrawals. Optional: `th` (tx hash), `request_id`, `asset_symbol`, `asset_amount` (atomic units), `usd_value`. These carry no balance -- the balance moves with a separate balance update.

### Wrapped events (`data.event_type`)

`data` is `{"event_type": "...", "event_data": {...}}` with no `e`/`B`/`P`:

| `event_type` | `event_data` |
|--------------|--------------|
| `LEVERAGE_UPDATED`, `LEVERAGE_UPDATE_FAILED` | `request_id`, `account_id`, `symbol`, `leverage`, `requested_leverage`, `current_leverage`, `error`, `timestamp` (optional fields omitted when empty) |
| `MARGIN_UPDATED`, `MARGIN_UPDATE_FAILED` | `request_id`, `account_id`, `symbol`, `modify_type` (`add`\|`remove`), `amount`, `isolated_margin`, `error`, `timestamp` |
| `INTERNAL_TRANSFER_COMPLETED`, `INTERNAL_TRANSFER_FAILED` | `transfer_id`, `account_id`, `transfer_kind`, `recipient_type`, `recipient_address`, `amount`, `error`, `timestamp`. Copy trading uses these: profit shares `recipient_type: "copy_profit_share"`, managed portfolio `copy_portfolio_funding` / `copy_portfolio_refund` (see **strike-copy-trading**) |
| `STAKING_REWARD_CLAIM_FAILED` | `account_id`, `request_id`, `error`, `timestamp` (success is a plain balance update with `r: "STAKING_REWARD_CLAIM"`) |
| `VAULT_*` (e.g. `VAULT_DEPOSITED`, `VAULT_WITHDRAWAL_REQUESTED`, `VAULT_WITHDRAWAL_EXECUTED`, `VAULT_LEADER_FEE_EARNED`, `*_FAILED`, `VAULT_CREATED`, `VAULT_LIQUIDATION_INCOME`) | Delivered to the stream of `event_data.account_id`: depositor/leader events to that account, `VAULT_CREATED` and `VAULT_LIQUIDATION_INCOME` to the vault's own stream. Field lists: **strike-vaults** |
| `CREDIT_*` | customer-safe credit events |

Use `request_id` to match `LEVERAGE_*` / `MARGIN_*` outcomes to your REST calls. Copy trading has no dedicated stream event: copied orders/fills/positions arrive as ordinary `ORDER_TRADE_UPDATE` (`c` starts with `copy:`) and `ACCOUNT_UPDATE` messages on the follower account; poll the copy REST routes for subscription state.

## strategyUpdate

**TWAP terminal** (`completed`, `expired`, `cancelled`; TWAPs that end `failed` or `liquidated` emit nothing -- poll `GET /v2/algo/twap/:id`):

```json
{
  "e": "strategyUpdate", "E": 1792440000400, "s": "BTC-USD",
  "data": {
    "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b", "strategy_id": "019c1a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6b", "market": "BTC-USD",
    "status": "completed", "side": "BUY", "total_size": "1", "filled_size": "1",
    "duration_sec": 3600, "slices_fired": 24, "nominal_slices": 24, "last_error": "", "completed_at_ms": 1792440000400
  }
}
```

**Grid bot** (`E` = event time; full lifecycle in **strike-grid-bot**): `data.event_type` is `GRID_BOT_STARTED`, `GRID_BOT_FILL`, `GRID_BOT_FAILED` or `GRID_BOT_STOPPED`, with `account_id`, `bot_id`, `symbol`, `timestamp` and, when relevant, `strategy_id`, `side` (`buy`|`sell`), `size`, `entry_price`, `fill_price`, `realized_pnl`, `fee`, `entry_fee`, `close_type` (`take_profit`, `stop_loss`, `unknown`, or an auto-close type), `partial`, `initialization_mode`, `seed_filled_size`, `seed_average_fill_price`, `seeded_levels`, `resting_entries`, `status`, `error`. Zero decimals, `false` and `0` are omitted (default them to `"0"`/`false`). `GRID_BOT_FILL` is emitted for exit (take-profit/stop-loss) fills only; entry fills produce just the normal `ORDER_TRADE_UPDATE` with the grid client order ID.

Distinguish them by `data.event_type` (grid) vs `data.status` + `data.strategy_id` (TWAP).

## RFQ

REST lifecycle, limits and quoter responses: **strike-rfq**.

**Requester updates** arrive on authenticated `userstream` subscriptions of the requesting account (your own account, or an owned sub-account subscribed via `sub_account_id`). RFQs created with `vault_id` never produce `rfqUpdate` (vault subscriptions are public). No event fires when an RFQ expires -- expire it locally at `expires_at_ms`. Best effort -- REST `GET /v2/rfq/{rfq_id}` is authoritative; apply only higher `revision`s.

```json
{
  "e": "rfqUpdate", "E": 1760000001000, "s": "BTC-USD",
  "data": {
    "_v": 1, "rfq_id": "019c0000-0000-7000-8000-000000000001", "client_rfq_id": "client-request-42",
    "symbol": "BTC-USD", "requested_size": "2.50000000", "status": "quoted", "revision": 4,
    "total_quoter_count": 5, "response_count": 3, "response_counts": {"acked": 1, "quoted": 1, "uninterested": 1},
    "created_at_ms": 1760000000000, "updated_at_ms": 1760000001000, "expires_at_ms": 1760000060000
  }
}
```

`E` equals `data.updated_at_ms`. `status`: `opened`, `quoted`, `closed` (`closed_at_ms` only when closed). Optional `side`: `buy`|`sell`.

**Quoter feed** (accounts on Strike's quoter allowlist only): on a dedicated socket, after `session.logon`, send exactly `{"method":"subscribe","channel":"rfq","id":1}` (exactly these three fields; `id` must be an integer) -> `{"result":null,"id":1}`. Unsubscribe with `{"method":"unsubscribe","channel":"rfq","id":2}`. The socket becomes RFQ-only and stays so after unsubscribe (ordinary subscriptions are rejected); acks and errors are delivered through the same RFQ queue. Events are raw JSON without the `e`/`E` envelope, one per frame:

- `{"_v":1,"type":"rfq","op":"set","rfq_id":"...","rfq":{"symbol":"BTC-USD","size":"2.5","side":"buy","created_at_ms":...,"expires_at_ms":...}}` (`op: "clear"` omits `rfq`; `side` is the requester's side and may be absent = both sides).
- `{"_v":1,"type":"prosp_rfq","op":"set"|"clear","symbol":"...","kind":"conditional"|"liquidation","source_seq":...,"source_time_ms":...,"expires_at_ms":...,"conditional":{...}|"liquidation":{...}}`.

Errors, in check order: `400 Invalid JSON format` (unparseable / duplicate keys) -> `400 RFQ subscriptions require exactly method, channel, and id` -> `400 Invalid RFQ subscription request` (wrong method/channel or non-integer `id`) -> `401 Authentication required before subscribing to RFQ` -> `400 RFQ sockets cannot have ordinary subscriptions` (socket already has ordinary subscriptions) -> `503 RFQ subscriptions are unavailable` -> `403 RFQ subscription requires an authorized Quoter account`. Re-subscribing an already subscribed socket just re-acks. There is no snapshot or replay: on reconnect, drop all RFQ state and wait for new events; drop events past `expires_at_ms`.

## Resync After Reconnect

1. Reconnect, `session.logon`, re-subscribe every stream.
2. Reload `GET /v2/openOrders`, `GET /v2/positions`, `GET /v2/balances` (see `strike-history`, `strike-trading`, `strike-account`).
3. Fetch fills you missed with `GET /v2/history/fill?since_trade_id=<last trade_id seen>` (see `strike-history`).

## TypeScript Example

Run one `StrikeUserStream` per account you track (balance, transfer-status and order-state messages carry no account ID).

```typescript
import * as ed from "@noble/ed25519"; // v2: signAsync uses WebCrypto SHA-512

const HEX = (b: Uint8Array) => Buffer.from(b).toString("hex");
const TERMINAL = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);

interface OrderTradeUpdate {
  s: string; c: string; S: "BUY" | "SELL"; o: string; f: string; q: string; p: string; sp: string;
  x: string; X: string; i: number; cr: string; z: string; l: string; L: string; n: string; N: string;
  t: number; m: boolean; R: boolean; rp: string; act: string; E: number; T: number;
  order_id?: string; trade_id?: string; fill_id?: string; builder_fee?: string; lf?: string;
}

interface WsPosition {
  s: string; pa: string; ep: string; mt: "cross" | "isolated"; ib: string; ps: "LONG" | "SHORT" | "BOTH";
  i?: number; position_id?: string; position_seq?: number; leverage?: number; funding_total?: string;
}

// target: {} = the wallet's own account, { sub_account_id } = an owned sub-account (master wallet), { vault_id } = a vault
type Target = { sub_account_id?: string; vault_id?: string };

class StrikeUserStream {
  private ws?: WebSocket;
  private nextId = 1;
  private subscribeId = 0;
  private lastTradeId = 0;
  readonly openOrders = new Map<number, OrderTradeUpdate>();
  readonly positions = new Map<string, WsPosition>(); // this account only, by symbol (one-way mode)
  walletBalance?: string;

  constructor(
    private apiKey: string,              // 64 hex public key
    private privateKey: Uint8Array,      // 32-byte Ed25519 seed
    private target: Target = {},
    private onResync: (sinceTradeId: number) => Promise<void> = async () => {},
    private url = "wss://api.strikefinance.org/ws/user-api"
  ) {}

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => void this.logon();
    ws.onmessage = (ev) => {
      for (const line of String(ev.data).split("\n")) {   // frames may hold several JSON objects
        if (line.trim()) this.handle(JSON.parse(line));
      }
    };
    ws.onclose = () => setTimeout(() => this.connect(), 1000 + Math.random() * 2000);
  }

  private send(msg: Record<string, unknown>): number {
    const id = this.nextId++;
    this.ws?.send(JSON.stringify({ ...msg, id }));
    return id;
  }

  private async logon(): Promise<void> {
    const timestamp = Date.now(); // milliseconds
    const message = new TextEncoder().encode(`session.logon:${timestamp}:${this.apiKey}`);
    const signature = HEX(await ed.signAsync(message, this.privateKey));
    this.send({ method: "session.logon", params: { apiKey: this.apiKey, signature, timestamp } });
  }

  private handle(msg: any): void {
    if (msg.status === 200 && msg.result?.authenticated) {
      this.subscribeId = this.send({ method: "subscribe", channel: "userstream", ...this.target });
      return;
    }
    if (msg.result === null && msg.id === this.subscribeId) {
      void this.onResync(this.lastTradeId); // subscribed: now reload REST state + missed fills
      return;
    }
    if (msg.e === "error") {
      console.error(`userstream error ${msg.error.code}: ${msg.error.msg}`);
      return;
    }
    switch (msg.e) {
      case "ORDER_TRADE_UPDATE": return this.onOrder(msg.data as OrderTradeUpdate);
      case "ACCOUNT_UPDATE": return this.onAccount(msg.data);
      case "strategyUpdate": return console.log("strategy", msg.s, msg.data.event_type ?? msg.data.status);
      case "rfqUpdate": return console.log("rfq", msg.data.rfq_id, msg.data.status, msg.data.revision);
    }
  }

  private onOrder(u: OrderTradeUpdate): void {
    if (u.t > 0) {
      this.lastTradeId = Math.max(this.lastTradeId, u.t);
      console.log(`fill ${u.S} ${u.l} ${u.s} @ ${u.L} fee=${u.n} builder=${u.builder_fee ?? "0"} rp=${u.rp}`);
      return; // track order state from order updates (t == 0)
    }
    if (TERMINAL.has(u.X)) this.openOrders.delete(u.i);
    else if (u.X === "NEW" || u.X === "OPEN") this.openOrders.set(u.i, u);
    if (u.X === "REJECTED") console.warn(`rejected ${u.c}: ${u.cr}`);
  }

  private onAccount(d: any): void {
    if (d.event_type) {                       // wrapped async outcome / vault / credit event
      console.log(d.event_type, d.event_data);
      return;
    }
    if (d.B?.length) this.walletBalance = d.B[0].wb;
    for (const p of (d.P ?? []) as WsPosition[]) {
      const held = this.positions.get(p.s);
      if (held && held.position_id === p.position_id && (p.position_seq ?? 0) < (held.position_seq ?? 0)) continue;
      if (Number(p.pa) === 0) this.positions.delete(p.s);
      else this.positions.set(p.s, p);
    }
  }
}

// Usage: one socket for the master, one per sub-account you follow
const resync = (label: string) => async (since: number) => {
  // GET /v2/openOrders, /v2/positions, /v2/balances, /v2/history/fill?since_trade_id=${since}
  // (add sub_account_id=... for the sub-account stream)
};
new StrikeUserStream(PUBLIC_KEY_HEX, PRIVATE_KEY_SEED, {}, resync("master")).connect();
new StrikeUserStream(PUBLIC_KEY_HEX, PRIVATE_KEY_SEED, { sub_account_id: SUB_ID }, resync("sub")).connect();
```
