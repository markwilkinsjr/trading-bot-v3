/**
 * Offline verification for helpers/profitability.js.
 *
 * Simulates two constant-product pools so the true optimal trade size can be
 * found by brute force, then checks the optimizer lands on it while using far
 * fewer probes. Runs with plain `node` -- no RPC, no fork, no deployment.
 *
 *   node scripts/verify-sizing.js
 */

const { findOptimalTradeSize, ladder } = require("../helpers/profitability")

const WAD = 10n ** 18n

// Constant-product swap with a fee, in the style of a V2 pool. Enough to
// reproduce the concave profit curve that the optimizer has to climb.
function swap(amountIn, reserveIn, reserveOut, feeBps) {
  const afterFee = (amountIn * BigInt(10000 - feeBps)) / 10000n
  return (afterFee * reserveOut) / (reserveIn + afterFee)
}

function makeRoundTrip({ buy, sell, feeBps, maxFillable = null }) {
  return async (amountIn) => {
    if (maxFillable !== null && amountIn > maxFillable) {
      throw new Error("quoter revert: insufficient liquidity")
    }
    const quoteToken = swap(amountIn, buy.base, buy.quote, feeBps)
    return swap(quoteToken, sell.quote, sell.base, feeBps)
  }
}

async function bruteForce(quote, min, max, steps, costs, feeBps) {
  let best = null

  for (let i = 0; i <= steps; i++) {
    const amountIn = min + ((max - min) * BigInt(i)) / BigInt(steps)
    if (amountIn <= 0n) continue

    let out
    try {
      out = await quote(amountIn)
    } catch {
      continue
    }

    const premium = (amountIn * BigInt(feeBps)) / 10000n
    const netProfit = out - amountIn - premium - costs

    if (best === null || netProfit > best.netProfit) best = { amountIn, netProfit }
  }

  return best
}

const fmt = (v) => (Number(v) / Number(WAD)).toFixed(6)

let failures = 0
function check(label, condition, detail) {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`)
  if (!condition) failures++
}

async function main() {
  console.log("\nLadder bounds")
  const rungs = ladder(WAD / 100n, 10n * WAD, 8)
  check("ascending and within bounds",
    rungs[0] >= WAD / 100n &&
    rungs[rungs.length - 1] <= 10n * WAD &&
    rungs.every((v, i) => i === 0 || v > rungs[i - 1]),
    `${rungs.length} rungs, ${fmt(rungs[0])} .. ${fmt(rungs[rungs.length - 1])}`)

  // -- CASE 1: a real 3% dislocation -- //
  // Buy the quote token on the pool that gives more of it, sell where it is dearer.
  console.log("\nCase 1: 3% dislocation, 30bps pools, gas cost included")
  const feeBps = 30
  const costs = WAD / 1000n // 0.001 base token of gas

  const quote1 = makeRoundTrip({
    buy: { base: 1000n * WAD, quote: 3_090_000n * WAD },
    sell: { base: 1000n * WAD, quote: 3_000_000n * WAD },
    feeBps,
  })

  const truth1 = await bruteForce(quote1, WAD / 1000n, 100n * WAD, 4000, costs, 0)
  const found1 = await findOptimalTradeSize({
    quote: quote1, min: WAD / 1000n, max: 100n * WAD, costs,
  })

  check("found a profitable size", found1 !== null && found1.netProfit > 0n)
  console.log(`        brute force: ${fmt(truth1.amountIn)} in -> ${fmt(truth1.netProfit)} net (4001 probes)`)
  console.log(`        optimizer:   ${fmt(found1.amountIn)} in -> ${fmt(found1.netProfit)} net (${found1.probes} probes)`)

  const capture = Number(found1.netProfit) / Number(truth1.netProfit)
  check("captures >=99% of achievable profit", capture >= 0.99, `${(capture * 100).toFixed(2)}%`)
  check("uses far fewer probes than brute force", found1.probes < 40, `${found1.probes} probes`)

  // -- CASE 2: pools at parity, fees make every size a loss -- //
  console.log("\nCase 2: no dislocation (must not report a profit)")
  const quote2 = makeRoundTrip({
    buy: { base: 1000n * WAD, quote: 3_000_000n * WAD },
    sell: { base: 1000n * WAD, quote: 3_000_000n * WAD },
    feeBps,
  })

  const found2 = await findOptimalTradeSize({
    quote: quote2, min: WAD / 1000n, max: 100n * WAD, costs,
  })
  check("best net profit is negative", found2 !== null && found2.netProfit < 0n, `${fmt(found2.netProfit)} net`)

  // -- CASE 3: gas cost alone kills a thin edge -- //
  console.log("\nCase 3: real but tiny edge, swamped by gas")
  const quote3 = makeRoundTrip({
    buy: { base: 1000n * WAD, quote: 3_001_000n * WAD },
    sell: { base: 1000n * WAD, quote: 3_000_000n * WAD },
    feeBps: 1,
  })

  const cheap = await findOptimalTradeSize({ quote: quote3, min: WAD / 1000n, max: 100n * WAD, costs: 0n })
  const pricey = await findOptimalTradeSize({ quote: quote3, min: WAD / 1000n, max: 100n * WAD, costs: WAD })

  check("profitable when gas is free", cheap.netProfit > 0n, `${fmt(cheap.netProfit)} net`)
  check("unprofitable once gas is charged", pricey.netProfit < 0n, `${fmt(pricey.netProfit)} net`)

  // -- CASE 4: quoter reverts above a liquidity cap -- //
  console.log("\nCase 4: quoter reverts above a cap (thin pool)")
  const cap = 2n * WAD
  const quote4 = makeRoundTrip({
    buy: { base: 1000n * WAD, quote: 3_090_000n * WAD },
    sell: { base: 1000n * WAD, quote: 3_000_000n * WAD },
    feeBps,
    maxFillable: cap,
  })

  const found4 = await findOptimalTradeSize({ quote: quote4, min: WAD / 1000n, max: 100n * WAD, costs })
  check("stays at or under the fillable cap", found4 !== null && found4.amountIn <= cap, `${fmt(found4.amountIn)} <= ${fmt(cap)}`)
  check("still profitable within the cap", found4.netProfit > 0n, `${fmt(found4.netProfit)} net`)

  // -- CASE 5: flash loan premium changes the answer -- //
  console.log("\nCase 5: flash-loan premium reduces net profit")
  const free = await findOptimalTradeSize({ quote: quote1, min: WAD / 1000n, max: 100n * WAD, costs, flashLoanFeeBps: 0 })
  const aave = await findOptimalTradeSize({ quote: quote1, min: WAD / 1000n, max: 100n * WAD, costs, flashLoanFeeBps: 5 })

  check("Aave 5bps premium nets less than Balancer 0bps",
    aave.netProfit < free.netProfit,
    `${fmt(aave.netProfit)} vs ${fmt(free.netProfit)}`)

  // -- CASE 6: degenerate inputs -- //
  console.log("\nCase 6: degenerate inputs")
  check("rejects zero minimum", (await findOptimalTradeSize({ quote: quote1, min: 0n, max: WAD })) === null)
  check("rejects inverted bounds", (await findOptimalTradeSize({ quote: quote1, min: 10n * WAD, max: WAD })) === null)
  check("returns null when every quote reverts",
    (await findOptimalTradeSize({
      quote: async () => { throw new Error("always reverts") },
      min: WAD / 1000n, max: WAD,
    })) === null)

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
