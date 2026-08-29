# trading-bot-v3

DEX arbitrage bot. Watches `Swap` events on two Uniswap-V3-style DEXes, and when
the same pair is priced differently on both, flash loans the base token, buys on
the cheap venue, sells on the dear one, and repays inside one transaction.

Read `docs/CHAIN_AND_PAIR_SELECTION.md` before changing chains, pairs, or the
flash-loan provider. It carries the research and the reasons behind the config.

## Layout

| Path | Purpose |
| --- | --- |
| `bot.js` | Event loop: watch swaps, check price, size the trade, execute |
| `helpers/profitability.js` | Finds the profit-maximizing trade size |
| `helpers/initialization.js` | Provider + exchange contracts. `WSS_RPC_URL` picks the chain |
| `contracts/Arbitrage.sol` | Balancer V2 flash loan (0 bps, but see the warning below) |
| `contracts/ArbitrageAave.sol` | Aave V3 flash loan (5 bps, actively maintained) — preferred |
| `scripts/scan.js` | Read-only: live spreads across every venue pairing |
| `scripts/flashloan-check.js` | Read-only: per-chain flash-loan availability and real capacity |
| `scripts/verify-sizing.js` | Offline: verifies the sizer against a simulated AMM. No network |
| `config/chains.json` | Chain profiles: DEX addresses, tokens, flash-loan providers |
| `config.json` | Live bot settings: the pair, fee tier, thresholds |

## Verification

```bash
node scripts/verify-sizing.js     # offline, no RPC needed. Must print "All checks passed"
npx hardhat compile               # expect 14 contracts; only unused-parameter warnings
node scripts/flashloan-check.js   # needs network
node scripts/scan.js bsc          # needs network
```

`verify-sizing.js` is the regression test for `helpers/profitability.js`. If you
change the sizing logic, it must still pass — it brute-forces the true optimum on
a simulated AMM and asserts the optimizer captures ≥99% of it.

## Things that will bite you

**Only fee-tier V3 DEXes work here.** The bot calls
`factory.getPool(tokenA, tokenB, fee)`. Algebra forks (Camelot, QuickSwap, THENA)
have no fee argument; Aerodrome Slipstream keys on tickSpacing. Neither is a
drop-in venue — adding one means writing an adapter. This is why Avalanche and
NEAR are not in `config/chains.json`: not enough compatible venues to arbitrage
between.

**Balancer V2 is damaged.** Exploited for ~$128M in Nov 2025; TVL down roughly
two thirds; Balancer Labs wound down March 2026. The vault is immutable so it
still functions, but it lends from its own balance, so **that balance is the loan
ceiling**. Prefer `ArbitrageAave.sol`. Run `flashloan-check.js` to see real
capacity rather than assuming.

**The base token must be the chain's wrapped gas token** (WETH, WBNB). Profit and
gas then share a unit, and `determineProfitability()` compares them directly with
no conversion. A non-gas base token needs a price conversion added first.

**Addresses in `config/chains.json` are not all verified.** They were assembled
without on-chain access. The scanner's preflight proves an address has contract
code and warns when a token's on-chain `symbol()` disagrees with the config key —
it cannot prove an address is the official deployment. SushiSwap V3 quoter/router
are `null`; that venue reports spread-only until they are filled in.

## Safety

- Never commit a `.env` or a private key. `.gitignore` covers `.env` — keep it that way.
- `scan.js`, `flashloan-check.js` and `verify-sizing.js` send no transactions. Prefer them for exploration.
- Test against a mainnet fork before mainnet. `isDeployed: false` watches for opportunities with nothing deployed and nothing at risk.
- This bot competes with co-located searchers who capture ~78% of profitable same-chain arbitrage. Assume it loses races on major pairs; the edge, if any, is in long-tail pairs.
