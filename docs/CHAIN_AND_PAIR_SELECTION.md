# Choosing a chain and a pair

Research notes behind the default config. Read this before funding anything.

## The honest starting point

Same-chain atomic arbitrage is one of the most competitive activities in crypto.
The numbers matter more than the enthusiasm:

- Roughly **78% of profitable same-chain arbitrage is captured by the top ~12
  searcher operations**; the remaining 22% is contested by thousands of retail
  bots, putting an individual retail bot's capture rate near **0.3–0.8%**.
- On Arbitrum, the Timeboost express-lane auction has been won by
  **three entities 99.74% of the time**, and ~94% of time-boosted transactions
  are CEX–DEX arbitrage.
- On Base, **two entities account for 80%+ of MEV extraction**.

This bot, as written, connects over a public WebSocket RPC, reacts to a `Swap`
event, then makes several sequential `eth_call`s before it can even build a
transaction. That round trip is hundreds of milliseconds. The searchers it
competes with are co-located with the sequencer and measure in single-digit
milliseconds.

**Conclusion:** on the top pairs, this bot will lose essentially every race. That
is not a reason not to run it — it is a reason to point it somewhere the fast
players are not looking, and to size expectations accordingly.

## Where the edge actually is

The one durable finding across the research: **long-tail pairs have worse dollar
throughput per opportunity, but competition is roughly two orders of magnitude
lighter.** Large operations ignore opportunities whose profit doesn't cover their
own overhead. That gap is the only realistic opening here.

So the selection criteria invert what you'd expect:

| Prefer | Avoid |
| --- | --- |
| Pairs both DEXes list but neither dominates | WETH/USDC and other flagship pools |
| Mid-cap and ecosystem tokens | Anything with a deep CEX order book |
| Pools where the *thin* side still holds real depth | Pools where one side is nearly empty |
| Higher fee tiers (3000/10000) — fewer bots bother | 100/500 tiers on major pairs |

The trap in the last row: a higher fee tier means the round trip must clear
**twice** the fee before gas. A 1% tier needs a 200 bps move just to break even.
Wide spreads on illiquid pools are usually a fee wall, not an opportunity.

## Chain comparison

| | Arbitrum | Base | BNB Chain |
| --- | --- | --- | --- |
| Gas per swap | ~$0.05–0.30 | ~$0.01–0.10 | very low |
| Ordering | FCFS latency race + Timeboost auction | Priority fee, private mempool | Public mempool |
| Balancer V2 vault (flash loans) | Yes | Yes | **No** |
| Uniswap V3 TVL | ~$253M | Large, but Aerodrome leads | Present |
| PancakeSwap V3 TVL | **~$12.9M total** | Modest | Dominant |

### Recommendation: start on Base

Base is the best fit for this specific bot:

1. **Cheapest gas** of the credible options — roughly 3–5× cheaper than Arbitrum,
   which directly lowers the profit threshold a trade must clear.
2. **Balancer V2's vault is deployed** at the same canonical address
   (`0xBA12222222228d8Ba445958a75a0704d566BF2C8`), so `Arbitrage.sol` works
   **unchanged**.
3. Deep long-tail activity — a large population of mid-cap tokens that the top
   searchers don't prioritize.

Base's caveat is real: its MEV is highly concentrated, and its private mempool
means you cannot observe competitors. You win by picking pools they ignore, not
by being fast.

**Arbitrum** is the reasonable second choice and needs no config change, but note
the problem with the shipped default below.

**BNB Chain** has the cheapest gas and the most PancakeSwap liquidity, but
**Balancer is not deployed there**, so `Arbitrage.sol` would need its flash-loan
provider swapped out entirely. Only worth it if you commit to that work.

## The problem with the shipped default

`config.json` ships pointing at **WETH/ARB at the 500 fee tier on Arbitrum**,
arbitraging Uniswap V3 against PancakeSwap V3. Two issues:

1. **PancakeSwap V3 on Arbitrum holds only ~$12.9M across all pairs.** The
   WETH/ARB slice of that is small. In a two-venue arbitrage the *thin* side caps
   the trade size, so the ceiling here is low even when a spread appears.
2. WETH/ARB is a major, heavily-watched pair. Any spread wide enough to be worth
   taking is exactly the kind a co-located searcher takes first.

Do not assume this default is a good market. Measure it.

## Measure, don't guess — `scripts/scan.js`

Any pair list written into a document is stale the day after it's written.
The scanner checks live state instead:

```bash
node scripts/scan.js base
node scripts/scan.js arbitrum --sizes 0.05,0.1,0.5
BASE_RPC_URL=https://your-endpoint node scripts/scan.js base
```

For every pair and fee tier it:

- confirms a pool exists on **both** venues (most candidates die here),
- reads each pool's live price, orienting decimals by the pool's own token
  ordering,
- runs a **real round trip through both quoters** — buy on one venue, sell on the
  other — so the reported number includes both swap fees and the price impact of
  the trade itself, which a raw spread does not,
- compares the result against live gas costs,
- prints what clears fees *and* gas right now.

It never sends a transaction, and it fails loudly if a configured address has no
contract code rather than silently reporting "no pools".

Expect "nothing clears fees + gas right now" most of the time. That is the
correct resting state of an efficient market — real opportunities exist for a
block or two after a large swap. Use the scanner to shortlist pairs, then leave
`bot.js` watching the best ones.

## Before risking real money

- `determineProfitability()` in `bot.js` is demo code: it sizes trades at **50%
  of the entire pool balance**, which no real pool can fill without catastrophic
  slippage. Replace it with a proper size search before going live.
- Verify every address in `config/chains.json` against official protocol docs.
  The scanner's preflight proves an address *has code*, not that it's the
  *correct* deployment.
- Run against a mainnet fork first. `isDeployed: false` lets you watch for
  opportunities with no contract deployed and nothing at risk.
- Aerodrome is the largest DEX on Base (50–63% of volume), but its Slipstream
  pools key on **tickSpacing rather than fee**, so it is *not* a drop-in third
  venue for this bot's Uniswap V3 interface. Adding it means new adapter code.

## Sources

- [DEX Arbitrage with Stablecoins in 2026: Risks & Reality](https://bitsgap.com/blog/dex-arbitrage-with-stablecoins-in-2026-where-the-opportunity-is-and-what-can-go-wrong)
- [Arbitrage Bot Profitability Across Different DEX Pairs](https://blog.echozero.app/article/arbitrage-bot-profitability-across-different-dex-pairs)
- [The Express Lane to Spam and Centralization: An Empirical Analysis of Arbitrum's Timeboost](https://arxiv.org/abs/2509.22143)
- [First-Spammed, First-Served: MEV Extraction on Fast-Finality Blockchains](https://arxiv.org/html/2506.01462v1)
- [How Timeboost works — Arbitrum Docs](https://docs.arbitrum.io/how-arbitrum-works/timeboost/gentle-introduction)
- [Base Chain Gas Fees Explained](https://openliquid.io/blog/base-chain-gas-fees-explained/)
- [PancakeSwap v3 (Arbitrum) volume and liquidity](https://coinmarketcap.com/exchanges/pancake-v3-arbitrum/)
- [Uniswap V3 TVL, Fees, Revenue & Volume — DefiLlama](https://defillama.com/protocol/uniswap-v3)
- [How Aerodrome Became Base's Liquidity Engine](https://basechain.news/protocol-review-aerodromes-grip-on-base-liquidity-cuts/)
- [Balancer V2 Flash Loans](https://docs-v2.balancer.fi/reference/contracts/flash-loans.html)
