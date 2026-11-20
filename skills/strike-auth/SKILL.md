---
name: strike-auth
description: Strike Finance API authentication — builder connect (wallet signature → account + API wallet), Ed25519 API wallet request signing, X-Builder-Fee-Bps, auth route groups, sub-account keys, per-key IP allowlists, and auth error handling. Use when implementing sign up, connect, or request signing.
---

# Strike Finance Authentication

## API Servers

| Environment | Base URL |
|-------------|----------|
| Mainnet | `https://api.strikefinance.org` |
| Testnet | `https://api-v2-testnet.strikefinance.org` |

Integrators (builders, bots, market makers) authenticate with an **API wallet**: an Ed25519 keypair whose public key is registered to a Strike account. The Strike app itself uses JWTs; JWT-only routes are not reachable with an API wallet.

## Route Groups

| Group | Auth | Examples |
|-------|------|----------|
| Public | none | `GET /v2/ping`, `/v2/time`, `/v2/_status`, `/v2/markets`, `/v2/markets/:symbol`, `/v2/fee-tiers`, `/v2/account/by-nickname`, `POST /auth/builder/*`; vault reads `GET /v2/vaults`, `/v2/vault/:id`, `/v2/vault/:id/{history,portfolio,depositors,liquidations,announcements}`; copy discovery `GET /v2/copy/lead-traders`, `/v2/copy/leaderboard`, `/v2/copy/copiers`, `/v2/copy/discover`, `/v2/copy/discover/filters`, `/v2/copy/discover/:address` |
| Read (FlexibleAuth) | optional | `GET /v2/account`, `/v2/balances`, `/v2/portfolio`, `/v2/positions`, `/v2/openOrders`, `/v2/history/*`, history exports (`POST /v2/{orders,fills,funding}/export`, `GET /v2/{orders,fills,funding}/export/:jobId`), `/v2/algo/twap*`, grid bot reads (`/v2/grid/bot`, `/v2/grid/bot/:id`, `/v2/grid/bot/:id/orders`), copy reads (`/v2/copy/subscriptions`, `/v2/copy/orders`, `/v2/copy/positions`, `/v2/copy/lead/stats`, `GET /v2/copy/saved`), vault depositor reads (`/v2/vault/position`, `/v2/vault/positions`, `/v2/vault/history`, `/v2/vault/my-deposits/history`), credit reads (`/v2/credit/{account,history,collateral-assets,settings}`) |
| API wallet or JWT | required | `GET /v2/sub-accounts`, `GET /v2/rfq/:rfq_id`, `GET /v2/vault/:id/recovery-settings`, `POST /v2/copy/saved`, `DELETE /v2/copy/saved/:account_id`; masterOnly: sub-account management `POST /v2/sub-accounts`, `PATCH`/`DELETE /v2/sub-accounts/:account_id`, `POST /v2/sub-accounts/:account_id/{archive,unarchive}`, `POST /v2/sub-accounts/transfer` (strike-account), and `POST /v2/crates/open`, `GET /v2/crates/history`; also `GET /v2/symbols`, `/v2/withdraw/limits`, `/v2/withdraw/queue-position` (FlexibleAuth group, but the handler needs an account: `401 {"error":"account_id not found in auth context"}`) |
| Trading | required | orders, `POST`/`DELETE /v2/_guards`, leverage, margin, TWAP; grid bot `POST /v2/grid/bot`, `DELETE /v2/grid/bot/:id`; copy `POST /v2/copy/subscribe`, `PATCH`/`DELETE /v2/copy/subscribe/:id`; RFQ `POST /v2/rfq`, `DELETE /v2/rfq/:rfq_id`, `PUT /v2/rfq/:rfq_id/response`; masterOnly: vault `POST /v2/vault/create`, `/v2/vault/deposit`, `/v2/vault/withdraw`, `/v2/vault/:id/withdrawals/:withdrawal_id/cancel`, `/v2/vault/:id/pause`, `/v2/vault/:id/resume`, `PATCH /v2/vault/:id/recovery-settings`, `/v2/deposit/quote`, `/v2/deposit/build-tx`, `/v2/deposit`, `/v2/withdraw/quote`, `/v2/withdraw/estimate`, `/v2/withdraw`, and credit writes `POST /v2/credit/portfolio/manage`, `/v2/credit/collateral/purchase` |
| JWT-only (Strike app) | JWT | `POST /v2/account/profile`, `/v2/wallet(s)` (incl. `PUT /v2/wallet/:id/allowed-ips`), `/v2/builder*` (register, dashboard, approvals, `POST /v2/builder/revoke`), `/v2/pending-quotes`, `/v2/transaction/status`, `/v2/deposit/{cardano,ethereum}/address`, `/v2/internal-transfers*`, `/v2/copy/labels*`, vault announcements `POST /v2/vault/:id/announcements`, `DELETE /v2/vault/:id/announcements/:announcement_id` |

