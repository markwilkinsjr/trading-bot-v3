/**
 * Pair scanner.
 *
 * Answers the question that has to come before any bot config: on this chain,
 * which gas-token pairs exist on two or more compatible DEXes, how far apart
 * are their prices, and does an optimally-sized round trip clear fees and gas?
 *
 * It never sends a transaction. Every call is a read or an eth_call.
 *
 *   node scripts/scan.js base
 *   node scripts/scan.js bsc --max 5
 *   BASE_RPC_URL=https://... node scripts/scan.js base --json
 */

require("dotenv").config()

const ethers = require("ethers")
const Big = require("big.js")

const chains = require("../config/chains.json")
const { findOptimalTradeSize } = require("../helpers/profitability")

// sqrtPriceX96 squaring needs far more precision than the Big.js default of 20.
Big.DP = 60

const IUniswapV3Factory = require("@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json")
const IQuoterV2 = require("@uniswap/v3-periphery/artifacts/contracts/interfaces/IQuoterV2.sol/IQuoterV2.json")
const IERC20 = require("@openzeppelin/contracts/build/contracts/ERC20.json")

// Minimal pool ABI. Deliberately not the full Uniswap artifact: PancakeSwap's
// slot0 returns a different tuple, and these getters are identical on both.
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)",
  "function token0() view returns (address)",
  "function liquidity() view returns (uint128)",
]

const FEE_TIERS = [100, 500, 2500, 3000, 10000]

// -- ARGUMENTS -- //

function parseArgs(argv) {
  const args = { chain: null, min: 0.01, max: 5, json: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--min") args.min = Number(argv[++i])
    else if (arg === "--max") args.max = Number(argv[++i])
    else if (arg === "--json") args.json = true
    else if (!arg.startsWith("--")) args.chain = arg
  }

  return args
}

// -- PRICE MATH -- //

const Q96 = Big(2).pow(96)

/**
 * Uniswap V3 stores sqrt(reserve1/reserve0) * 2^96 in raw token units.
 * Squaring gives raw token1 per raw token0; the decimal shift converts that
 * into human token1 per 1 human token0.
 */
function priceFromSqrtX96(sqrtPriceX96, decimals0, decimals1) {
  const ratio = Big(sqrtPriceX96.toString()).div(Q96)
  return ratio.times(ratio).times(Big(10).pow(Number(decimals0) - Number(decimals1)))
}

// -- ON-CHAIN READS -- //

async function loadToken(symbolHint, address, provider, cache) {
  const key = address.toLowerCase()
  if (cache.has(key)) return cache.get(key)

  const contract = new ethers.Contract(address, IERC20.abi, provider)

  let symbol
  let decimals
  try {
    ;[symbol, decimals] = await Promise.all([contract.symbol(), contract.decimals()])
  } catch (error) {
    throw new Error(`${symbolHint} (${address}) is not a readable ERC20: ${error.shortMessage || error.message}`)
  }

  // A wrong address usually still answers symbol(). Comparing against the
  // config key is what actually catches a typo or a copy-paste from a
  // different chain.
  if (symbol.toLowerCase() !== symbolHint.toLowerCase()) {
    console.log(`  WARNING: config calls ${address} "${symbolHint}" but the contract reports "${symbol}"`)
  }

  const token = { contract, address, symbol, decimals: Number(decimals) }
  cache.set(key, token)
  return token
}

async function readPool(exchange, tokenA, tokenB, fee, provider) {
  const poolAddress = await exchange.factory.getPool(tokenA.address, tokenB.address, fee)
  if (poolAddress === ethers.ZeroAddress) return null

  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider)

  let slot0
  let token0Address
  try {
    ;[slot0, token0Address] = await Promise.all([pool.slot0(), pool.token0()])
  } catch {
    return null
  }

  if (slot0.sqrtPriceX96 === 0n) return null

  // Orient by the pool's own ordering, not the caller's, so prices from two
  // venues are directly comparable.
  const zeroIsA = token0Address.toLowerCase() === tokenA.address.toLowerCase()
  const token0 = zeroIsA ? tokenA : tokenB
  const token1 = zeroIsA ? tokenB : tokenA

  const [balance0, balance1] = await Promise.all([
    token0.contract.balanceOf(poolAddress),
    token1.contract.balanceOf(poolAddress),
  ])

  const baseBalance = token0.address === tokenA.address ? balance0 : balance1

  return {
    venue: exchange.name,
    address: poolAddress,
    price: priceFromSqrtX96(slot0.sqrtPriceX96, token0.decimals, token1.decimals),
    baseBalance,
    balances: [
      { symbol: token0.symbol, amount: balance0, decimals: token0.decimals },
      { symbol: token1.symbol, amount: balance1, decimals: token1.decimals },
    ],
  }
}

