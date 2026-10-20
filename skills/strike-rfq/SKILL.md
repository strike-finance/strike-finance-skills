---
name: strike-rfq
description: Strike Finance RFQ (request for quote) -- nonbinding liquidity requests. Requester create / read / close (`POST /v2/rfq`, `GET`/`DELETE /v2/rfq/{rfq_id}`) with idempotent `client_rfq_id`, `vault_id`/`sub_account_id` scopes and `rfqUpdate` events; allowlisted Quoter (market maker) feed on the `rfq` WebSocket channel, including Prospective RFQs (conditional and liquidation flow), and Quoter responses (`PUT /v2/rfq/{rfq_id}/response`); lifecycle, limits and error codes. Use when asking market makers to add book liquidity before a large order, or when building a quoter bot that reacts to RFQs.
---

# Strike Finance RFQ

Base URL: `https://api.strikefinance.org` (testnet `https://api-v2-testnet.strikefinance.org`). Signing: **strike-auth** (`signRequest` / `authenticatedFetch`). Ordinary orders: **strike-trading**. Socket logon, envelope and keepalive: **strike-userstream**.

## What an RFQ is (and is not)

- An RFQ tells Strike's allowlisted **Quoters** that someone may trade `requested_size` of `symbol` soon. Quoters respond by adjusting their **ordinary public order-book orders** and reporting a status.
- It is **indicative only**. There are no quote prices, no firm or executable quotes, no accept step, no reservation, no Quoter selection, no RFQ order type, no RFQ fill, no RFQ fee and no link between an RFQ and any order or fill.
- To trade, the requester places a normal order (`POST /v2/order`, e.g. market or IOC limit; see **strike-trading**) at whatever the book offers, with normal fees and `X-Builder-Fee-Bps` rules. RFQ routes ignore `X-Builder-Fee-Bps`.
- `side` is the **requester's** (expected taker's) side: `buy` asks Quoters to prepare asks, `sell` asks them to prepare bids, omitted asks for both sides.
- The whole feature ships **disabled**. While disabled, every RFQ request that passes the body limit, authentication and trading gate returns `503 {"error":"RFQ is paused","code":"RFQ_PAUSED"}` (the gate is checked inside the handler) and the `rfq` channel returns `503 RFQ subscriptions are unavailable`. Creation has its own gate: with it off, new creates return `503 RFQ creation is paused` while reads, closes, responses and idempotent replays keep working.

## Auth and limits

| Route | Middleware | Who |
|---|---|---|
| `GET /v2/rfq/{rfq_id}` | body limit, API wallet or JWT | Requester (owner only) |
| `POST /v2/rfq` | body limit, API wallet or JWT, trading | Requester |
| `DELETE /v2/rfq/{rfq_id}` | body limit, API wallet or JWT, trading | Requester (owner only) |
| `PUT /v2/rfq/{rfq_id}/response` | body limit, API wallet or JWT, trading | Allowlisted Quoter |

- Authentication is required on all four (no headers → `401 {"error":"missing authorization header"}`). The trading gate only affects JWT sessions; API wallets pass it. None is masterOnly: sub-account API wallets can request (as themselves) and quote (if allowlisted).
- **Body limit runs before auth:** a body over **4 KiB** (or a `Content-Length` over 4096) is `400 {"error":"invalid RFQ request body","code":"RFQ_INVALID_BODY"}` before the signature is checked.
- There is no list route (`GET /v2/rfq` is not registered); keep the `rfq_id` you get back. RFQ routes are not served on the DMA host.
- Errors are `{"error": "<message>", "code": "<CODE>"}`; middleware auth errors and the scope errors listed below have no `code`.
- Rate limits: the general per-key API limit (**strike-auth**) plus an RFQ create limit of **3 successful new RFQs per requester account per 60 s window** (default config). The window starts at the first successful create and is not extended. Replays and rejected creates do not count. Over the limit: `429 RFQ_RATE_LIMITED` with a `Retry-After` header (whole seconds, at least 1).
- No cap on open RFQs beyond the create limit. Default lifetime is **60 s**; records stay readable for **24 h after expiry**, then `404`.

