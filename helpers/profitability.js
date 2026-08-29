/**
 * Trade sizing.
 *
 * The shipped demo sized every trade at 50% of the pool's balance, which no
 * real pool can fill. The correct size is the one that maximizes profit:
 *
 *   profit(x) = sellQuote(buyQuote(x)) - x - costs
 *
 * That curve is concave. Too small and the fixed gas cost dominates; too large
 * and your own price impact eats the spread you were trying to capture. There
 * is a single peak in between, and this module finds it.
 *
 * The search is split into a coarse parallel sweep followed by a ternary
 * refine, because each probe is an eth_call and latency is the whole game.
 */

/**
 * Geometric ladder between two bounds. Geometric rather than linear because
 * profitable sizes span orders of magnitude and we care about relative steps.
 */
function ladder(min, max, steps) {
  if (max <= min) return [min]

  const points = []
  const lo = Number(min)
  const hi = Number(max)

  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    points.push(BigInt(Math.round(lo * Math.pow(hi / lo, t))))
  }

  // Rounding can collide adjacent rungs on narrow ranges.
  return [...new Set(points)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Finds the trade size maximizing net profit.
 *
 * @param quote  async (amountIn: bigint) => bigint | null
 *               Round trip: spend amountIn of the base token, return the amount
 *               of base token received back. null when the quote reverts (the
 *               pools cannot fill that size).
 * @param min    Smallest size worth probing.
 * @param max    Largest size to consider. Cap this by pool depth and by how
 *               much the flash-loan provider can actually lend.
 * @param costs  Fixed cost in base-token units, subtracted from gross profit
 *               (gas, plus any flash-loan premium).
 *
 * @returns { amountIn, amountOut, grossProfit, netProfit, probes } or null.
 */
async function findOptimalTradeSize({
  quote,
  min,
  max,
  costs = 0n,
  coarseSteps = 8,
  refineIterations = 10,
  flashLoanFeeBps = 0,
}) {
  if (min <= 0n || max < min) return null

  let probes = 0
  const seen = new Map()

  // Net of everything: the flash loan premium scales with size, gas does not.
  const evaluate = async (amountIn) => {
    if (amountIn <= 0n) return null

    const key = amountIn.toString()
    if (seen.has(key)) return seen.get(key)

    probes++
    let amountOut = null

    try {
      amountOut = await quote(amountIn)
    } catch {
      amountOut = null // Quoter reverts on sizes the pools cannot fill.
    }

    let result = null

    if (amountOut !== null) {
      const premium = (amountIn * BigInt(flashLoanFeeBps)) / 10000n
      const grossProfit = amountOut - amountIn
      result = {
        amountIn,
        amountOut,
        grossProfit,
        netProfit: grossProfit - premium - costs,
      }
    }

    seen.set(key, result)
    return result
  }

  // -- COARSE SWEEP -- //
  // Run in parallel: these are independent eth_calls and doing them serially
  // would cost more time than the opportunity usually lasts.
  const rungs = ladder(min, max, coarseSteps)
  const swept = await Promise.all(rungs.map(evaluate))

  const filled = swept
    .map((result, index) => ({ result, index }))
    .filter((entry) => entry.result !== null)

  if (filled.length === 0) return null

  let bestEntry = filled[0]
  for (const entry of filled) {
    if (entry.result.netProfit > bestEntry.result.netProfit) bestEntry = entry
  }

  let best = bestEntry.result

  // -- TERNARY REFINE -- //
  // Bracket the winning rung with its neighbours and narrow from there. The
  // curve is concave, so comparing two interior points always tells us which
  // side of the peak to discard.
  let lo = rungs[Math.max(0, bestEntry.index - 1)]
  let hi = rungs[Math.min(rungs.length - 1, bestEntry.index + 1)]

  for (let i = 0; i < refineIterations && hi - lo > 1n; i++) {
    const third = (hi - lo) / 3n
    if (third === 0n) break

    const m1 = lo + third
    const m2 = hi - third

    const [r1, r2] = await Promise.all([evaluate(m1), evaluate(m2)])

    for (const candidate of [r1, r2]) {
      if (candidate && candidate.netProfit > best.netProfit) best = candidate
    }

    // A reverted quote means that size is unfillable, so the peak is below it.
    const p1 = r1 ? r1.netProfit : null
    const p2 = r2 ? r2.netProfit : null

    if (p2 === null) {
      hi = m2
    } else if (p1 === null) {
      lo = m1
    } else if (p1 < p2) {
      lo = m1
    } else {
      hi = m2
    }
  }

  return { ...best, probes }
}

module.exports = { findOptimalTradeSize, ladder }
