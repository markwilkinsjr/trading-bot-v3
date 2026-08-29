# Chain, pair, and flash-loan selection

Research notes behind `config/chains.json`. Read before funding anything.

## The constraint that eliminates most options

This bot finds a pool with `factory.getPool(tokenA, tokenB, fee)` and swaps
through a Uniswap V3 `ISwapRouter`. That one line of interface rules out most
DEXes on most chains:

| DEX family | Pool lookup | Works here? |
| --- | --- | --- |
| Uniswap V3 | `getPool(a, b, fee)` | Yes |
| PancakeSwap V3 | `getPool(a, b, fee)` | Yes |
| SushiSwap V3 | `getPool(a, b, fee)` | Yes |
| Algebra (Camelot, QuickSwap, THENA, StellaSwap, +70 more) | `poolByPair(a, b)` — **no fee argument**, fees are dynamic | No |
| Aerodrome / Velodrome Slipstream | `getPool(a, b, tickSpacing)` — **tickSpacing, not fee** | No |
| Trader Joe Liquidity Book | bins, not ticks | No |
| Curve | different math entirely | No |

So a chain is only usable if it hosts **two or more fee-tier V3 DEXes with the
same pair**. That is the first filter, and it is stricter than it sounds.

## Chain comparison

| Chain | Gas token | Compatible venues | Gas/swap | Verdict |
| --- | --- | --- | --- | --- |
| **BNB Chain** | WBNB | PancakeSwap V3 **+** Uniswap V3 | lowest | **Best pair availability** |
| **Base** | ETH | Uniswap V3 + PancakeSwap V3 (+ Sushi V3) | ~$0.01–0.10 | **Best cost**, deep long tail |
| **Arbitrum** | ETH | Uniswap V3 + PancakeSwap V3 (+ Sushi V3) | ~$0.05–0.30 | Workable, thin Pancake side |
| Polygon | POL | Uniswap V3 + Sushi V3 (QuickSwap is Algebra) | very low | Possible, low volume |
| Avalanche | AVAX | Uniswap V3 only — Trader Joe is Liquidity Book | low | **Ruled out**: no second venue |
| NEAR / Aurora | NEAR | no significant V3-style DEX pair | low | **Ruled out** |
| Ethereum | ETH | many | $2–20+ | **Ruled out**: gas exceeds any edge you can win |

You asked about WETH/AVAX and WETH/NEAR specifically. Both fail the filter above
before liquidity even matters — Avalanche has only one compatible venue, and
Aurora has none. There is nothing to arbitrage *between*.

Note that on Base and Arbitrum the gas token is ETH, so "the native pair" is
WETH paired against the chain's *governance* token (ARB) or its *DEX* token
(AERO), not against a separate gas asset. BNB Chain is the one where the gas
token and the DEX-token pair line up exactly: **WBNB/CAKE**.

## Flash loans: verify per chain, and mind Balancer

`Arbitrage.sol` flash loans exclusively from Balancer V2. That is now a problem:

- November 2025: Balancer V2 was exploited for **~$128M** via a rounding error
  in `_upscaleArray`, across Ethereum, Base, Polygon and Arbitrum.
- TVL fell from roughly **$775M to $258M**; ~$500M left within two weeks.
- March 2026: **Balancer Labs wound down** as a corporate entity. The protocol
  runs on in leaner form; V2's contracts are immutable so they still function,
  but the codebase is effectively unmaintained.

The vault lends from its own token balance, so **its balance is your maximum
flash loan**. A two-thirds TVL cut is a direct cut to your trade ceiling.

| Provider | Fee | Deployed on | Status |
| --- | --- | --- | --- |
| Balancer V2 | **0 bps** | Ethereum, Polygon, Arbitrum, Optimism, Gnosis, **BSC**, Avalanche, Base | Exploited, unmaintained, TVL down ~2/3 |
| Aave V3 | **5 bps** | Ethereum, Polygon, Avalanche, Arbitrum, Base, BNB, Optimism, Gnosis, Scroll, Linea, Mantle | Actively maintained, v3.7 rollout |