/**
 * Round trip: spend the base token on `buyOn`, sell the proceeds on `sellOn`.
 * Includes both pools' fees and the price impact of the size itself.
 */
function makeRoundTrip(buyOn, sellOn, base, quote, fee) {
  return async (amountIn) => {
    const [bought] = await buyOn.quoter.quoteExactInputSingle.staticCall({
      tokenIn: base.address, tokenOut: quote.address, amountIn, fee, sqrtPriceLimitX96: 0,
    })
    if (bought === 0n) throw new Error("buy leg quoted zero")

    const [returned] = await sellOn.quoter.quoteExactInputSingle.staticCall({
      tokenIn: quote.address, tokenOut: base.address, amountIn: bought, fee, sqrtPriceLimitX96: 0,
    })
    return returned
  }
}

// -- PREFLIGHT -- //

async function preflight(chain, provider) {
  const network = await provider.getNetwork()

  if (Number(network.chainId) !== chain.chainId) {
    throw new Error(
      `RPC reports chain ${network.chainId}, config expects ${chain.chainId} (${chain.label}). Check your RPC URL.`
    )
  }

  for (const [name, exchange] of Object.entries(chain.exchanges)) {
    for (const role of ["factory", "quoter", "router"]) {
      const address = exchange[role]
      if (!address) continue

      // A mistyped factory silently returns the zero address for every pool,
      // which is indistinguishable from "no pools exist". Fail loudly instead.
      if ((await provider.getCode(address)) === "0x") {
        throw new Error(
          `${name} ${role} (${address}) has no contract code on ${chain.label}. ` +
          `Verify it against the protocol's official deployment list.`
        )
      }
    }
  }
}

// -- MAIN -- //

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const chain = chains[args.chain]

  if (!chain) {
    const names = Object.keys(chains).filter((k) => !k.startsWith("_"))
    console.error(`Usage: node scripts/scan.js <${names.join("|")}> [--min 0.01] [--max 5] [--json]`)
    process.exit(1)
  }

  const rpcUrl = process.env[chain.rpcEnv] || chain.defaultRpc
  const provider = new ethers.JsonRpcProvider(rpcUrl)

  console.log(`\nScanning ${chain.label} via ${rpcUrl}\n`)
  await preflight(chain, provider)

  const exchanges = Object.entries(chain.exchanges).map(([name, addresses]) => ({
    name,
    hasQuoter: Boolean(addresses.quoter),
    factory: new ethers.Contract(addresses.factory, IUniswapV3Factory.abi, provider),
    quoter: addresses.quoter ? new ethers.Contract(addresses.quoter, IQuoterV2.abi, provider) : null,
  }))

  if (exchanges.length < 2) {
    throw new Error(`${chain.label} needs at least two exchanges configured to compare.`)
  }

  const cache = new Map()
  const base = await loadToken(chain.baseToken, chain.tokens[chain.baseToken], provider, cache)

  const feeData = await provider.getFeeData()
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n
  const gasCost = gasPrice * BigInt(chain.gasLimitEstimate)

  console.log(`Base token:  ${base.symbol} (the chain's gas token, so profit and gas share a unit)`)
  console.log(`Venues:      ${exchanges.map((e) => e.name + (e.hasQuoter ? "" : " [no quoter]")).join(", ")}`)
  console.log(`Gas budget:  ${chain.gasLimitEstimate} gas -> ~${ethers.formatUnits(gasCost, 18)} ${chain.nativeSymbol}`)
  console.log(`Size range:  ${args.min} .. ${args.max} ${base.symbol}\n`)

  const minSize = ethers.parseUnits(String(args.min), base.decimals)
  const maxSize = ethers.parseUnits(String(args.max), base.decimals)

  const quoteSymbols = Object.keys(chain.tokens).filter((s) => s !== chain.baseToken)
  const results = []

  for (const symbol of quoteSymbols) {
    const quote = await loadToken(symbol, chain.tokens[symbol], provider, cache)

    for (const fee of FEE_TIERS) {
      const pools = (await Promise.all(
        exchanges.map(async (exchange) => {
          try {
            const pool = await readPool(exchange, base, quote, fee, provider)
            return pool ? { pool, exchange } : null
          } catch {
            return null
          }
        })
      )).filter(Boolean)

      // Needs at least two venues hosting the same pool to arbitrage between.
      if (pools.length < 2) continue

      // Every unordered venue combination.
      for (let i = 0; i < pools.length; i++) {
        for (let j = i + 1; j < pools.length; j++) {
          const a = pools[i]
          const b = pools[j]

          const spreadBps = Number(
            a.pool.price.minus(b.pool.price).div(b.pool.price).times(10000).toFixed(2)
          )

          // Buy where the quote token is cheaper in base terms.
          const [buy, sell] = spreadBps >= 0 ? [b, a] : [a, b]

          let best = null
          if (buy.exchange.hasQuoter && sell.exchange.hasQuoter) {
            const cap = buy.pool.baseBalance < sell.pool.baseBalance
              ? buy.pool.baseBalance
              : sell.pool.baseBalance

            best = await findOptimalTradeSize({
              quote: makeRoundTrip(buy.exchange, sell.exchange, base, quote, fee),
              min: minSize,
              max: maxSize < cap ? maxSize : cap,
              costs: gasCost,
            })
          }

          results.push({
            pair: `${base.symbol}/${quote.symbol}`,
            fee,
            venues: `${buy.exchange.name} -> ${sell.exchange.name}`,
            spreadBps,
            feeFloorBps: (fee / 100) * 2,
            quotable: buy.exchange.hasQuoter && sell.exchange.hasQuoter,
            best,
            pools: [a.pool, b.pool],
          })
        }
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify(results, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2))
    return
  }

  report(results, base, gasCost)
}