Details: strike-trading, strike-rfq, strike-grid-bot, strike-copy-trading, strike-vaults. There is no account-creation endpoint: accounts come from builder connect.

- **FlexibleAuth**: if `X-API-Wallet-Public-Key` is present the request is fully verified as an API wallet request (any failure → `401`/`403`, even on otherwise public reads). Without it, a JWT is optional and anonymous callers can read public data by passing `account_id`, `vault_id`, or `blockchain_address` (see strike-account). Reads that only serve the caller's own data (e.g. `/v2/copy/subscriptions`, `GET /v2/copy/saved`) still return `401` without auth.
- **API wallet or JWT**: same, but some authentication is required (no API wallet headers and no JWT → `401 {"error":"missing authorization header"}`).
- **Trading**: API wallet requests skip the app's periodic wallet-signature gate (`RequireEnableTrading` only applies to JWT sessions).
- **masterOnly** (sub-account management and transfers, vault management, all deposit and withdraw writes, credit writes, crates): rejects API wallets bound to a sub-account with `403 {"error":"not available to sub-account API keys"}`.
- Some routes also return `503 {"error":"service unavailable"}` while the API is warming up.

## Ed25519 Keypair Generation

`@noble/ed25519` **v2** (the reference app uses `^2.1.0`):

```typescript
import * as ed from "@noble/ed25519";               // v2.x
import { sha512 } from "@noble/hashes/sha2.js";     // @noble/hashes v1.8+ or v2

// Required before the sync API (getPublicKey / sign)
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const privateKey = ed.utils.randomPrivateKey();     // 32 bytes — keep secret
const publicKey = ed.getPublicKey(privateKey);      // 32 bytes
const publicKeyHex = ed.etc.bytesToHex(publicKey);  // 64 lowercase hex chars
```

- Without `sha512Sync`, use the async API instead (`await ed.getPublicKeyAsync`, `await ed.signAsync`; WebCrypto).
- `@noble/hashes` v2 only exports the `.js` subpaths (`@noble/hashes/sha2.js`, `@noble/hashes/utils.js`); the old `@noble/hashes/sha512` path no longer exists.
- `@noble/ed25519` v3 renamed these (`utils.randomSecretKey`, `hashes.sha512`); the snippets here are v2.
- Generate a **fresh keypair for every connect**: `api_wallets.public_key` is unique, so re-registering any previously used key (even a revoked one) fails with `500 {"error":"failed to create API wallet"}`.
- The server looks keys up by exact string, so always send the public key exactly as registered (use lowercase hex).

## Builder Connect Flow

Two public calls. The user's chain wallet signs a consent message; Strike creates the account if needed, approves your builder code with the user's max fee, and registers your API wallet public key.

### Step 1: Request Signature

```
POST /auth/builder/request-signature
```