I previously told you Balancer wasn't on BSC. That was wrong — the official
`balancer-deployments` package lists BSC. Corrected in `config/chains.json`.

**Recommendation: use Aave V3.** The 5bps premium is real but small, and an edge
thinner than 5bps was never going to survive gas anyway. `contracts/ArbitrageAave.sol`
implements this — same `executeTrade` signature, so `bot.js` needs no change
beyond `ARBITRAGE_ADDRESS` and `FLASH_LOAN_FEE_BPS: 5`.

Don't take the table on faith. Run:

```bash
node scripts/flashloan-check.js          # all chains
node scripts/flashloan-check.js bsc
```

It reports, per chain: whether each provider is deployed, the **Balancer vault's
actual balance of your base token** (the real loan ceiling), Aave's on-chain
`FLASHLOAN_PREMIUM_TOTAL`, and whether your base token is a listed Aave reserve.

## Pairs: why the gas token belongs on one side

Denominating in the wrapped gas token means profit and gas are the **same unit**,
so break-even is exact arithmetic rather than an estimate that needs a price
oracle. Every chain in `config/chains.json` uses its gas token as the base, and
`determineProfitability()` relies on this.

### Tier A — gas token vs. governance/DEX token

The sweet spot you described. Real volume, genuine two-venue listings, but not
the pairs a CEX–DEX desk watches tick by tick.

| Chain | Pair | Why it qualifies |
| --- | --- | --- |
| BNB | **WBNB/CAKE** | CAKE is PancakeSwap's own token — deepest on Pancake, thinner on Uniswap V3. Structural, persistent imbalance. |
| Base | **WETH/AERO** | Aerodrome's token, 50–63% of Base volume. Traded on Uni/Pancake V3 without Aerodrome itself being a usable venue. |
| Arbitrum | **WETH/ARB** | Governance token, high volume. Heavily watched, though — treat as the competitive end of this tier. |
| Arbitrum | **WETH/GMX**, **WETH/PENDLE** | Ecosystem tokens with real volume and materially less bot attention than ARB. |

The reason a DEX's own token is structurally interesting: liquidity concentrates
on its home venue, so the *other* venue's pool stays thin and drifts. That drift
is what you are trying to catch.

### Tier B — gas token vs. mid-cap / meme

| Chain | Pair | Trade-off |
| --- | --- | --- |
| Base | WETH/DEGEN, WETH/BRETT | Volatile enough to dislocate often; thin enough that size is capped and the 3000 tier's 60bps round-trip floor is a real wall. |

### Tier C — gas token vs. stable or major (avoid)

`*/USDC`, `*/USDT`, `WETH/WBTC`, `WBNB/BTCB`. Deepest liquidity and most
frequent dislocations, and therefore the most thoroughly farmed. These are where
the top-12 searchers with co-located infrastructure live. Included in
`config/chains.json` only as a baseline to compare the other tiers against.

### The fee-tier trap

Higher tiers have fewer competitors, but the round trip pays the fee **twice**:

| Tier | Round-trip floor | Reality |
| --- | --- | --- |
| 100 (0.01%) | 2 bps | Stables only |
| 500 (0.05%) | 10 bps | Most gas-token majors |
| 2500 / 3000 | 50–60 bps | Needs a genuinely large dislocation |
| 10000 (1%) | **200 bps** | A 2% move just to break even |

A wide spread on an illiquid 1% pool is usually a fee wall, not an opportunity.

## What the numbers can't tell you

Roughly **78% of profitable same-chain arbitrage** goes to the top ~12 searcher
operations; the rest is contested by thousands of bots at a per-bot capture rate
near **0.3–0.8%**. On Arbitrum, three entities won **99.74%** of Timeboost
express-lane auctions. On Base, two entities account for **80%+** of MEV.

Long-tail pairs are the only real opening: competition there is roughly **two
orders of magnitude lighter**, because large operations skip opportunities that
don't clear their own overhead. Tier A above is chosen on exactly that basis.

## Measure it yourself

