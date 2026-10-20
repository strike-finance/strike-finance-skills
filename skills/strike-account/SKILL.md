---
name: strike-account
description: Strike Finance account and exchange config reads — account info, balances, portfolio, sub-account list, plus public markets, fee tiers, server time and ping. Use when building account setup, balance displays, or loading market configuration.
---

# Strike Finance Account & Exchange Config

All paths are on the API host (`https://api.strikefinance.org`, testnet `https://api-v2-testnet.strikefinance.org`). Authenticated examples use `authenticatedFetch` from strike-auth. Every decimal value is a JSON **string** unless noted.

Accounts are created by builder connect (strike-auth). Creating accounts (`POST /v2/account`) and editing profiles (`POST /v2/account/profile`) are JWT-only (Strike app).

## Public Endpoints

### GET /v2/ping

Connectivity check. Response: `{}`.

### GET /v2/time

```json
{ "serverTime": 1792438549384 }
```

`serverTime` is Unix **milliseconds**. Use it to derive the API-wallet `X-API-Wallet-Timestamp` (seconds).

### GET /v2/markets

All market configurations, keyed by symbol.

```json
{
  "markets": {
    "BTC-USD": {
      "symbol": "BTC-USD",
      "name": "Bitcoin / USD",
      "base_asset": "BTC",
      "status": "trading",
      "created_at": 0,
      "base_prec": 8,
      "quote_prec": 8,
      "default_leverage": 20,
      "margin_tiers": [
        { "max_notional": "300000", "max_leverage": 150, "maintenance_margin_rate": "0.004", "maintenance_amount": "0" }
      ],
      "reduce_only": false,
      "order_tick_price": "0.10",
      "order_min_price": "10",
      "order_max_price": "100000",
      "order_limit_price_bound": "0.05",
      "order_market_price_bound": "0.05",
      "order_limit_step_size": "0.00001",
      "order_limit_min_size": "0.00001",
      "order_limit_max_size": "1000",
      "order_market_step_size": "0.00001",
      "order_market_min_size": "0.00001",
      "order_market_max_size": "120",
      "order_min_notional": "100",
      "liquidation_fee_rate": "0.0125",
      "liquidation_fee_retention_factor": "0",
      "trigger_protect": "0.05",
      "mark_price": "81649.00853590",
      "index_price": "81912.66907232",
      "last_price": "77117.60",
      "bid1_price": "77117.60",
      "bid1_size": "0.0099",
      "ask1_price": "80000",
      "ask1_size": "0.1",
      "funding_rate": "0.0000125",
      "next_funding_time": 1792440000000,
      "impact_notional": "2500"
    }
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `symbol`, `name`, `base_asset` | string | Quote asset is always USD |
| `status` | string | `pre_trading` (no orders/cancels) \| `trading` \| `break` (cancels only) \| `close` (delisted) |
| `created_at` | number | Unix ms when listed (`0` if unset) |
| `base_prec`, `quote_prec` | number | Rounding precision for sizes / prices, notional, margin, fees |
| `default_leverage` | number | Default leverage for new positions |
| `margin_tiers[]` | array | `max_notional` (string), `max_leverage` (number), `maintenance_margin_rate` (string), `maintenance_amount` (string) |
| `reduce_only` | boolean | Only position-reducing orders allowed |
| `order_tick_price`, `order_min_price`, `order_max_price` | string | Limit-style prices must be `>= order_min_price`, on the tick grid `order_min_price + k × order_tick_price`, and `<= order_max_price` (max `0` = no maximum) |
| `order_limit_price_bound`, `order_market_price_bound` | string | Max deviation ratio from mark price |
| `order_market_min_size` | string | Minimum size for **every** order type (only `close_position` orders skip it) |
| `order_limit_step_size`, `order_limit_min_size` | string | Limit-style sizes must sit on the grid `order_limit_min_size + k × order_limit_step_size` (`order_limit_min_size` is the grid origin, not a separate minimum) |
| `order_market_step_size` | string | Step grid for market-style sizes (origin `order_market_min_size`) |
| `order_limit_max_size`, `order_market_max_size` | string | Max size for limit-style / market-style orders. `0` is **not** "unlimited": every order exceeds it and is rejected |
| `order_min_notional` | string | Min order notional (not applied to reduce-only/close) |
| `liquidation_fee_rate`, `liquidation_fee_retention_factor`, `trigger_protect` | string | |
| `mark_price`, `index_price`, `last_price` | string | Latest prices |
| `bid1_price`, `bid1_size`, `ask1_price`, `ask1_size` | string | Top of book |
| `funding_rate` | string | Current (real-time) funding rate |
| `next_funding_time` | number | Unix ms |
| `impact_notional` | string | Derived from the first margin tier |

### GET /v2/markets/:symbol

One market object (same shape as a `markets` entry). Unknown symbol → `400 {"error":"invalid symbol"}`.

`GET /v2/markets/:symbol/fundamentals?quarterly_limit=8&annual_limit=5` serves cached financial statements for markets that have them (`quarterly_limit` 4–20, default 8; `annual_limit` 1–10, default 5; `404` when unavailable).

### GET /v2/account/by-nickname

`?nickname=<nickname>` → `{ "account_id": "...", "nickname": "..." }`. Unknown nickname → `404 {"error":"user not found"}`; invalid/missing → `400 {"error":"invalid nickname"}`.

### GET /v2/fee-tiers

```json
{
  "feeTiers": [
    { "Tier": 0, "MinVolume": 0, "TakerRate": 0.0005, "MakerRate": 0 },
    { "Tier": 1, "MinVolume": 100000, "TakerRate": 0.00045, "MakerRate": 0 }
  ],
  "makerRebateTiers": [
    { "tier": 1, "minMakerVolumeShare": 0.05, "makerRate": -0.00001 }
  ],
  "stakingFeeDiscountTiers": null,
  "referralTiers": [
    { "tier": 0, "name": "bronze", "min_referred_volume": 0, "reward_rate": 0.2, "referee_discount_rate": 0.04 }
  ]
}
```

All values here are JSON **numbers**. Note the PascalCase keys in `feeTiers` (`MinVolume` = 30-day USD volume; rates are fractions, `0.0005` = 0.05%). `makerRebateTiers[].makerRate` is negative (rebate). `stakingFeeDiscountTiers[]` items are `{ tier, minStakedStrike, discountRate }` (may be `null`). `referralTiers` is omitted when not configured.

## Selecting the Account (read endpoints)

`/v2/account`, `/v2/balances` and `/v2/portfolio` accept FlexibleAuth (strike-auth) and resolve the account in this order:

| Query param | Auth | Notes |
|-------------|------|-------|
| `account_id` | none | Must be a UUID (otherwise `400 invalid account_id`; use `vault_id` for vaults) |
| `vault_id` | none | Vault's trading account (see strike-vaults) |
| `blockchain` + `blockchain_address` | none | Exact chain lookup |
| `blockchain_address` | none | Chain inferred from the address (max 512 chars) |
| `sub_account_id` | required | Caller's own active sub-account |
| *(none)* | required | The authenticated account (an API wallet bound to a sub-account resolves to that sub-account) |

Without auth and without a public selector: `401 {"error":"authentication required or provide vault_id, account_id, or blockchain_address"}`. Unknown address: `404 {"error":"user not found"}`.

`scope=all` (on `/v2/account` and `/v2/portfolio`) sums a master account and its active sub-accounts — seeded from the caller, or from a public `account_id` / `blockchain_address`. It cannot be combined with `vault_id` or `sub_account_id` (400), any other `scope` value is 400, and a sub-account-bound API wallet gets `403` for its private family read. Aggregate responses add `accounts: [{ "account_id", "name", "kind": "master" | "sub" }]`.

## GET /v2/account

```json
{
  "account_id": "01a144dc-27e4-706c-ac46-9c2c1e77d60b",
  "blockchain": "cardano",
  "blockchain_address": "addr_test1vpsme84q0mk7jmgdcf5ugww3c7604xyyjz87ddrsem9jfcgnngu90",
  "wallet_balance": "128.3014085250277336",
  "available_balance": "128.3014085250277336",
  "copy_reserved_balance": "0",
  "copy_deployed_margin": "0",
  "copy_profit_share_reserved": "0",
  "unrealized_pnl": "0",
  "margin_balance": "128.3014085250277336",
  "total_margin": "0",
  "position_initial_margin": "0",
  "maintenance_margin": "0",
  "sub_accounts": [],
  "default_margin_mode": "cross",
  "default_leverage": 10,
  "symbol_settings": {
    "BTC-USD": { "margin_mode": "cross", "leverage": 100, "allow_pre_trade": false }
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `account_id` | string | |
| `name` | string | Sub-accounts only |
| `parent_account_id`, `parent_blockchain_address` | string | Sub-accounts only |
| `blockchain` | string | `ethereum` \| `solana` \| `cardano`; `""` for sub-accounts and vaults |
| `blockchain_address` | string \| null | `null` for sub-accounts, `""` for vaults |
| `nickname`, `avatar_url` | string | Omitted when empty |
| `wallet_balance` | string | Wallet balance (USD) |
| `available_balance` | string | Available for new orders: wallet − open-order margin − isolated balances − cross initial margin + cross unrealized PnL, minus copy-trading holds (can be negative) |
| `copy_reserved_balance`, `copy_deployed_margin`, `copy_profit_share_reserved` | string | Copy-trading holds |
| `unrealized_pnl` | string | Sum over all positions (cross and isolated) |
| `margin_balance` | string | Cross margin balance: wallet − Σ isolated balances + Σ cross unrealized PnL |
| `total_margin` | string | Legacy: `position_initial_margin + maintenance_margin` |
| `position_initial_margin` | string | Σ position initial margin (mark notional / leverage) |
| `maintenance_margin` | string | Σ position maintenance margin |
| `sub_accounts` | array | Active sub-accounts of the master: `{ "account_id", "name" }` (siblings when reading a sub-account) |
| `default_margin_mode` | string | `cross` \| `isolated` |
| `default_leverage` | number | |
| `symbol_settings` | object | Symbol → `{ margin_mode, leverage, allow_pre_trade }`; omitted when empty |

Vault reads (`vault_id`) also include `inventory_costs_usd`, `custody_balances`, `conversion_reserved_usd` and `slp_adl`.

## GET /v2/balances

Returns an **array** with one USD-margin entry.

```json
[
  {
    "asset": "USDT",
    "walletBalance": "128.3014085250277336",
    "unrealizedPnl": "0",
    "marginBalance": "128.3014085250277336",
    "maintMargin": "0",
    "initialMargin": "0",
    "positionInitialMargin": "0",
    "openOrderInitialMargin": "0",
    "crossWalletBalance": "128.3014085250277336",
    "crossUnPnl": "0",
    "availableBalance": "128.3014085250277336",
    "maxWithdrawAmount": "128.3014085250277336",
    "marginAvailable": true,
    "updateTime": 1792438700161,
    "lockedRewards": "0",
    "maxWithdrawAfterRewards": "128.3014085250277336",
    "stakingRewardBalance": "0"
  }
]
```

| Field | Type | Notes |
|-------|------|-------|
| `asset` | string | Always `"USDT"` (label only; balances are USD) |
| `walletBalance` | string | Same as `wallet_balance` |
| `unrealizedPnl` | string | Same as `unrealized_pnl` |
| `marginBalance` | string | Same as `margin_balance` (cross) |
| `maintMargin` | string | Σ position maintenance margin |
| `initialMargin` | string | Legacy `positionInitialMargin + maintMargin` (same as `total_margin`) |
| `positionInitialMargin` | string | |
| `openOrderInitialMargin` | string | Always `"0"` (open-order margin is already deducted from `availableBalance`) |
| `crossWalletBalance`, `crossUnPnl` | string | Equal to `walletBalance` / `unrealizedPnl` (isolated amounts are not separated) |
| `availableBalance` | string | Same as `available_balance` (copy-trading holds already subtracted) |
| `maxWithdrawAmount` | string | Engine withdrawal cap — the largest `usd_value` `POST /v2/withdraw/quote` accepts: max(0, wallet − open-order margin − isolated balances − max(cross IM − cross uPnL, cross MM)), capped at wallet − `lockedRewards`, minus copy-trading holds |
| `marginAvailable` | boolean | Always `true` |
| `updateTime` | number | Unix ms (response time) |
| `lockedRewards` | string | Locked reward credit that must stay on the account |
| `maxWithdrawAfterRewards` | string | Same as `maxWithdrawAmount` |
| `stakingRewardBalance` | string | Separate staking-reward bucket (display only; withdraw with `source: "staking_reward"`) |

## GET /v2/portfolio

```json
{
  "account": { "realized_pnl": "0", "all_time_volume": "115199.6", "all_time_maker_rebates": "0", "all_time_funding_fees": "0" },
  "perp_account": { "realized_pnl": "0", "all_time_volume": "115199.6", "all_time_maker_rebates": "0", "all_time_funding_fees": "0" },
  "capital_flows": {
    "all_time_deposits": "536.298784",
    "all_time_withdrawals": "40",
    "all_time_vault_deposits": "201",
    "all_time_vault_withdrawals": "100.0026245250277336",
    "all_time_credit_vault_deposits": "0",
    "all_time_credit_vault_withdrawals": "0",
    "all_time_transfer_in": "0",
    "all_time_transfer_out": "267",
    "all_time_reward_grants": "0"
  },
  "sub_accounts": [],
  "volume": "115199.6",
  "fees": "0",
  "all_time_maker_rebates": "0",
  "all_time_funding_fees": "0",
  "fee_tier_volume_30d": "115199.6",
  "fee_tier_maker_volume_30d": "115199.6",
  "fee_tier_taker_volume_30d": "0",
  "history_perp_only": [[1792155600000, "0", "0", "0", "0"]],
  "history_vault": [[1792155600000, "0", "0"]],
  "fee_tier": 1,
  "fee_tiers": [{ "Tier": 0, "MinVolume": 0, "TakerRate": 0.0005, "MakerRate": 0 }],
  "maker_rebate_tiers": [{ "tier": 1, "minMakerVolumeShare": 0.05, "makerRate": -0.00001 }],
  "staking_fee_discount_tiers": null,
  "maker_fee_rate_override": null,
  "staking_fee_discount_staked_strike": "0",
  "staking_fee_discount_rate": "0",
  "staking_reward_balance": "0",
  "volume_history": [
    { "date": "2026-10-18", "exchange_volume": "0", "weighted_maker_volume": "0", "weighted_taker_volume": "0" }
  ],
  "fee_discount_rate": 0,
  "is_trading_enabled": true,
  "min_deposit_usd": 5,
  "min_withdraw_usd": 5
}
```

| Field | Type | Notes |
|-------|------|-------|
| `account`, `perp_account` | object | Identical: `realized_pnl`, `all_time_volume`, `all_time_maker_rebates`, `all_time_funding_fees` (funding: + received, − paid) |
| `capital_flows` | object | All-time deposit/withdraw/vault/credit/transfer/reward-grant totals (strings) |
| `sub_accounts[]` | array | `{ account_id, parent_account_id, name, archived }` |
| `volume` | string | All-time volume |
| `fees` | string | All-time trading fees + all-time funding fees |
| `fee_tier_volume_30d`, `fee_tier_maker_volume_30d`, `fee_tier_taker_volume_30d` | string | 30-day volume pooled across master + sub-accounts |
| `history_perp_only` | array | `[timestampMs, accountValue, realizedPnl, unrealizedPnl, volume]` — hourly for the last 30 days, daily before |
| `history_vault` | array | `[timestampMs, vault_value, vault_total_pnl]` |
| `fee_tier` | number | Current tier |
| `fee_tiers`, `maker_rebate_tiers`, `staking_fee_discount_tiers` | array | Same shapes as `GET /v2/fee-tiers` |
| `maker_fee_rate_override` | string \| null | Account maker fee override (negative = rebate) |
| `staking_fee_discount_staked_strike`, `staking_reward_balance` | string | |
| `staking_fee_discount_rate` | string | Fractional discount on positive fee rates |
| `volume_history[]` | array | Last 30 days, newest first: `date` (`YYYY-MM-DD`), `exchange_volume` (exchange-wide total volume that day; `"0"` when unavailable), `weighted_maker_volume`, `weighted_taker_volume` |
| `fee_discount_rate` | number | Referral discount percent (`4` = 4%), `0` if none |
| `is_trading_enabled` | boolean | Always `true` for API wallets |
| `min_deposit_usd`, `min_withdraw_usd` | number | Effective deposit / withdrawal minimums (whole USD) |
| `accounts` | array | `scope=all` only |

## Margin Settings

`GET /v2/symbols` (default margin mode/leverage and per-symbol settings) and `PUT /v2/symbols` are documented in strike-trading.

## GET /v2/sub-accounts

Sub-accounts of the authenticated account (**auth required**; a sub-account-bound key gets an empty list).

```json
{
  "sub_accounts": [
    {
      "account_id": "0192...",
      "parent_account_id": "01a1...",
      "name": "Bot 1",
      "status": "active",
      "archived": false,
      "equity": "250.5",
      "available_balance": "200",
      "unrealized_pnl": "1.2",
      "total_pnl": "3.4",
      "margin_used_pct": "12.5"
    }
  ],
  "max_sub_accounts": 20,
  "sub_account_count": 1
}
```

`status` is `pending` or `active`. `margin_used_pct` is position initial margin / equity as a percent (0–100). `sub_account_count` counts non-archived pending/active rows. Creating, renaming, archiving, deleting and funding sub-accounts are JWT-only (Strike app). To act on a sub-account with a master API wallet, pass `sub_account_id` (see strike-auth).

## Related

- Positions (`GET /v2/positions`, `/v2/closedPositions`, `/v2/history/position`): strike-history.
- Withdrawal limits and queue position (`GET /v2/withdraw/limits`, `GET /v2/withdraw/queue-position`): strike-withdraw.
- Exact schemas: `openapi/user-api.yaml` (`/v2/account`, `/v2/balances`, `/v2/portfolio`).
- `GET /v2/pending-quotes` and `GET /v2/transaction/status` are JWT-only; track deposits/withdrawals via `GET /v2/history/transaction` (strike-history) or the user stream.

## Example

```typescript
import { authenticatedFetch } from "./auth";

const BASE_URL = "https://api.strikefinance.org";

async function loadAccount(privateKey: Uint8Array, publicKeyHex: string) {
  const [account, balances, markets] = await Promise.all([
    authenticatedFetch(BASE_URL, "/v2/account", {}, privateKey, publicKeyHex).then((r) => r.json()),
    authenticatedFetch(BASE_URL, "/v2/balances", {}, privateKey, publicKeyHex).then((r) => r.json()),
    fetch(`${BASE_URL}/v2/markets`).then((r) => r.json()),
  ]);
  const usd = balances[0];
  return {
    accountId: account.account_id as string,
    available: usd.availableBalance as string,
    maxWithdraw: usd.maxWithdrawAmount as string,
    markets: markets.markets as Record<string, { status: string; order_tick_price: string }>,
  };
}

// Public read of someone else's balances (no auth headers at all)
const res = await fetch(`${BASE_URL}/v2/balances?account_id=01a144dc-27e4-706c-ac46-9c2c1e77d60b`);
```