```json
{
  "address": "0xUserWalletAddress",
  "chain": "ethereum",
  "code": "your-builder-code",
  "fee_share_bps": 50,
  "public_key": "64-hex-char-ed25519-public-key",
  "referral_code": "OPTIONAL"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `address` | string | Yes | User's wallet address on `chain` |
| `chain` | string | Yes | `ethereum` \| `solana` \| `cardano` (case-insensitive) |
| `code` | string | Yes | Your builder code; must exist and be active |
| `fee_share_bps` | integer | Yes | Max builder fee the user approves, `0`–`100` bps (100 = 1%; the cap is deployment config, default 100) |
| `public_key` | string | Yes | Ed25519 public key, exactly 64 hex chars |
| `referral_code` | string | No | Referral code owned by the builder-code owner's account |

The body is decoded strictly: **unknown fields are rejected** (`400 {"error":"json: unknown field \"max_fee_bps\""}`) and only one JSON object is allowed.

**Response:**

```json
{
  "nonce": "0192f0c1-7b8e-7c3a-9d61-2f1e4b5a6c7d",
  "message_to_sign": "Connect to Strike via builder \"your-builder-code\".\n...",
  "message": "Connect to Strike via builder \"your-builder-code\".\n...",
  "referral_code": "OPTIONAL"
}
```

`message` duplicates `message_to_sign`; `referral_code` is present only when one was accepted. The challenge is stored for **5 minutes** and is single-use: any verify attempt, including one with a bad signature, consumes it.

`message_to_sign` format (sign it verbatim — do not rebuild it):

```
Connect to Strike via builder "{code}".
This authorizes the builder to collect up to {fee_share_bps/100}% fee on your trades.
Referral attribution: none.
By signing, you are entrusting your API wallet private key to this builder. You trust the builder to store and use this key responsibly.
Wallet: {address}
Chain: {chain}
API Key: {public_key}
Nonce: {nonce}
Timestamp: {RFC3339 UTC}

