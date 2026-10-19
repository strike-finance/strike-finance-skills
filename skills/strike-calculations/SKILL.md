---
name: strike-calculations
description: Strike Finance trading math exactly as the backend computes it -- margin tiers, notional, uPnL, initial/maintenance margin, cross/isolated margin profiles, liquidation and bankruptcy prices, available/withdrawable balance, open-order margin, margin ratio and liquidation levels, isolated margin limits, entry price and realized PnL, funding, trading/builder fees. Use when reproducing /v2/positions or /v2/balances values locally or building risk displays.
---

# Strike Finance Trading Calculations

Every formula here mirrors the backend code that produces the REST values (matching engine, risk engine, price service). Reproduce them with a decimal library, not floats.

## Conventions

- **Decimals**: all money/price/size values are JSON strings. The backend uses `govalues/decimal`: every operation result is rounded half-even to at most 19 significant digits, so unrounded values such as liquidation/bankruptcy prices are served with up to 19 digits.
- **Rounding**: "round" means **half-to-even** to the market's `quote_prec` (from `/v2/markets`). Exceptions are called out (ceil, floor, unrounded).
- **Signed size**: one-way positions. `size > 0` long, `size < 0` short; `dir = sign(size)`.
- **Mark price**: the engine rounds the incoming mark (half-even, `quote_prec`) before any risk math. REST recomputes derived values from the API's cached market (refreshed every 500 ms), so values can trail the engine slightly.
- **Funding is not in uPnL**: `accumulated_funding_fees` is a separate position field already settled into the wallet balance.

## Inputs and Where to Get Them

| Value | Source |
|-------|--------|
| `margin_tiers`, `quote_prec`, `mark_price`, `index_price`, `bid1_price`, `ask1_price`, `funding_rate`, `next_funding_time`, `liquidation_fee_rate`, `liquidation_fee_retention_factor`, `impact_notional` | `GET /v2/markets` (`{"markets": {"BTC-USD": {...}}}`) or `GET /v2/markets/:symbol` (public) |
| Live mark price | public price WS `markPrice` stream (see `strike-price-feeds`) |
| Positions: `size`, `entry_price`, `leverage`, `margin_mode`, `iso_balance` | `GET /v2/positions` |
| Wallet balance | `GET /v2/balances` -> `walletBalance` |
| Fee rates | `GET /v2/fee-tiers` (public), `GET /v2/portfolio` -> `fee_tier`, `maker_fee_rate_override`, `fee_discount_rate`, `staking_fee_discount_rate` |

`/price/v2/exchangeInfo` does **not** carry margin tiers.

## Margin Tiers

Tier object (from `/v2/markets`):

```json
{"max_notional": "300000", "max_leverage": 150, "maintenance_margin_rate": "0.004", "maintenance_amount": "0"}
```

- Strings except `max_leverage` (number). Tiers are sorted by `max_notional` ascending; `max_leverage` non-increasing; MMR non-decreasing, `0 < MMR < 1`.
- `maintenance_amount` is always derived by the engine (supplied values are ignored):
  `MA[0] = 0`, `MA[i] = MA[i-1] + max_notional[i-1] * (MMR[i] - MMR[i-1])`.
- **Tier by notional** (used for MM/LP): the first tier with `notional <= max_notional`. A notional exactly on a boundary stays in the lower tier. Above the last tier, the **last tier** is used.
- **Max leverage** of a market = `margin_tiers[0].max_leverage`. Leverage `0` or above it is rejected.
- **Tier by leverage** (used for size limits): the **highest** index with `leverage <= max_leverage[i]`. A new order is rejected (`ErrPositionNotionalExceed`) when `|size after order| * mark > max_notional` of that tier; strictly reducing orders skip the check. Changing leverage requires the current position notional to fit the new leverage's tier.