Any pair list is stale the week after it's written. The scanner checks live state
across **every venue combination** on a chain:

```bash
node scripts/scan.js bsc                  # WBNB pairs, Pancake vs Uniswap
node scripts/scan.js base --max 2
node scripts/scan.js arbitrum --json      # machine-readable
```

For each pair, fee tier, and venue pairing it confirms pools exist on both sides,
reads live prices (orienting decimals by each pool's own token ordering), then
uses the same optimizer `bot.js` uses to find the **profit-maximizing trade size**
through both quoters — so the number includes both swap fees and the price impact
of that exact size. It compares against live gas and prints what clears both.

Expect "nothing clears fees + gas right now" most of the time. That is the correct
resting state of an efficient market.

## Changes made to the bot

- **`determineProfitability()` rewritten.** It previously sized every trade at
  **50% of the pool's entire balance** — unfillable. It now searches for the
  profit-maximizing size (`helpers/profitability.js`): a parallel coarse sweep
  then a ternary refine over the concave profit curve, bounded by pool depth,
  charged for live gas and the flash-loan premium, and gated on `MIN_PROFIT`.
  Verified against a brute-forced simulated AMM in `scripts/verify-sizing.js` —
  it captures 100% of achievable profit using 28 quoter probes instead of 4001.
- **Gas is priced live** from `provider.getFeeData()` instead of the hardcoded
  `GAS_PRICE` constant, which is now display-only.
- **`contracts/ArbitrageAave.sol` added** — Aave V3 flash loans, for the reasons
  above.
- **`onlyOwner` added to both contracts' `executeTrade`.** It was previously
  callable by anyone with an arbitrary `routerPath`. The flash-loan repayment
  would have reverted such a transaction, so funds were not directly at risk,
  but there was no reason to leave it open.
- **`WSS_RPC_URL`** now overrides the hardcoded Arbitrum endpoint, so the bot can
  point at any chain without editing `helpers/initialization.js`.

## Still to do before real money

- Fill in SushiSwap V3 quoter/router addresses (factories are in the config;
  quoter/router are marked `null` and the scanner reports spread-only for that
  venue until they're supplied).
- Verify every address against official docs. The scanner proves an address has
  code and that token symbols match the config keys — not that it is the
  official deployment.
- Run against a mainnet fork first, with `isDeployed: false`.

## Sources

- [Balancer V2 exploit analysis — Check Point Research](https://research.checkpoint.com/2025/how-an-attacker-drained-128m-from-balancer-through-rounding-error-exploitation/)
- [Balancer DAO recovery plan; TVL cut by two-thirds — CoinDesk](https://www.coindesk.com/web3/2025/11/27/balancer-dao-starts-discussing-usd8m-recovery-plan-after-usd110m-exploit-cut-tvl-by-two-thirds)
- [Balancer Labs shutting down — CoinDesk](https://www.coindesk.com/tech/2026/03/24/balancer-labs-will-shut-down-as-corporate-entity-became-a-liability-after-usd110-million-exploit)
- [balancer-deployments (network list)](https://github.com/balancer/balancer-deployments)
- [Aave V3 networks and changelog](https://aave.com/docs/resources/changelog)
- [Algebra vs Uniswap V3 architecture](https://docs.algebra.finance/algebra-integral/integration-of-algebra-integral-protocol/migration-from-uniswapv3)
- [Timeboost express-lane centralization](https://arxiv.org/abs/2509.22143)
- [First-Spammed, First-Served: MEV on fast-finality chains](https://arxiv.org/html/2506.01462v1)
- [Arbitrage bot profitability across DEX pairs](https://blog.echozero.app/article/arbitrage-bot-profitability-across-different-dex-pairs)
- [Base gas fees](https://openliquid.io/blog/base-chain-gas-fees-explained/)
- [PancakeSwap v3 Arbitrum liquidity](https://coinmarketcap.com/exchanges/pancake-v3-arbitrum/)
- [Aerodrome's share of Base volume](https://basechain.news/protocol-review-aerodromes-grip-on-base-liquidity-cuts/)