function report(results, base, gasCost) {
  if (results.length === 0) {
    console.log("No pair had a pool on two or more venues. Nothing to arbitrage here.\n")
    return
  }

  const fmt = (amount, decimals = base.decimals) =>
    Number(ethers.formatUnits(amount, decimals)).toLocaleString(undefined, { maximumFractionDigits: 5 })

  console.log(`${results.length} venue pairings found across ${new Set(results.map((r) => r.pair)).size} pairs\n`)

  const sorted = [...results].sort((a, b) => {
    const av = a.best ? a.best.netProfit : -(2n ** 255n)
    const bv = b.best ? b.best.netProfit : -(2n ** 255n)
    return bv > av ? 1 : bv < av ? -1 : 0
  })

  console.log("Pair          Fee    Spread      Floor   Net (optimally sized)   Route")
  console.log("-".repeat(96))

  for (const r of sorted) {
    const net = !r.quotable
      ? "spread only"
      : r.best === null
        ? "no fillable size"
        : `${r.best.netProfit > 0n ? "+" : ""}${fmt(r.best.netProfit)} @ ${fmt(r.best.amountIn)}`

    console.log(
      `${r.pair.padEnd(13)} ${String(r.fee).padEnd(6)} ` +
      `${(r.spreadBps.toFixed(1) + "bps").padEnd(11)} ` +
      `${(r.feeFloorBps.toFixed(0) + "bps").padEnd(7)} ${net.padEnd(23)} ${r.venues}`
    )
  }

  console.log()

  const winners = sorted.filter((r) => r.best && r.best.netProfit > 0n)

  if (winners.length === 0) {
    console.log(
      "Nothing clears fees + gas right now. That is the normal resting state of an\n" +
      "efficient market -- edges open for a block or two after a large swap. Use the\n" +
      "spread column to shortlist pairs, then leave bot.js watching them.\n"
    )
    return
  }

  console.log(`Clears fees AND gas right now (gas ~${fmt(gasCost)} ${base.symbol}):\n`)

  for (const r of winners) {
    console.log(`  ${r.pair} @ ${r.fee}  --  ${r.venues}`)
    console.log(`    size ${fmt(r.best.amountIn)} ${base.symbol} -> net ${fmt(r.best.netProfit)} ${base.symbol} (${r.best.probes} probes)`)
    for (const pool of r.pools) {
      const depth = pool.balances.map((b) => `${b.symbol} ${fmt(b.amount, b.decimals)}`).join(", ")
      console.log(`    ${pool.venue.padEnd(16)} ${pool.address} (${depth})`)
    }
    console.log()
  }

  console.log(
    "Necessary but not sufficient: by the time you land a transaction a faster\n" +
    "searcher may already have taken it. Treat this as a watchlist, not a promise.\n"
  )
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nScan failed: ${error.message}\n`)
    process.exit(1)
  })
}

module.exports = { priceFromSqrtX96, parseArgs, report, readPool, makeRoundTrip }