### Strict JSON (POST and PUT)

- Exactly one JSON object. Unknown fields, duplicate fields, case variants (`"Symbol"`), and trailing data are all `400`.
- Decimals must be JSON **strings** in canonical form: positive, no `+`, no leading zeros, no exponent (`"2.5"`, `"0.01"`, `"2.50"` ok; `"+1"`, `"01"`, `"1e0"`, `"0"` rejected). A JSON number is `RFQ_INVALID_BODY`.
- Optional fields may be omitted or `null`.
- Query strings: `POST` and `PUT` accept **none**. `GET`/`DELETE` accept only `vault_id` or `sub_account_id` (once each, non-empty, no surrounding spaces). Anything else, including `account_id`, is `400 RFQ_INVALID_BODY`.

## Requester

### Account scope

The RFQ belongs to the resolved account. Use the same selector on create, read and close.

| Selector | Effect |
|---|---|
| none | The API wallet's own account (a sub-account wallet acts as its sub-account) |
| `sub_account_id` | Master wallet acting for an owned, active sub-account; otherwise `403 {"error":"sub-account access denied"}` |
| `vault_id` | Vault leader acting for the vault (vault status not checked); `404 {"error":"vault not found"}`, `403 {"error":"only vault leader can perform this action on vault account"}` |
| both | `400 RFQ_INVALID_BODY` |

`client_rfq_id` idempotency and the create rate limit are per resolved account.

### POST /v2/rfq — Create

```json
{ "client_rfq_id": "rfq-0f8c2a8e-6b1e-4f3a-9d2b-7c1e5a4b3c2d", "symbol": "BTC-USD", "requested_size": "2.5", "side": "buy" }
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `client_rfq_id` | string | Yes | 1–64 chars of `[A-Za-z0-9._:-]` (`RFQ_INVALID_CLIENT_ID`) |
| `symbol` | string | Yes | Exact market symbol from `GET /v2/markets` (`RFQ_INVALID_SYMBOL`). Market status is not checked |
| `requested_size` | string | Yes | Base units, canonical positive decimal, at most `base_prec` decimals, at most `order_limit_max_size` when that is > 0 (`RFQ_INVALID_SIZE`). Step and min size are not checked |
| `side` | string | No | `buy` \| `sell`, lowercase (`RFQ_INVALID_SIDE`). Omit for both sides |
| `vault_id` / `sub_account_id` | string | No | Body fields here (query params on GET/DELETE). Max 64 bytes |

No price, expiry, time-in-force, audience or account field exists.

**Response 200** (both new and replayed):

```json
{
  "_v": 1,
  "rfq_id": "019c0000-0000-7000-8000-000000000001",
  "client_rfq_id": "rfq-0f8c2a8e-6b1e-4f3a-9d2b-7c1e5a4b3c2d",
  "symbol": "BTC-USD",
  "requested_size": "2.5",
  "side": "buy",
  "status": "opened",
  "revision": 1,
  "total_quoter_count": 5,
  "response_count": 0,
  "response_counts": { "acked": 0, "quoted": 0, "uninterested": 0 },
  "created_at_ms": 1760000000000,
  "updated_at_ms": 1760000000000,
  "expires_at_ms": 1760000060000,
  "server_time_ms": 1760000000000
}
```

| Field | Type | Notes |
|---|---|---|
| `_v` | number | Always `1` |
| `rfq_id` | string | UUIDv7, assigned by the server |
| `requested_size` | string | Echoes the exact string you sent (`"2.50"` stays `"2.50"`) |
| `side` | string | Omitted when not sent |
| `status` | string | `opened` \| `quoted` \| `closed` |
| `revision` | number | Starts at 1; compare to order updates |
| `total_quoter_count` | number | Quoters on Strike's allowlist (configured, not online or notified) |
| `response_count` | number | Sum of `response_counts`; `0` once closed |
| `response_counts` | object | Current Quoter responses by status (numbers); all `0` once closed |
| `created_at_ms`, `updated_at_ms`, `expires_at_ms` | number | Unix ms |
| `closed_at_ms` | number | Only when `status` is `closed`; equals `updated_at_ms` |
| `server_time_ms` | number | REST responses only. Use `expires_at_ms - server_time_ms` for a local countdown |

Individual Quoter identities, timestamps and sizes are never shown to the requester.

**Idempotency:** a repeat with the same `client_rfq_id` and the same `symbol`, exact `requested_size` string and `side` (on the same account) returns the existing RFQ with `200` and publishes nothing new, even if it has since closed, creation is paused, the rate limit is hit, or the market rules changed. Any difference is `409 RFQ_IDEMPOTENCY_CONFLICT`. The mapping lasts as long as the record (expiry + 24 h), so **use a new `client_rfq_id` for every new RFQ**. After a timeout or `503 RFQ_MUTATION_INDETERMINATE`, resend the identical body.

Check order: feature gate, query, body fields (in table order), account scope, then idempotent replay, creation gate / market rules, rate limit.

### GET /v2/rfq/{rfq_id} — Read

Query: optional `vault_id` or `sub_account_id` (the scope used at create). Returns the same object as create. This is the authoritative state; the server applies expiry when you read. Unknown id, another account's RFQ, an id over 64 bytes, or a purged record: `404 RFQ_NOT_FOUND`.

### DELETE /v2/rfq/{rfq_id} — Close

Same query selectors; send no body. Returns the RFQ object with `status: "closed"`. An open RFQ gets `closed_at_ms` = now, `revision + 1`, a `clear` to Quoters and an `rfqUpdate`. Closing an already closed or expired RFQ returns `200` with its current state and publishes nothing. Another account's RFQ is `404 RFQ_NOT_FOUND`.

### Lifecycle

```
            quoter responses (quoted count > 0 <-> 0)
  create ──► opened ◄────────────────────────────► quoted
                │                                     │
                └──── DELETE, or expires_at_ms ───────┴──► closed (terminal)