```typescript
import Decimal from "decimal.js";
Decimal.set({ precision: 19, rounding: Decimal.ROUND_HALF_EVEN }); // matches govalues/decimal

interface MarginTier {
  max_notional: string;
  max_leverage: number;
  maintenance_margin_rate: string;
  maintenance_amount: string;
}

function tierIndexByNotional(tiers: MarginTier[], notional: Decimal): number {
  for (let i = 0; i < tiers.length; i++) {
    if (notional.lte(tiers[i].max_notional)) return i;
  }
  return tiers.length - 1;
}

function tierIndexByLeverage(tiers: MarginTier[], leverage: number): number {
  if (leverage <= 0 || leverage > tiers[0].max_leverage) throw new Error("invalid leverage");
  let idx = 0;
  for (let i = 0; i < tiers.length; i++) if (leverage <= tiers[i].max_leverage) idx = i;
  return idx;
}

// Largest position notional allowed at this leverage.
const maxPositionNotional = (tiers: MarginTier[], leverage: number) =>
  new Decimal(tiers[tierIndexByLeverage(tiers, leverage)].max_notional);
```

## Position-Derived Fields

```
notional  = mark * |size|                         -> round(quote_prec)   (tier lookup uses the UNROUNDED notional)
uPnL      = (mark - entry_price) * size           -> round(quote_prec)   (signed size handles long/short)
IM        = notional / leverage                   -> round(quote_prec)   (mark-based, position leverage)
MM        = notional * MMR[tier] - MA[tier]       -> round(quote_prec)
```

A zero-size position has all fields `0`. `/v2/positions` returns `upnl` and `maintenance_margin` (plus `bankruptcy_price`, `liquidation_price`); notional, IM and tier are not served.

```typescript
interface Position {
  size: string;          // signed
  entry_price: string;
  leverage: number;
  margin_mode: "cross" | "isolated";
  iso_balance: string;
}

function derive(p: Position, mark: Decimal, tiers: MarginTier[], quotePrec: number) {
  const size = new Decimal(p.size);
  if (size.isZero()) return { notional: new Decimal(0), upnl: new Decimal(0), im: new Decimal(0), mm: new Decimal(0), tier: 0 };
  const rawNotional = mark.times(size.abs());
  const tier = tierIndexByNotional(tiers, rawNotional);
  const t = tiers[tier];
  const r = (d: Decimal) => d.toDecimalPlaces(quotePrec, Decimal.ROUND_HALF_EVEN);
  return {
    notional: r(rawNotional),
    upnl: r(mark.minus(p.entry_price).times(size)),
    im: p.leverage > 0 ? r(rawNotional.div(p.leverage)) : new Decimal(0),
    mm: r(rawNotional.times(t.maintenance_margin_rate).minus(t.maintenance_amount)),
    tier,
  };
}
```

**ROE**: the backend serves no ROE for open positions. Its ROI on closes is: fill `roi_pct = realized_pnl / (entry_price * closed_size / leverage) * 100` (gross of fees); position-history `roi_pct = net_realized_pnl / closing_margin * 100`. Use the same margin base if you display an open ROE so it lines up with history.

## Margin Profiles (cross vs isolated)

Liquidation, bankruptcy price and margin ratio are evaluated per **profile**:

| | Cross profile | Isolated profile (one per position) |
|---|---|---|
| `W` | `walletBalance - Σ iso_balance (all isolated)` | `iso_balance` |
| `UPnL` | `Σ uPnL` of cross positions | that position's uPnL |
| `MM` | `Σ MM` of cross positions | that position's MM |
| `count` | number of non-zero cross positions | 1 |

Isolated positions' uPnL/MM never enter the cross profile. Open-order margin is **not** part of any profile.

**Margin balance** `MB = W + UPnL`. **Margin ratio** `MR = MM / MB`.

| Level | Condition |
|-------|-----------|
| none | `MM = 0`, or `MM < 0.70 * MB` |
| margin call (internal only) | `MM >= 0.70 * MB` |
| reduce-only | `MM >= 0.90 * MB` -- cross: every non-reduce-only order on every symbol is cancelled and new ones blocked; isolated: only position-increasing orders on that symbol |
| liquidate | `MM >= MB` |
| bankrupt | `MB <= 0` |

Liquidation checks run on each mark-price batch (after any funding in that batch), not on fills or withdrawals.

## Bankruptcy and Liquidation Price