Complete verify-signature within 5 minutes; after that the challenge expires.
```

With a `referral_code`, the referral line becomes `Referral attribution: Strike will attempt to record builder "{code}" as your permanent referrer if you are eligible and do not already have one.` followed by `Referral code: {referral_code}.`

**Errors (400 unless noted):** `address is required`, `chain is required`, `code is required`, `fee_share_bps is required`, `public_key is required`, `chain must be ethereum, solana, or cardano`, `invalid public key: must be 64 hex characters (Ed25519)`, `invalid public key: must be hex-encoded`, `fee_share_bps must be 0-100`, `builder is not active`, `cannot connect an account to its own builder code` (the address already belongs to the account that owns `code`), `referral code does not belong to the builder`, `404 builder code not found`.

### Sign the challenge with the user's wallet

| Chain | How to sign `message_to_sign` | `wallet_signature` value |
|-------|-------------------------------|--------------------------|
| Ethereum | EIP-191 `personal_sign` | Hex, with or without `0x` (65-byte EOA signature; ERC-1271 smart-wallet signatures are checked on-chain where enabled) |
| Solana | `signMessage(utf8Bytes(message))` | Base58 of the 64-byte signature |
| Cardano | CIP-30 `signData(address, hex(utf8Bytes(message)))` | `JSON.stringify({ signature, key })` from `signData`, or `"{signatureHex}:{keyHex}"` |

For Cardano, hex-encode the message yourself (the server hex-encodes it before verifying), and sign with the same address you sent as `address` — the COSE `address` header must match it and the key must be its payment key.

### Step 2: Verify Signature

```
POST /auth/builder/verify-signature
```

```json
{
  "nonce": "0192f0c1-7b8e-7c3a-9d61-2f1e4b5a6c7d",
  "wallet_signature": "0x..."
}
```

Both fields are required. Address, chain, code, fee and public key come from the stored challenge.

On success the server: verifies the signature, creates the Strike account if the wallet has none, rejects the account that owns the builder code, **revokes any active API wallets of this account for the same builder code**, registers `public_key` as a new API wallet (no expiry), approves the builder with `fee_share_bps` as the user's max (if that fails the new wallet is deactivated again), then applies the referral best-effort.

**Response (200):**

```json
{
  "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
  "nickname": "",
  "avatar_url": "",
  "builder_code": "your-builder-code",
  "fee_share_bps": 50,
  "api_wallet_id": 1234,
  "api_wallet_public_key": "64-hex-char-ed25519-public-key",
  "api_wallet_expired_at": "9999-12-31T23:59:59Z",
  "referral": { "status": "not_requested" }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `account_id` | string | Strike account the API wallet is bound to |
| `nickname`, `avatar_url` | string | Profile values, `""` when unset |
| `builder_code` | string | |
| `fee_share_bps` | number | User's approved max builder fee |
| `api_wallet_id` | number | |
| `api_wallet_public_key` | string | |
| `api_wallet_expired_at` | string | RFC 3339; builder wallets do not expire (year 9999) |
| `referral.status` | string | `accepted` \| `already_accepted` \| `already_set` \| `skipped_self_referral` \| `skipped_circular_referral` \| `not_requested` \| `failed` |
| `referral.code` | string | Present for `accepted` / `already_accepted` |

**Errors:** `400 challenge not found or expired` (expired, unknown, or already used nonce — request a new challenge), `401 wallet signature verification failed`, `400 invalid address format`, `400 cannot connect an account to its own builder code`, `500 failed to create account`, `500 failed to create API wallet` (public key already registered), `500 failed to revoke existing builder API wallets`, `500 failed to approve builder`.

Registering a builder code (`POST /v2/builder`, no minimum balance), the builder dashboard (`GET /v2/builder`, `/v2/builder/fills`, `/v2/builder/stats`, `/v2/builder/traders`) and managing API wallets (`POST /v2/wallet`, `GET /v2/wallets`, `DELETE /v2/wallet/:id`, `PUT /v2/wallet/:id/allowed-ips`) are JWT-only (Strike app).

## API Wallet Request Signing

Every authenticated REST request carries four headers (plus an optional builder fee header):

| Header | Format |
|--------|--------|
| `X-API-Wallet-Public-Key` | 64 hex chars, exactly as registered |
| `X-API-Wallet-Signature` | Ed25519 signature, hex (128 chars) |
| `X-API-Wallet-Timestamp` | Unix **seconds** (integer) |
| `X-API-Wallet-Nonce` | 16–128 chars, single use per key (a UUID v4 works) |
| `X-Builder-Fee-Bps` | Optional, see below |

### Message

```
{METHOD}:{PATH}:{TIMESTAMP}:{NONCE}:{BODY_HASH}
```

- `METHOD` — HTTP method as sent (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`).
- `PATH` — URL path **plus `?` and the raw query string when there is one**, exactly as sent: `/v2/account`, `/v2/openOrders?symbol=BTC-USD`. No host, no scheme. The query is not re-sorted or re-encoded by the server, so sign the exact string you send.
- `TIMESTAMP` — the same integer as `X-API-Wallet-Timestamp`.
- `NONCE` — the same value as `X-API-Wallet-Nonce`.
- `BODY_HASH` — lowercase hex SHA-256 of the raw body bytes. With no body (GET, or DELETE without a body) it is SHA-256 of empty input: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` — never an empty string. Hash the exact bytes you send (serialize JSON once).

The signature is Ed25519 over the UTF-8 bytes of the message.

### Validation rules

- Timestamp must be at most **180 seconds** old and **not in the future** (the server compares whole seconds, so even 1 s ahead is rejected). Sync with `GET /v2/time` (`serverTime` is in milliseconds) and keep a ~1 s safety margin behind server time.
- A nonce is accepted once per public key; the server remembers it for 180 s. Every request — including a retry — needs a new nonce and signature.
- The nonce is consumed once the signature and the IP allowlist check pass, even if the endpoint itself then fails.
- Request bodies are capped at 8 MiB.
- Rate limits are counted per `X-API-Wallet-Public-Key` (per IP without it): `429 {"error":"rate limit exceeded"}`.

### IP allowlist

The account owner can restrict a key to source IPs in the Strike app (API Keys page; `PUT /v2/wallet/:id/allowed-ips` is JWT-only): up to 20 IPv4/IPv6 addresses or CIDR ranges. An empty list (the default, including builder-connect keys) allows any IP. A correctly signed request from another IP gets:

```json
{ "error": "request IP is not allowed for this API key", "client_ip": "203.0.113.7" }
```

with `403`. `client_ip` is the IP the API saw (the visitor IP behind Cloudflare; a dual-stack host may arrive over IPv6). The check runs after the signature and before the nonce is consumed. The user WebSocket applies the same list at `session.logon`, but a blocked logon gets the generic `401 Authentication failed` (no IP detail), and an already-open session keeps running until it reconnects. This is not a dead key: ask the user to add the IP.

### Auth errors

| Status | `error` | Cause |
|--------|---------|-------|
| 401 | `missing API wallet authentication headers` | One of the four headers missing |
| 401 | `invalid nonce format` | Nonce shorter than 16 or longer than 128 chars |
| 401 | `invalid timestamp format` | Timestamp not an integer |
| 401 | `signature expired or invalid timestamp` | Older than 180 s or in the future |
| 401 | `authentication failed` | Unknown, revoked or expired key, or bad signature |
| 401 | `request already processed` | Nonce reused |
| 401 | `wallet expired or revoked` | Key deactivated |
| 500 | `authentication service unavailable` | Nonce store unavailable; retry |
| 403 | `request IP is not allowed for this API key` | Source IP outside the key's allowlist (body adds `client_ip`) |
| 403 | `not available to sub-account API keys` | Sub-account key on a masterOnly route |

The User WebSocket (`wss://<host>/ws/user-api`) uses the same key with its own logon message — see strike-userstream.

## X-Builder-Fee-Bps

Only meaningful for API wallets created through builder connect (they carry the builder code). Read on `POST /v2/order`, `/v2/orders/batch`, `/v2/orders/replace`, `/v2/order/replace-batch` and `/v2/order/strategy`. `POST /v2/order/replace` ignores it and does not attach the builder code at all: its new order carries no builder attribution, no builder fee and no approval check.

- Grid bot, copy-trading and TWAP orders never carry a builder code (the header is ignored on those routes).
- Integer basis points, `0`–`100` (deployment cap, default 100 = 1%). Omitted → the orders carry your builder code with a fee of `0`.
- Must be `<=` the builder code's configured fee share **and** `<=` the `fee_share_bps` the user approved for the trading account.
- Failures return `400`: `invalid X-Builder-Fee-Bps header: must be an integer between 0 and 100 (basis points; 100 = 1%)`, `X-Builder-Fee-Bps 50 exceeds builder max of 20`, `X-Builder-Fee-Bps 50 exceeds your approved max of 20`, `account has not approved builder "code"`, `builder "code" is not active`, `builder code "code" not found`.
- The approval check runs on every order from a builder-code wallet, even without the header. Builder connect approves the master account only; an order sent with `sub_account_id` uses that sub-account's own approval if it has one, otherwise the master's (capped at the master's approved max). The engine attributes the fee the same way.
- The fee is charged on each fill, at 8-decimal precision, and capped at what the payer can cover at that moment (wallet outside isolated positions less cross unrealized losses, plus the traded isolated position's balance less its loss; unrealized profit does not count).

## Sub-Accounts

- A wallet bound to a **master** account (every builder-connect wallet) acts on the master by default and can target an owned, active sub-account by passing `sub_account_id` (query param on reads, body field on writes, as each endpoint documents). It can also create, rename, archive, delete and fund sub-accounts (strike-account). Unowned or inactive ids are rejected: `403 {"error":"sub-account access denied"}` on write/trading routes, `GET /v2/symbols`, `include_copies` reads, and strategy/copy reads (TWAP, grid bot, copy subscriptions/orders/positions); `401 {"error":"authentication required or provide vault_id, account_id, or blockchain_address"}` on reads that accept public selectors (`/v2/account`, `/v2/balances`, `/v2/portfolio`, `/v2/positions`, `/v2/closedPositions`, `/v2/openOrders`, `GET /v2/order`, `/v2/history/*`).
- A wallet bound to a **sub-account** (created in the Strike app via `POST /v2/wallet` with `sub_account_id`) authenticates as that sub-account only. It cannot read or trade its master or siblings, cannot use `scope=all`, and every masterOnly route (sub-account management and transfers, deposits, withdrawals, vault management, credit writes) returns `403`. Deleting the sub-account revokes its wallets.

## TypeScript Example

```typescript
import * as ed from "@noble/ed25519";                         // v2.x
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m)); // enables sync ed.sign

let clockOffsetMs = 0;

/** Align local time with the server; timestamps must never be in the future. */
export async function syncClock(baseUrl: string): Promise<void> {
  const t0 = Date.now();
  const { serverTime } = await (await fetch(`${baseUrl}/v2/time`)).json();
  clockOffsetMs = serverTime - Math.round((t0 + Date.now()) / 2);
}

export function signRequest(
  method: string,
  pathWithQuery: string,     // e.g. "/v2/openOrders?symbol=BTC-USD"
  body: string | undefined,  // exact body string sent; undefined/"" when there is no body
  privateKey: Uint8Array,
  publicKeyHex: string
): Record<string, string> {
  // 1 s behind server time: a timestamp even a fraction of a second ahead can round into the future
  const timestamp = Math.floor((Date.now() + clockOffsetMs - 1000) / 1000).toString();
  const nonce = crypto.randomUUID();
  const bodyHash = bytesToHex(sha256(utf8ToBytes(body ?? ""))); // sha256("") for no body
  const message = `${method.toUpperCase()}:${pathWithQuery}:${timestamp}:${nonce}:${bodyHash}`;
  const signature = ed.sign(utf8ToBytes(message), privateKey);
  return {
    "X-API-Wallet-Public-Key": publicKeyHex,
    "X-API-Wallet-Signature": bytesToHex(signature),
    "X-API-Wallet-Timestamp": timestamp,
    "X-API-Wallet-Nonce": nonce,
  };
}

export async function authenticatedFetch(
  baseUrl: string,
  path: string, // may include a query string
  options: { method?: string; body?: unknown; builderFeeBps?: number },
  privateKey: Uint8Array,
  publicKeyHex: string
): Promise<Response> {
  const url = new URL(path, baseUrl);
  const method = (options.method ?? "GET").toUpperCase();
  const bodyStr = options.body === undefined ? undefined : JSON.stringify(options.body);

  // Sign exactly what fetch sends: url.search is "" or "?<raw query>"
  const headers = signRequest(method, url.pathname + url.search, bodyStr, privateKey, publicKeyHex);
  if (bodyStr !== undefined) headers["Content-Type"] = "application/json";
  if (options.builderFeeBps !== undefined) headers["X-Builder-Fee-Bps"] = String(options.builderFeeBps);

  return fetch(url, { method, headers, body: bodyStr });
}
```

## Handling 401s

Not every `401` means the key is gone. Endpoints also return `401` for app-level reasons (e.g. `wallet signature verification failed` on withdraw confirm, `authentication required or provide vault_id, account_id, or blockchain_address` on reads), and clock skew or nonce reuse are fixed by re-syncing and re-signing. `403 request IP is not allowed for this API key` means the key works but not from this IP.

Treat the key as invalid only for `authentication failed` (after ruling out clock/signing bugs) or `wallet expired or revoked` — e.g. the user re-connected with your builder code (which revokes the previous key), deleted the key in the Strike app, or revoked your builder under connected apps (`POST /v2/builder/revoke`, JWT-only: deactivates every key of your code on that account and sets the approval to 0 bps). Then discard the stored key and run builder connect again with a new keypair; a new connect sets the approval again.

```typescript
async function isKeyInvalid(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const { error } = await res.clone().json().catch(() => ({ error: "" }));
  return error === "authentication failed" || error === "wallet expired or revoked";
}
```