```

- Active status is computed from Quoter responses: `quoted` exactly while at least one Quoter's current response is `quoted`, else `opened`. It can go back to `opened` if that Quoter changes its response.
- `quoted` means a Quoter says it prepared order-book liquidity at response time. It does not mean that liquidity is still there, reserved or fillable.
- `revision` goes up by 1 on every Quoter **status** change (including `acked` → `uninterested`), on close, and once when expiry is first applied. Quoter size-only changes do not change it.
- Expiry is applied lazily: the first read or close after `expires_at_ms` returns `closed` with `closed_at_ms` = `expires_at_ms`. **No event is sent on expiry**, so run your own timer.
- Closed RFQs reject Quoter responses (`409 RFQ_CLOSED`).

### Real-time: `rfqUpdate`

Best-effort `rfqUpdate` events arrive on your normal authenticated `userstream` subscription (own account, or an owned sub-account subscribed with `sub_account_id`). Payload and envelope: **strike-userstream** (`data` is the object above without `server_time_ms`; `E` = `updated_at_ms`).

- Sent after create, close, and each Quoter status change. Never on expiry, never after `expires_at_ms`, never for Quoter size-only changes.
- **Vault RFQs get no `rfqUpdate`** (public vault subscriptions are excluded). Poll `GET ?vault_id=` instead.
- Intermediate revisions can be skipped. Apply an update only if `rfq_id` matches and `revision` is higher than the one you hold; `GET` is the authority.

## Quoter (market maker)

### Becoming a Quoter

There is no API for it. Strike adds the account ID to two server allowlists: the API list (for `PUT .../response`) and the userstream list (for the `rfq` channel). The ID checked is the account your API wallet **authenticates as**: for a sub-account wallet that is the sub-account. There is no selector to respond on behalf of a vault or another account. Not allowlisted: `403 {"error":"Quoter authorization required","code":"QUOTER_REQUIRED"}` on PUT, `403 RFQ subscription requires an authorized Quoter account` on the socket.

### Subscribe to the feed

1. Open a **dedicated** socket to `wss://<host>/ws/user-api` and `session.logon` (**strike-userstream**).
2. After the logon reply, send exactly `{"method":"subscribe","channel":"rfq","id":1}`. Only these three keys are allowed, `channel` must be lowercase `rfq`, and `id` must be an integer. Reply: `{"result":null,"id":1}`. Subscribing again is idempotent. `{"method":"unsubscribe","channel":"rfq","id":2}` leaves the feed, but the socket stays RFQ-only. An allowlisted Quoter that sends `unsubscribe` on a socket that never subscribed to `rfq` is disconnected.
3. The socket becomes RFQ-only: any ordinary subscribe on it fails (`400 RFQ sockets cannot have ordinary subscriptions`), and an `rfq` subscribe on a socket that already has ordinary subscriptions fails with the same error. Keep account data on a separate socket.