With `TU = profile.UPnL - position.uPnL` and `TM = profile.MM - position.MM` **only for a cross profile with count > 1** (otherwise both are 0), and `MMR`, `MA` from the position's **current** notional tier:

```
BP = entry - (W + TU) / size
LP = (entry - (W + TU - TM + MA) / size) / (1 - dir * MMR)        (1 - MMR for longs, 1 + MMR for shorts)
```

- `size` is **signed** -- do not use `|size|`.
- Results are **not rounded**. A result `<= 0` is returned as `"0"` (no bankruptcy/liquidation price).
- Cross LP moves with every other cross position's mark (through TU/TM) and with the wallet balance; isolated LP only moves when `iso_balance`, entry or tier changes.

```typescript
function liqAndBankruptcy(
  p: Position, d: ReturnType<typeof derive>, tiers: MarginTier[],
  profile: { W: Decimal; upnl: Decimal; mm: Decimal; count: number }
) {
  const size = new Decimal(p.size);
  if (size.isZero() || profile.count === 0) return { bp: new Decimal(0), lp: new Decimal(0) };
  const others = profile.count > 1;
  const TU = others ? profile.upnl.minus(d.upnl) : new Decimal(0);
  const TM = others ? profile.mm.minus(d.mm) : new Decimal(0);
  const t = tiers[d.tier];
  const dir = size.isPos() ? 1 : -1;
  const bp = new Decimal(p.entry_price).minus(profile.W.plus(TU).div(size));
  const lp = new Decimal(p.entry_price)
    .minus(profile.W.plus(TU).minus(TM).plus(t.maintenance_amount).div(size))
    .div(new Decimal(1).minus(new Decimal(t.maintenance_margin_rate).times(dir)));
  return { bp: bp.isPos() ? bp : new Decimal(0), lp: lp.isPos() ? lp : new Decimal(0) };
}
```

## Open-Order Margin (Total Order Cost)

Per symbol, over **pending/open LIMIT and MARKET orders** (untriggered TP/SL/stop orders are excluded until they trigger):

```
bid = Σ price * remaining_size   (buys)      ask = Σ price * remaining_size   (sells)
      price = limit price; market orders use: buy = bestAsk * 1.0005, sell = max(bestBid, mark)

f = max(bid, ask - 2 * notional)   if position is long or flat
f = max(ask, bid - 2 * notional)   if position is short           (notional = rounded position notional)

TotalOrderCost = round(f / symbolLeverage) + ceil(openingFeeReserve)
```

`symbolLeverage` = the account's symbol leverage setting, else market `default_leverage`. `openingFeeReserve` is non-zero only for active, non-conditional, non-reduce-only orders on **isolated** symbols: `remaining * execPrice * (2 * max(0, makerRate, takerRate) + builderBps / 10000)`, where `execPrice` is the order price (market buys: the market-order bound price; sells: `max(price, bestBid)` at admission).

Order admission: `extra = TotalOrderCost(after) - TotalOrderCost(before) + openLoss`, rejected when `extra > availableBalance`, where `openLoss = openingSize * max(0, dir_order * (price - mark))` (buying above / selling below mark). On an **isolated** position, the closing part of the order also subtracts its estimated realized PnL at the order price: `extra -= (price - entry) * closingSize` (long) / `(entry - price) * closingSize` (short). Strictly reducing orders skip the margin check, but on isolated symbols must still cover any increase in `ceil(openingFeeReserve)`.

## Account Balances

```
BaseBalance   = walletBalance - Σ TotalOrderCost (all symbols) - Σ iso_balance
Available     = BaseBalance - Σ(cross IM) + Σ(cross uPnL)                    (not clamped; positive cross uPnL counts)
Withdrawable  = max(0, BaseBalance - max(Σ(cross IM) - Σ(cross uPnL), Σ(cross MM)))
MarginBalance = walletBalance - Σ iso_balance + Σ(cross uPnL)                (cross margin balance)
```

How the REST fields map (`/v2/balances` single `USDT` row, `/v2/account`):

