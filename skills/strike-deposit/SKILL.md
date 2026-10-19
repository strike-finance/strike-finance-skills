---
name: strike-deposit
description: Strike Finance deposit flow with an API wallet — quote, build the unsigned on-chain transaction (Ethereum, Solana, Cardano), user signs and submits, then confirm with the tx hash. Use when implementing deposit functionality.
---

# Strike Finance Deposit Flow

Deposits are three authenticated calls around one user-signed on-chain transaction:

1. `POST /v2/deposit/quote` — price the deposit, get a `request_id`
2. `POST /v2/deposit/build-tx` — get the unsigned transaction for the user's wallet
3. User signs and submits it on-chain, then `POST /v2/deposit` with the tx hash

The API wallet never moves funds itself: the user's own wallet signs the deposit transaction.

**Access:** trading routes (API wallet or JWT, see strike-auth); all three reject sub-account-bound API wallets (`403 {"error":"not available to sub-account API keys"}`) — deposit to the master and fund sub-accounts in the Strike app. They return `503 {"error":"service unavailable"}` while the API is starting.

**Chains:** `ethereum`, `solana`, `cardano`. The depositing wallet (`user_address`) must be one of the account's wallets on that chain. Supported assets are per-deployment configuration; e.g. `USDC` on Ethereum and Solana, `SOL` on Solana, and `ADA`, `USDM`, `USDCx`, `iUSD` on Cardano. Unsupported → `400 {"error":"unsupported asset"}`. Asset symbols are case-sensitive on Ethereum and Solana.

## Step 1: Get Quote

```
POST /v2/deposit/quote
```

```json
{
  "blockchain": "solana",
  "asset_symbol": "USDC",
  "asset_amount": "25000000"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `blockchain` | string | Yes | `ethereum` \| `solana` \| `cardano` |
| `asset_symbol` | string | Yes | Asset to deposit |
| `asset_amount` | string | Yes | Amount in the asset's smallest unit (USDC 6 decimals: `"25000000"` = 25 USDC; SOL: lamports; ADA: lovelace) |
| `mode` | string | No | `balance` (default) or `collateral` (credit collateral custody assets, `asset_amount` must be an integer string; `AAVE_V3_aUSDC` always uses this mode) |

Minimum: `min_deposit_usd` from `GET /v2/portfolio` (default 1). Stablecoins are checked by token amount, other assets by USD value. Below it → `400 {"error":"amount below minimum"}`.

**Response:**

```json
{
  "request_id": "6f1c2a7e-4c1b-4c55-9a51-2d1c8e7f0a11",
  "quote": {
    "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
    "request_id": "6f1c2a7e-4c1b-4c55-9a51-2d1c8e7f0a11",
    "blockchain": "solana",
    "asset_symbol": "USDC",
    "asset_amount": "25000000",
    "usd_value": "24.9975",
    "exchange_rate": "0.9999",
    "confirmations": 150,
    "timestamp": 1792438549384,
    "expiration_at": 1792439149384
  },
  "signature": "hex-ed25519-quote-signature",
  "deposit_address": "StrikeVaultAddress",
  "confirmations_required": 150
}
```

| Field | Type | Description |
|-------|------|-------------|
| `request_id` | string | Use in the next two calls |
| `quote.usd_value` | string | USD that will be credited (`"0"` for collateral mode) |
| `quote.exchange_rate` | string | Asset → USD rate used |
| `quote.confirmations` | number | Same as `confirmations_required` |
| `quote.timestamp`, `quote.expiration_at` | number | Unix ms; build-tx and confirm must happen before `expiration_at` (default TTL 10 min) |
| `signature` | string | Strike's signature over the quote (informational) |
| `deposit_address` | string | Strike vault address on that chain |
| `confirmations_required` | number | On-chain confirmations before the deposit is credited |

Other errors: `400 blockchain not supported`, `400 invalid amount`, `404 account not found`, `503 market price unavailable`.

## Step 2: Build Transaction

```
POST /v2/deposit/build-tx
```

```json
{
  "request_id": "6f1c2a7e-4c1b-4c55-9a51-2d1c8e7f0a11",
  "user_address": "UserWalletAddress",
  "utxos": ["82825820..."]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `request_id` | string | Yes | From the quote |
| `user_address` | string | Yes | The account's wallet on the quote's chain (Cardano: any address with the same payment key) |
| `utxos` | string[] | Cardano only | CIP-30 `getUtxos()` result (hex-encoded) |

**Response:** `{ blockchain, unsigned_tx, format, expires_at?, approval_tx? }` — shape of `unsigned_tx` depends on the chain.

### Ethereum — `format: "evm_tx_params"`

```json
{
  "blockchain": "ethereum",
  "unsigned_tx": { "from": "0xUser", "to": "0xVault", "data": "0x...", "value": "0x0", "gas": "0x30d40" },
  "format": "evm_tx_params",
  "approval_tx": { "from": "0xUser", "to": "0xUSDC", "data": "0x095ea7b3...", "value": "0x0", "gas": "0xb5a4" }
}
```

`value` and `gas` are hex quantities, ready for `eth_sendTransaction`. `approval_tx` is present only when the ERC-20 allowance to the vault is too low: send it first and wait for it to be mined, then send `unsigned_tx`. Assets without a token contract are deposited natively with `value` set.

### Solana — `format: "solana_base64"`

```json
{
  "blockchain": "solana",
  "unsigned_tx": "AQAAAAAAAAAA...",
  "format": "solana_base64",
  "expires_at": 1792438610
}
```

A base64 serialized legacy transaction with the user as fee payer. `expires_at` is Unix **seconds** (~60 s, recent blockhash): sign and send right away, or call build-tx again.

### Cardano — `format: "cardano_cbor"`

```json
{
  "blockchain": "cardano",
  "unsigned_tx": "84a400...",
  "format": "cardano_cbor",
  "expires_at": 1792440349384
}
```

Unsigned transaction CBOR hex. `expires_at` is Unix **milliseconds** (tx validity, ~30 min). Sign with CIP-30 `signTx(unsigned_tx, true)`, add the returned witness set to the transaction (e.g. with Lucid or cardano-serialization-lib), then `submitTx`. For ADA deposits the transaction pays an exchanger address that Strike creates during build-tx; nothing else is needed from the client.

**Errors:** `404 deposit quote not found or expired`, `400 deposit quote has expired`, `403 access denied` (quote belongs to another account, or `user_address` is not one of the account's wallets on that chain), `500 failed to build transaction` (e.g. missing `utxos` on Cardano, gas estimation failure).

## Step 3: Confirm Deposit

After the transaction is submitted:

```
POST /v2/deposit
```

```json
{
  "request_id": "6f1c2a7e-4c1b-4c55-9a51-2d1c8e7f0a11",
  "tx_hash": "on-chain-transaction-hash"
}
```

Both fields required; `tx_hash` must be at least 10 characters (Ethereum tx hash, Solana signature, Cardano tx id).

**Response (200):**

```json
{
  "request_id": "6f1c2a7e-4c1b-4c55-9a51-2d1c8e7f0a11",
  "status": "pending",
  "tx_hash": "on-chain-transaction-hash",
  "message": "Deposit submission confirmed, awaiting blockchain confirmation"
}
```

The balance is credited once the chain listener sees `confirmations_required` confirmations. Track it with `GET /v2/history/transaction` (strike-history) or the user stream.

**Errors:** `404 deposit quote not found or expired`, `403 access denied`, `400 deposit quote has expired`, `409 {"error":"deposit already submitted","tx_hash":"<first hash>"}` (only the first confirm is recorded).

## Not for API Wallets

- `GET /v2/deposit/cardano/address` (permanent per-account Cardano deposit address) is JWT-only.
- `POST /v2/deposit/exchanger` needs a `bot_seed` the API never returns to clients; ADA exchanger jobs are already scheduled by build-tx.

## TypeScript Example

```typescript
import { authenticatedFetch } from "./auth";

const BASE_URL = "https://api.strikefinance.org";

type Chain = "ethereum" | "solana" | "cardano";

async function post(path: string, body: object, privateKey: Uint8Array, publicKeyHex: string) {
  const res = await authenticatedFetch(BASE_URL, path, { method: "POST", body }, privateKey, publicKeyHex);
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.error}`);
  return json;
}