There are no symbol or kind filters (filter on your side), no snapshot and no replay. A Quoter that connects after an RFQ was published never sees that RFQ.

Subscribe errors (as `{"e":"error","E":...,"error":{"code":...,"msg":...}}`), checked in this order: `400 Invalid JSON format` (e.g. duplicate keys); `400 RFQ subscriptions require exactly method, channel, and id` (also Binance-style `params: ["rfq"]` / `"<x>@rfq"`); `400 Invalid RFQ subscription request` (wrong method, channel case, or non-integer `id`); `401 Authentication required before subscribing to RFQ`; `400 RFQ sockets cannot have ordinary subscriptions`; `503 RFQ subscriptions are unavailable` (feature off or the server is reconnecting); `403 RFQ subscription requires an authorized Quoter account`.

### Feed events

Each event is one raw JSON object per frame, with no `e`/`E` envelope. Tell them apart by `type`. Subscription replies (`result`/`id`) and errors (`e: "error"`) arrive on the same socket. Decimals are strings and times are Unix ms.

**RFQ** (`type: "rfq"`):

```json
{"_v":1,"type":"rfq","op":"set","rfq_id":"019c0000-0000-7000-8000-000000000001",
 "rfq":{"symbol":"BTC-USD","size":"2.5","side":"buy","created_at_ms":1760000000000,"expires_at_ms":1760000060000}}
{"_v":1,"type":"rfq","op":"clear","rfq_id":"019c0000-0000-7000-8000-000000000001"}
```

- `set` is a new RFQ. `rfq.size` is the requested base size. `rfq.side` is the requester's side and is omitted for both sides. No requester identity, `client_rfq_id` or counts are included.
- `clear` means the requester closed it. **Expiry sends no `clear`**: drop the RFQ yourself at `expires_at_ms`.
- Some RFQs come from Strike's engine when a vault must unwind positions. They always have `side`, live about **5 s** (`expires_at_ms = created_at_ms + 5000`), never get a `clear`, and are not sent to that vault's leader account. You can respond to them like any other RFQ. No earlier than 1 s after creation the engine sends reduce-only IOC orders for that size to the public book.

**Prospective RFQ** (`type: "prosp_rfq"`): engine-derived aggregates of possible near-term taker flow. Each event replaces the full state for one `(kind, symbol)`. There is no `rfq_id`, no identities, and no response.

```json
{"_v":1,"type":"prosp_rfq","op":"set","symbol":"BTC-USD","kind":"conditional","source_seq":42,
 "source_time_ms":1720000000123,"expires_at_ms":1720000005123,
 "conditional":{"resolution_bps":10,"cohorts":[
   {"side":"buy","working_type":"mark_price","trigger_price":"60000.0","bound_price":"60600","size":"1.250"}]}}
{"_v":1,"type":"prosp_rfq","op":"set","symbol":"ETH-USD","kind":"liquidation","source_seq":43,
 "source_time_ms":1720000001000,"expires_at_ms":1720000006000,
 "liquidation":{"resolution_bps":10,"cohorts":[{"side":"sell","bound_price":"3069.0","size":"2"}]}}
{"_v":1,"type":"prosp_rfq","op":"clear","symbol":"BTC-USD","kind":"conditional","source_seq":44,
 "source_time_ms":1720000002000,"expires_at_ms":1720000007000}
```