| REST field | Value |
|------------|-------|
| `walletBalance` / `wallet_balance` | wallet balance |
| `availableBalance` / `available_balance` | `Available` minus copy-trading holds. Floored at 0 only when an unused copy reservation (`copy_reserved_balance - copy_deployed_margin`) or `copy_profit_share_reserved` is positive; otherwise it can be negative |
| `maxWithdrawAmount`, `maxWithdrawAfterRewards` | `Withdrawable`, then `min(that, walletBalance - lockedRewards)` if `lockedRewards > 0`, minus copy holds, floored at 0 |
| `marginBalance` / `margin_balance` | `MarginBalance` (cross only) |
| `unrealizedPnl`, `crossUnPnl` / `unrealized_pnl` | Σ uPnL of **all** positions (isolated included) |
| `crossWalletBalance` | full wallet balance (isolated balances **not** subtracted) |
| `maintMargin` / `maintenance_margin` | Σ MM of all positions |
| `positionInitialMargin` / `position_initial_margin` | Σ IM of all positions |
| `initialMargin` / `total_margin` | `Σ IM + Σ MM` (legacy sum) |
| `openOrderInitialMargin` | always `"0"` (order margin is already inside `availableBalance`) |
| `marginAvailable` | always `true` |

Copy holds: `available' = max(0, available - max(0, reserved - deployed))` then `max(0, available' - profitShare)`, each step applied only when that hold is positive.

## Isolated Margin Adjustments (`POST /v2/isoMargin`)

```
maxAdd    = Withdrawable
maxRemove = max(0, iso_balance - max(IM - uPnL, MM))       (current mark)
```

Adding/removing moves funds between the cross pool and the position's `iso_balance`; wallet balance is unchanged.

On fills, isolated margin is managed automatically: opening/increasing sets `iso_balance = ceil(iso_balance + fillSize * fillPrice / leverage + openLoss)` and then enforces `iso_balance >= ceil(max(0, IM, MM))` (ceil to `quote_prec`; the opening fee is paid from the cross balance); a full close sets it to 0; partial reductions release the excess above the remaining requirement.

## Entry Price, Realized PnL, Flips

```
increase:   newEntry = round((|old size| * oldEntry + fillSize * fillPrice) / |new size|)
reduce:     realizedPnL = (fillPrice - entry) * closedSize   (long)      (entry - fillPrice) * closedSize   (short)
flip:       close the whole old size at fillPrice, then newEntry = fillPrice for the remainder (same position ID)
wallet:     += realizedPnL - fee   (builder fee charged separately)
```

Realized PnL is unrounded and gross of fees. Inverse (target price for a gross PnL of `X` on the full size): `entry + X / size` (signed size).

## Funding

**Payment per position** (hourly at HH:00 UTC):

```
payment = -size * mark * hourlyRate          (unrounded; size signed, mark rounded to quote_prec)
```

Positive rate: longs pay, shorts receive. Cross payments hit the wallet; isolated payments hit wallet and `iso_balance`. `accumulated_funding_fees += payment`. `/v2/history/funding` `amount` is this value (positive = received).

**Rate** (price service):

```
impactNotional = 50 * clamp(margin_tiers[0].max_leverage, 20, 50)          (served as impact_notional)
impactBid/Ask  = impactNotional / qty needed to fill impactNotional on that side of the Strike book
                 (falls back to index if unavailable or outside [0.8, 1.2] * index)
premium P      = (max(0, impactBid - index) - max(0, index - impactAsk)) / index    (sampled every 5 s)
P_avg          = mean of samples in [HH-1h, HH)
F8             = m * P_avg + clamp(I - m * P_avg, -m * D, +m * D)                   (= m * P_avg + I when D = 0)
F8             = clamp(F8, floor, cap)
hourlyRate     = F8 / 8
```

Defaults when a market has no override: `I = 0.0001`, `D = 0.0005`, `m = 1`, `cap = 0.04`, `floor = -0.04`. The `funding_rate` on `/v2/markets` and the mark-price stream is the live hourly estimate. `/price/v2/premiumIndex` returns `fundingRate`, `interestRate`, `interestRateDampener`, `fundingMultiplier`, `averagePremiumIndex`.

## Fees

