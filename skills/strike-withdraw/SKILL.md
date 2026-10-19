---
name: strike-withdraw
description: Strike Finance withdrawal flow with an API wallet — estimate, quote (message the user's wallet must sign), confirm with the wallet signature, per-chain signing formats, Relay-routed assets, withdrawal limits and queue position. Use when implementing withdrawal functionality.
---

# Strike Finance Withdrawal Flow

1. (Optional) `POST /v2/withdraw/estimate` — side-effect-free "you will receive" preview
2. `POST /v2/withdraw/quote` — returns `withdraw_id` and `message_to_sign`
3. The **user's own chain wallet** signs `message_to_sign` (Cardano: also signs a small funding tx)
4. `POST /v2/withdraw` — submit the signature; the withdrawal is queued for payout

An API wallet alone can never withdraw: every API-wallet quote must be confirmed with a signature from the account's wallet. Passkey / authenticator-app (TOTP) authorization only applies to Strike-app email sessions; quotes they create cannot be confirmed with an API wallet (`403 {"error":"this withdrawal requires passkey authorization"}`).

**Access:** trading routes (API wallet or JWT, see strike-auth); quote, estimate and confirm reject sub-account-bound API wallets (`403 {"error":"not available to sub-account API keys"}`) and return `503 {"error":"service unavailable"}` while the API is starting.

## Destination, Route and Fee

With an API wallet, `blockchain` is both the destination chain and the chain of the wallet that signs, so it must be a chain the account has a wallet on (`ethereum`, `solana` or `cardano`). Other destinations (e.g. `base`) return `403 access denied`. By default funds go to that account wallet.

| `blockchain` | `asset` | `route` | Paid from |
|--------------|---------|---------|-----------|
| `cardano` | `USDM` | `direct_cardano_usdm` | Cardano vault |
| `cardano` | other configured asset (e.g. `ADA`, `USDCx`, `iUSD`) | `direct_cardano` | Cardano vault |
| `ethereum` | `USDC` | `direct_ethereum_usdc` | Ethereum vault |
| `solana` | `USDC` | `direct_solana_usdc` | Solana vault |
| `ethereum` | anything else (e.g. `ETH`, `USDT`, `WBTC`) | `relay_from_ethereum_usdc` | Ethereum USDC swapped via Relay |
| `solana` | anything else (e.g. `SOL`, `USDT`) | `relay_from_solana_usdc` | Solana USDC swapped via Relay |

- Fee: **$1** per withdrawal (`$0` with `source: "staking_reward"`), deducted from `usd_value` before conversion. Relay routes additionally carry Relay's swap/network cost in the received amount (`estimated_receive`, `minimum_receive`).
- Minimum: `usd_value` rounded to whole dollars must be `>= min_withdraw_usd` (`GET /v2/portfolio`, default 5).
- Maximum: `maxWithdrawAmount` from `GET /v2/balances`, checked at quote and again at confirm.

## Step 1 (optional): Estimate

```
POST /v2/withdraw/estimate
```

```json
{ "usd_value": "100", "blockchain": "ethereum", "asset": "USDT" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `usd_value` | string | Yes | USD amount |
| `blockchain` | string | Yes | Destination chain |
| `asset` | string | No | Destination asset (see table) |
| `source` | string | No | `balance` (default) \| `staking_reward` |
| `recipient_address` | string | No | Priced when present |

**Response:**

```json
{
  "route": "relay_from_ethereum_usdc",
  "is_relay": true,
  "source_blockchain": "ethereum",
  "source_asset": "USDC",
  "source_amount": "99000000",
  "source_asset_decimals": 6,
  "destination_blockchain": "ethereum",
  "destination_asset": "USDT",
  "destination_asset_decimals": 6,
  "estimated_receive": "98712345",
  "estimated_receive_usd": "98.71",
  "minimum_receive": "98218783",
  "withdraw_fee_usd": "1",
  "network_cost_usd": "0.27",
  "price_impact_percent": "0.02",
  "slippage_bps": 50,
  "eta_seconds": 30,
  "as_of": 1792438549,
  "ttl_seconds": 20
}
```

Amounts are base-unit strings (use the `*_decimals` fields); `as_of` is Unix seconds. Errors are `{"error": "...", "code": "..."}` (plus `minimum_usd` for `below_minimum`) and never 404/501. Limited per account (default 60/min): `429 {"error":"withdraw estimate rate limit exceeded (60 requests per minute)","code":"rate_limited"}`.

## Step 2: Get Quote

```
POST /v2/withdraw/quote
```

```json
{ "usd_value": "100", "blockchain": "solana", "asset": "USDC" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `usd_value` | string | Yes (balance mode) | USD amount to debit, decimal string |
| `blockchain` | string | Yes | Destination chain (case-insensitive) |
| `asset` | string | Yes (balance mode) | Destination asset (see route table) |
| `source` | string | No | `balance` (default) \| `staking_reward` (staking-reward bucket, balance mode only, no fee) |
| `wallet_address` | string | No | Which of the account's wallets on `blockchain` signs (required if it has more than one there) |
| `recipient_address` | string | No | Pay to this address instead of the account wallet. It is validated for the chain (Cardano: same network) and shown in the signed message |
| `mode` | string | No | `balance` (default) \| `collateral` |
| `asset_symbol`, `asset_amount` | string | Collateral mode | Raw credit-collateral asset and integer smallest-unit amount (Cardano collateral withdrawals also need `wallet_address`) |

**Response:**

```json
{
  "withdraw_id": "3b0f6f0e-1f7c-4c55-8d0e-6b2f7f9a4e21",
  "fee": "1",
  "message_to_sign": "Authorize withdrawal from Strike Perpetuals.\n\nWallet: 7xKX...\nChain: solana\nAmount: 100 USD\nFee: 1 USD\nTimestamp: 2026-10-20 12:00:00 UTC\nWithdraw ID: 3b0f6f0e-1f7c-4c55-8d0e-6b2f7f9a4e21",
  "route": "direct_solana_usdc",
  "source_blockchain": "solana",
  "source_asset": "USDC",
  "source_amount": "99000000",
  "destination_asset": "USDC"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `withdraw_id` | string | Use in confirm (and as `withdrawal_id` for queue position) |
| `fee` | string | Fee in USD |
| `message_to_sign` | string | Exact message the account wallet must sign |
| `tx_cbor` | string | Cardano only: unsigned funding tx the wallet must sign (see below) |
| `validator_address` | string | Cardano only: validator chosen for the funding tx |
| `route`, `source_blockchain`, `source_asset`, `source_amount`, `destination_asset` | string | Route details; `source_amount` in source base units |
| `estimated_receive`, `minimum_receive` | string | Relay routes: destination amount in base units |
| `auth_mode` | string | Only for Strike-app email sessions |

The quote has no expiry field: it is valid for the quote TTL (default **15 min**) from the timestamp in the message, and the signature must arrive within that window.

### `message_to_sign` format

```
Authorize withdrawal from Strike Perpetuals.

Wallet: {signing wallet address}
Chain: {signing wallet chain}
Amount: {usd_value} USD
Fee: {fee} USD
Timestamp: {YYYY-MM-DD HH:MM:SS} UTC
Withdraw ID: {withdraw_id}
```

Relay routes, and any quote with `recipient_address`, append:

```
Route: {route}
Source: {source_blockchain} {source_asset}
Destination: {blockchain} {destination_asset}
Recipient: {recipient address}
```

When the signing wallet is on **Cardano**, `message_to_sign` is already the **hex encoding** of that text.

**Quote errors** carry `code` when raised by quote generation: `amount_invalid`, `below_minimum` (+ `minimum_usd`), `unsupported_blockchain`, `unsupported_asset`, `recipient_invalid`, `insufficient_balance`, `insufficient_protocol_liquidity`, `rate_limited`, `route_unavailable`, `account_not_found`, `access_denied`, `source_invalid`, `insufficient_wallet_funds`, `internal_error`. Before that, the handler returns plain `400 invalid amount`, `400 invalid withdrawal source`, `400 withdrawal amount exceeds available balance`, `400 withdrawal amount exceeds staking reward balance`.

## Step 3: Sign with the User's Wallet

| Signing wallet | Sign | `wallet_signature` |
|----------------|------|--------------------|
| Ethereum | EIP-191 `personal_sign(message_to_sign)` | Hex, with or without `0x` (ERC-1271 smart wallets are checked on-chain where enabled) |
| Solana | `signMessage(utf8Bytes(message_to_sign))` | Base58 signature |
| Cardano | CIP-30 `signData(walletAddress, message_to_sign)` — pass the hex as-is, do **not** hex-encode again; `walletAddress` must be the exact address on the `Wallet:` line | `JSON.stringify({ signature, key })` or `"{signatureHex}:{keyHex}"` |

**Cardano funding tx:** when the quote has `tx_cbor`, the user's Cardano wallet also pays about 2 ADA plus network fee toward the payout. Sign `tx_cbor` with CIP-30 `signTx`, add the witness set to the transaction, and send the **full signed transaction CBOR hex** as `signed_tx_cbor` (do not submit it yourself; Strike submits it on confirm). Without enough ADA the quote fails with `400` `insufficient_wallet_funds`.

## Step 4: Confirm Withdrawal

```
POST /v2/withdraw
```

```json
{
  "withdraw_id": "3b0f6f0e-1f7c-4c55-8d0e-6b2f7f9a4e21",
  "wallet_signature": "base58-or-hex-signature",
  "signed_tx_cbor": "84a5... (Cardano quotes with tx_cbor only)"
}
```

**Response (201):**

```json
{
  "request_id": "3b0f6f0e-1f7c-4c55-8d0e-6b2f7f9a4e21",
  "status": "pending",
  "sequence_id": 184467,
  "message_id": "1792438551234-0"
}
```

`request_id` equals `withdraw_id`. The balance is debited by the engine and the payout is sent by the chain validators; rate-limited payouts wait in a queue (see queue position). Track completion via `GET /v2/history/transaction` (strike-history) or the user stream.

| Status | `error` | Meaning |
|--------|---------|---------|
| 400 | `wallet_signature is required` | |
| 401 | `wallet signature verification failed` | Bad signature, signature older than the quote TTL, **or unknown/expired `withdraw_id`** — not an API-key problem |
| 400 | `quote has already been used` | Already confirmed |
| 400 | `signed_tx_cbor is required` | Quote returned `tx_cbor` |
| 400 | `deposit quote has expired` | Quote expired (message text is shared with deposits) |
| 400 | `withdrawal amount exceeds available balance` | Balance dropped since the quote |
| 403 | `access denied` | Quote belongs to another account |
| 403 | `withdrawals are on hold after account recovery` | |

## Withdrawal Limits

```
GET /v2/withdraw/limits?chain=ethereum&asset=USDC
```

Auth required. `chain` (alias `blockchain`): `ethereum` \| `solana` \| `cardano`; `asset` (uppercased by the server). Missing → `400 chain is required` / `400 asset is required`.

```json
{
  "asset": "USDC",
  "blockchain": "ethereum",
  "as_of": 1792438549,
  "buckets": {
    "per_asset_1h":  { "window_seconds": 3600,  "limit": "250000", "used": "1200", "remaining": "248800", "current_used": "1200", "previous_used": "0", "window_start": 1792436400 },
    "per_asset_24h": { "window_seconds": 86400, "limit": "1000000", "used": "5400", "remaining": "994600", "current_used": "5400", "previous_used": "0", "window_start": 1792368000 },
    "global_1h":     { "window_seconds": 3600,  "limit": "500000", "used": "1200", "remaining": "498800", "current_used": "1200", "previous_used": "0", "window_start": 1792436400 },
    "global_24h":    { "window_seconds": 86400, "limit": "2000000", "used": "5400", "remaining": "1994600", "current_used": "5400", "previous_used": "0", "window_start": 1792368000 }
  },
  "queue": {
    "pending_count": 0,
    "pending_asset_count": 0,
    "pending_total_amount": "0",
    "pending_asset_total_amount": "0",
    "large_withdrawals_pending": 0,
    "estimated_drain_seconds": 0,
    "retry_slot_seconds": 0
  },
  "large_withdrawal": {
    "threshold": "100000",
    "queue_delay_seconds": 0,
    "estimated_total_delay_seconds": 0,
    "pending": {
      "count": 0, "asset_count": 0, "asset_total_amount": "0", "global_total_amount": "0",
      "executable_count": 0, "executable_asset_count": 0,
      "executable_asset_total_amount": "0", "executable_global_total_amount": "0"
    }
  }
}
```

Amounts are decimal strings in asset units (example values are illustrative); `as_of` and `window_start` are Unix seconds on Ethereum. Optional fields: top-level `as_of_basis`; bucket `usage[]` (`timestamp`, `timestamp_ms`, `amount`, `raw_amount`, `asset_ix`); queue `estimated_asset_drain_seconds`, `estimate_method`, `retry_delay_seconds`, `retry_buffer_seconds`, `retry_poll_seconds`, `retry_requeue_batch_size`, `settlement_slot_seconds`, `confirmation_buffer_seconds`; `pending_withdrawals[]` (`queue_index`, `asset`, `amount`, `raw_amount`, `policy_id`, `asset_name_hex`, `retry_at`, `estimated_at`, `wait_seconds`, `matches_asset`); large-withdrawal `worker_poll_seconds`, `settlement_slot_seconds`, `confirmation_buffer_seconds`, `pending.next_executable_at`.

## Queue Position

```
GET /v2/withdraw/queue-position?withdrawal_id=<withdraw_id>&chain=ethereum
```

Auth required. `withdrawal_id` (alias `withdraw_id`) and `chain` (alias `blockchain`) are required. Supported on `ethereum` and `cardano`; `solana` → `501 withdrawal queue position not implemented for this blockchain`. A withdrawal found in the queue or transaction records but owned by another account → `404 withdrawal not found`. An id that is not queued and has no transaction record (including unknown ids) returns `200` with `{"withdrawal_id": "<id>", "queued": false, "status": "not_deferred", "queue_status": "not_deferred", "blockchain": "<chain>", "wait_seconds": 0}`.

```json
{
  "withdrawal_id": "3b0f6f0e-1f7c-4c55-8d0e-6b2f7f9a4e21",
  "queued": true,
  "status": "deferred",
  "queue_status": "deferred",
  "blockchain": "ethereum",
  "wait_seconds": 1200,
  "estimated_at": 1792439749
}
```

| Field | Type | Notes |
|-------|------|-------|
| `queued` | boolean | Waiting in the rate-limit / large-withdrawal queue |
| `status` | string | Ethereum: `not_deferred`, `deferred`, `large_withdrawal_queued`, `impossible`. When not queued and a transaction record exists, replaced by the transaction status |
| `queue_status` | string | Queue state (defaults to `status`) |
| `transaction_status` | string | Set when `status` was taken from the transaction record |
| `wait_seconds` | number | Estimated wait |
| `estimated_at`, `retry_at` | number | Optional Unix timestamps (seconds on Ethereum) |
| `retry_reason` | string | Optional human-readable reason |
| `queue_tx_hash` | string | Optional |

## TypeScript Example

```typescript
import { authenticatedFetch } from "./auth";
import bs58 from "bs58";

const BASE_URL = "https://api.strikefinance.org";

async function post(path: string, body: object, privateKey: Uint8Array, publicKeyHex: string) {
  const res = await authenticatedFetch(BASE_URL, path, { method: "POST", body }, privateKey, publicKeyHex);
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.code ?? ""} ${json.error}`);
  return json;
}

type WalletSigner = (quote: { message_to_sign: string; tx_cbor?: string }) =>
  Promise<{ wallet_signature: string; signed_tx_cbor?: string }>;

async function withdraw(
  blockchain: "ethereum" | "solana" | "cardano",
  usdValue: string,
  asset: string,
  sign: WalletSigner,
  privateKey: Uint8Array,
  publicKeyHex: string
) {
  const quote = await post("/v2/withdraw/quote", { usd_value: usdValue, blockchain, asset }, privateKey, publicKeyHex);
  const signed = await sign(quote);
  return post("/v2/withdraw", { withdraw_id: quote.withdraw_id, ...signed }, privateKey, publicKeyHex);
}

// Ethereum (EIP-1193)
const signEth = (address: string): WalletSigner => async ({ message_to_sign }) => ({
  wallet_signature: await (window as any).ethereum.request({ method: "personal_sign", params: [message_to_sign, address] }),
});

// Solana (wallet adapter)
const signSol = (wallet: { signMessage(m: Uint8Array): Promise<Uint8Array> }): WalletSigner =>
  async ({ message_to_sign }) => ({
    wallet_signature: bs58.encode(await wallet.signMessage(new TextEncoder().encode(message_to_sign))),
  });

// Cardano (CIP-30). message_to_sign is already hex. addWitnesses() is your helper that merges the
// witness set returned by signTx into tx_cbor (Lucid / cardano-serialization-lib) and returns full tx CBOR hex.
const signAda = (api: any, walletAddress: string, addWitnesses: (tx: string, ws: string) => string): WalletSigner =>
  async ({ message_to_sign, tx_cbor }) => {
    const { signature, key } = await api.signData(walletAddress, message_to_sign);
    const out: { wallet_signature: string; signed_tx_cbor?: string } = {
      wallet_signature: JSON.stringify({ signature, key }),
    };
    if (tx_cbor) out.signed_tx_cbor = addWitnesses(tx_cbor, await api.signTx(tx_cbor, true));
    return out;
  };

// await withdraw("solana", "100", "USDC", signSol(wallet), privateKey, publicKeyHex);
```