| Field | Meaning |
|---|---|
| `kind` | `conditional`: untriggered stop / take-profit orders (and activated trailing stops) near their trigger. `liquidation`: positions whose liquidation check puts them at the reduce-only level with margin ratio ≥ 95% (not yet being liquidated) |
| `source_seq` | Ordering within one `(kind, symbol)` only. Apply a higher value and ignore a lower one. Gaps are normal, and many identities can share one value |
| `expires_at_ms` | Always `source_time_ms + 5000`; refreshed by later events |
| `set` | Carries exactly the `kind`'s body, `conditional` or `liquidation`, holding 1–64 `cohorts`; `resolution_bps` 1–1000. Conditional cohorts are sorted by `side`, `working_type`, `trigger_price`, `bound_price`; liquidation cohorts by `side`, `bound_price` |
| `clear` | No body; drop that `(kind, symbol)` |
| cohort `side` | Expected **taker** side (`buy` \| `sell`) |
| `trigger_price`, `working_type` | Conditional only: rounded trigger and its price source (`mark_price` \| `contract_price`) |
| `bound_price` | Worst price the flow could execute at, rounded conservatively (conditional: market slippage bound or the order's limit price; liquidation: the first liquidation IOC's price bound). Not a predicted fill |
| `size` | Summed base size (liquidation: estimated first liquidation IOC size, not the full position) |

### Delivery rules

- The server drops events already past `expires_at_ms`, both on arrival and right before writing to your socket. Enforce expiry yourself too.
- Each RFQ socket has a 1024-message queue. If you fall behind and it fills, the server closes that socket. If the server loses its upstream feed, it closes every RFQ socket.
- On any disconnect: clear **all** RFQ and Prospective state, reconnect, log on, subscribe, and wait for new events.

### PUT /v2/rfq/{rfq_id}/response — Report status

```json
{ "status": "quoted", "bid_size": "1.5", "ask_size": "2.0" }
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `status` | string | Yes | `acked` (received, no liquidity claim) \| `quoted` (ordinary book orders prepared) \| `uninterested` |
| `bid_size`, `ask_size` | string | No | Only with `quoted`. Canonical positive decimal base size. Not checked against market rules. Informational: stored, never shown to the requester |

No query string or other field (price, order IDs, account) is accepted (`400 {"error":"invalid RFQ response","code":"RFQ_INVALID_RESPONSE"}`; an oversized body gives `RFQ_INVALID_BODY` instead).

**Response 200** (your current response):

```json
{ "status": "quoted", "bid_size": "1.5", "ask_size": "2.0", "responded_at_ms": 1760000001000, "updated_at_ms": 1760000001000 }
```

- You have one current response per RFQ, and each PUT replaces it entirely (omitting sizes clears them). `responded_at_ms` is fixed at your first response; `updated_at_ms` changes when anything changes. While the RFQ is open, an identical PUT is a no-op `200` and is safe to retry. The closed/expired check runs first, so after close or expiry even an identical PUT gets `409 RFQ_CLOSED`.
- A status change updates the requester's counts and lifecycle status, bumps `revision` and sends them an `rfqUpdate`. A size-only change does not.
- Responses never create orders, reserve size or commit you to a price. Manage your real book orders through **strike-trading** (e.g. `POST /v2/orders/replace`) and keep normal repricing. Quoted orders left stale give takers a free option.
- Errors: `403 QUOTER_REQUIRED`; `404 RFQ_NOT_FOUND` (unknown or purged id, or you are excluded from this engine-created RFQ); `409 {"error":"RFQ is closed","code":"RFQ_CLOSED"}` (closed or expired); `503` codes below. Stop responding to an RFQ after a 404 or 409.

## Error reference

| Status | `code` | `error` | When |
|---|---|---|---|
| 400 | `RFQ_INVALID_BODY` | `invalid RFQ request body` | Body > 4 KiB, not one object, unknown / duplicate / case-variant field, wrong JSON type, trailing data, query on POST, bad GET/DELETE query, both selectors |
| 400 | `RFQ_INVALID_CLIENT_ID` | `invalid RFQ client_rfq_id` | Missing, too long, bad characters |
| 400 | `RFQ_INVALID_SYMBOL` | `invalid RFQ symbol` | Malformed or unknown market |
| 400 | `RFQ_INVALID_SIZE` | `invalid RFQ size` | Missing, non-canonical, ≤ 0, over `base_prec`, over `order_limit_max_size` |
| 400 | `RFQ_INVALID_SIDE` | `invalid RFQ side` | Not `buy` / `sell` |
| 400 | `RFQ_INVALID_RESPONSE` | `invalid RFQ response` | Bad PUT body or any PUT query |
| 403 | `QUOTER_REQUIRED` | `Quoter authorization required` | PUT by a non-allowlisted account |
| 404 | `RFQ_NOT_FOUND` | `RFQ not found` | Absent, not yours, purged, engine-created (DELETE), excluded Quoter (PUT) |
| 409 | `RFQ_IDEMPOTENCY_CONFLICT` | `RFQ idempotency conflict` | Reused `client_rfq_id` with different fields |
| 409 | `RFQ_CLOSED` | `RFQ is closed` | PUT on a closed or expired RFQ |
| 429 | `RFQ_RATE_LIMITED` | `RFQ creation rate limit exceeded` | Create limit; see `Retry-After` |
| 503 | `RFQ_PAUSED` | `RFQ is paused` / `RFQ creation is paused` | Feature off / new creation off |
| 503 | `RFQ_REDIS_UNAVAILABLE` | `RFQ unavailable` / `RFQ authorization unavailable` | Backend store unavailable; retry |
| 503 | `RFQ_MUTATION_INDETERMINATE` | `RFQ mutation outcome is indeterminate` | Outcome unknown: resend the identical request, or `GET` |
| 401 / 403 / 404 / 500 | (none) | auth errors (**strike-auth**), `sub-account access denied`, `only vault leader can perform this action on vault account`, `vault not found`, `failed to process vault`, `failed to resolve RFQ authorization`, `failed to generate RFQ ID` | Middleware, account scope, create internals |

## TypeScript

Requester: create (retry-safe), track until expiry, trade on the book, then close.

```typescript
import { authenticatedFetch } from "./auth"; // strike-auth