```
commission = round(fillPrice * fillSize * rate)                                  (half-even, quote_prec)
rate       = maker_fee_rate_override (final, may be negative = rebate)          for maker fills when set
             (set by the daily fee sync from maker_rebate_tiers or a per-account override)
           = bracketRate * (1 - referralDiscount) * (1 - stakingDiscount)       otherwise (discounts only on positive rates)
builderFee = floor(fillPrice * fillSize * builderBps / 10000, 2 decimals)        (every fill, maker included)
```

- **Rebate cap:** a negative maker fee is capped per trade at the fee the protocol keeps from that trade's taker (`takerFee - takerFee * referralRewardRate`); with no taker fee the rebate is 0. Fill `fee` (`n` on the WebSocket) shows the capped value.

- Bracket rates: `/v2/fee-tiers` -> `feeTiers` (`{"Tier":0,"MinVolume":0,"TakerRate":0.0005,"MakerRate":0}` -- PascalCase keys, numbers). Tier = largest `MinVolume` <= pooled 30-day volume (master + active sub-accounts), synced to the engine by a daily job; `fee_tier` on `/v2/portfolio` is the effective tier (includes per-account overrides).
- `referralDiscount` ~= `fee_discount_rate / 100` from `/v2/portfolio` (that field is rounded to a whole percent); `stakingDiscount` = `staking_fee_discount_rate`.
- Builder fee: sent via `X-Builder-Fee-Bps` (integer, 0 to the protocol max, default max 100 = 1%) on API-wallet requests whose wallet has a builder code; must also be `<=` the builder's configured share and the user's approved max, otherwise `400`. Not charged on liquidation fills.
- Solvent liquidation fee (liquidation fills only): `floor(min(liquidation_fee_rate * price * size, liquidation_fee_retention_factor * max(0, dir * (price - neutralPrice) * size - commission)), quote_prec)`, paid to the SLP vault. Reported as `liquidation_fee` on fills.

## Full Example: Reproduce `/v2/positions` Locally

```typescript
const BASE = "https://api.strikefinance.org";

async function reproduce(signedGet: (p: string) => Promise<any>) {
  const { markets } = await (await fetch(`${BASE}/v2/markets`)).json();
  const { positions } = await signedGet("/v2/positions");
  const [bal] = await signedGet("/v2/balances");
  const wallet = new Decimal(bal.walletBalance);

  const rows = (positions ?? []).map((p: any) => {
    const m = markets[p.symbol];
    const d = derive(p, new Decimal(m.mark_price), m.margin_tiers, m.quote_prec);
    return { p, m, d };
  });

  const isoSum = rows
    .filter((r: any) => r.p.margin_mode === "isolated")
    .reduce((s: Decimal, r: any) => s.plus(r.p.iso_balance), new Decimal(0));
  const cross = rows.filter((r: any) => r.p.margin_mode === "cross" && !new Decimal(r.p.size).isZero());
  const crossProfile = {
    W: wallet.minus(isoSum),
    upnl: cross.reduce((s: Decimal, r: any) => s.plus(r.d.upnl), new Decimal(0)),
    mm: cross.reduce((s: Decimal, r: any) => s.plus(r.d.mm), new Decimal(0)),
    count: cross.length,
  };

  for (const { p, m, d } of rows) {
    const profile = p.margin_mode === "isolated"
      ? { W: new Decimal(p.iso_balance), upnl: d.upnl, mm: d.mm, count: 1 }
      : crossProfile;
    const { bp, lp } = liqAndBankruptcy(p, d, m.margin_tiers, profile);
    console.log(p.symbol, {
      upnl: d.upnl.toString(), served_upnl: p.upnl,
      mm: d.mm.toString(), served_mm: p.maintenance_margin,
      lp: lp.toString(), served_lp: p.liquidation_price,
      bp: bp.toString(), served_bp: p.bankruptcy_price,
      marginRatio: profile.mm.div(profile.W.plus(profile.upnl)).toString(),
    });
  }
}
```

Compare numerically, not as strings (Go keeps trailing zeros). Remaining differences come from the mark price snapshot (`/v2/markets` and `/v2/positions` are read at different instants) and 19-digit intermediate rounding.