async function deposit(
  blockchain: Chain,
  assetSymbol: string,
  assetAmount: string,           // smallest units
  userAddress: string,
  privateKey: Uint8Array,
  publicKeyHex: string,
  // Signs + submits build-tx output with the user's wallet, returns the tx hash
  signAndSubmit: (built: { unsigned_tx: unknown; approval_tx?: unknown; format: string }) => Promise<string>,
  cardanoUtxos?: string[]         // CIP-30 getUtxos() for Cardano
) {
  const quote = await post("/v2/deposit/quote",
    { blockchain, asset_symbol: assetSymbol, asset_amount: assetAmount }, privateKey, publicKeyHex);

  const built = await post("/v2/deposit/build-tx",
    { request_id: quote.request_id, user_address: userAddress, ...(cardanoUtxos ? { utxos: cardanoUtxos } : {}) },
    privateKey, publicKeyHex);

  const txHash = await signAndSubmit(built);

  return post("/v2/deposit", { request_id: quote.request_id, tx_hash: txHash }, privateKey, publicKeyHex);
}

// Ethereum (EIP-1193 provider)
async function evmSignAndSubmit(built: any): Promise<string> {
  const eth = (window as any).ethereum;
  if (built.approval_tx) {
    const approveHash = await eth.request({ method: "eth_sendTransaction", params: [built.approval_tx] });
    while (!(await eth.request({ method: "eth_getTransactionReceipt", params: [approveHash] }))) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return eth.request({ method: "eth_sendTransaction", params: [built.unsigned_tx] });
}

// Solana (@solana/web3.js + wallet adapter)
// const tx = Transaction.from(Buffer.from(built.unsigned_tx, "base64"));
// const signature = await wallet.sendTransaction(tx, connection); // tx_hash = signature
```