const BASE = "https://api.strikefinance.org";
declare const PRIVATE_KEY: Uint8Array, PUBLIC_KEY_HEX: string;

interface RFQ {
  _v: 1; rfq_id: string; client_rfq_id: string; symbol: string; requested_size: string; side?: "buy" | "sell";
  status: "opened" | "quoted" | "closed"; revision: number; total_quoter_count: number; response_count: number;
  response_counts: { acked: number; quoted: number; uninterested: number };
  created_at_ms: number; updated_at_ms: number; expires_at_ms: number; closed_at_ms?: number; server_time_ms?: number;
}

const call = (method: string, path: string, body?: unknown) =>
  authenticatedFetch(BASE, path, { method, body }, PRIVATE_KEY, PUBLIC_KEY_HEX); // new nonce per call

export async function createRFQ(symbol: string, requestedSize: string, side?: "buy" | "sell"): Promise<RFQ> {
  const body = { client_rfq_id: `rfq-${crypto.randomUUID()}`, symbol, requested_size: requestedSize, ...(side ? { side } : {}) };
  for (let attempt = 0; ; attempt++) {
    const res = await call("POST", "/v2/rfq", body).catch(() => undefined); // network error: resend the identical body
    if (res?.ok) return res.json();
    const err = res ? await res.json().catch(() => ({})) : { code: "NETWORK" };
    const retryable = ["NETWORK", "RFQ_MUTATION_INDETERMINATE", "RFQ_REDIS_UNAVAILABLE"].includes(err.code);
    if (!retryable || attempt >= 3) throw new Error(`${res?.status ?? "network"} ${err.code ?? ""} ${err.error ?? ""}`);
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
}

const tracked = new Map<string, RFQ>();
export function track(rfq: RFQ): void {
  const held = tracked.get(rfq.rfq_id);
  if (!held || rfq.revision > held.revision) tracked.set(rfq.rfq_id, rfq);
  if (rfq.server_time_ms !== undefined) {           // local timer: no event is sent on expiry
    setTimeout(() => tracked.delete(rfq.rfq_id), rfq.expires_at_ms - rfq.server_time_ms);
  }
}
// From the userstream socket: if (msg.e === "rfqUpdate") track(msg.data);

const rfq = await createRFQ("BTC-USD", "25");
track(rfq);
// ...when ready (e.g. status "quoted" or a short wait), trade on the book like any order (strike-trading):
await call("POST", "/v2/order", { symbol: "BTC-USD", side: "buy", type: "market", size: "25", slippage: "0.005" });
await call("DELETE", `/v2/rfq/${rfq.rfq_id}`); // idempotent; add ?sub_account_id=... / ?vault_id=... if used at create
```

Quoter: dedicated feed socket plus responses.

```typescript
import * as ed from "@noble/ed25519"; // v2; signAsync uses WebCrypto SHA-512
import { authenticatedFetch } from "./auth";

const BASE = "https://api.strikefinance.org";
declare const PRIVATE_KEY: Uint8Array, PUBLIC_KEY_HEX: string;
declare function onBookChange(): void; // your quoting loop (orders via strike-trading)

type Side = "buy" | "sell";
const rfqs = new Map<string, { symbol: string; size: string; side?: Side; expiresAtMs: number }>();
const prospective = new Map<string, { seq: number; expiresAtMs: number; body: unknown }>(); // key `${kind}:${symbol}`

async function respond(rfqId: string, body: { status: "acked" | "quoted" | "uninterested"; bid_size?: string; ask_size?: string }) {
  const res = await authenticatedFetch(BASE, `/v2/rfq/${rfqId}/response`, { method: "PUT", body }, PRIVATE_KEY, PUBLIC_KEY_HEX);
  if (res.status === 404 || res.status === 409) rfqs.delete(rfqId); // gone, closed or expired: stop
}

export function connectQuoterFeed(url = "wss://api.strikefinance.org/ws/user-api"): void {
  const ws = new WebSocket(url);
  ws.onopen = async () => {
    const timestamp = Date.now();
    const sig = await ed.signAsync(new TextEncoder().encode(`session.logon:${timestamp}:${PUBLIC_KEY_HEX}`), PRIVATE_KEY);
    ws.send(JSON.stringify({ id: 1, method: "session.logon",
      params: { apiKey: PUBLIC_KEY_HEX, signature: Buffer.from(sig).toString("hex"), timestamp } }));
  };
  ws.onmessage = (ev) => {
    for (const line of String(ev.data).split("\n")) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.status === 200 && m.result?.authenticated) {
        ws.send(JSON.stringify({ method: "subscribe", channel: "rfq", id: 2 })); // exactly these keys
      } else if (m.e === "error") {
        console.error(`rfq feed ${m.error.code}: ${m.error.msg}`);
      } else if (m.type === "rfq") {
        if (m.op === "clear") { rfqs.delete(m.rfq_id); onBookChange(); continue; }
        if (m.rfq.expires_at_ms <= Date.now()) continue;
        rfqs.set(m.rfq_id, { symbol: m.rfq.symbol, size: m.rfq.size, side: m.rfq.side, expiresAtMs: m.rfq.expires_at_ms });
        void respond(m.rfq_id, { status: "acked" });
        onBookChange(); // re-quote; after your orders are acknowledged: respond(id, { status: "quoted" })
      } else if (m.type === "prosp_rfq") {
        const key = `${m.kind}:${m.symbol}`;
        const held = prospective.get(key);
        if (held && m.source_seq < held.seq) continue;
        if (m.op === "clear") prospective.delete(key);
        else prospective.set(key, { seq: m.source_seq, expiresAtMs: m.expires_at_ms, body: m.conditional ?? m.liquidation });
        onBookChange();
      }
    }
  };
  ws.onclose = () => {                     // no replay: forget everything and resubscribe
    rfqs.clear(); prospective.clear(); onBookChange();
    setTimeout(() => connectQuoterFeed(url), 1000 + Math.random() * 2000);
  };
}

setInterval(() => {                        // expiry produces no event
  const now = Date.now();
  for (const [id, r] of rfqs) if (r.expiresAtMs <= now) rfqs.delete(id);
  for (const [k, p] of prospective) if (p.expiresAtMs <= now) prospective.delete(k);
}, 250);
```
