/**
 * Pair scanner.
 *
 * Answers the only question that matters before you point the bot at a market:
 * for a given chain, which token pairs actually have a pool on BOTH exchanges,
 * how far apart are the prices right now, and does a round-trip through the
 * quoters clear the swap fees and gas?
 *
 * It never sends a transaction. Every call is a read or an eth_call.
 *
 *   node scripts/scan.js base
 *   node scripts/scan.js arbitrum --sizes 0.05,0.1,0.5
 *   BASE_RPC_URL=https://... node scripts/scan.js base
 */

require("dotenv").config()

const ethers = require("ethers")
const Big = require("big.js")

const chains = require("../config/chains.json")

// sqrtPriceX96 squaring needs far more precision than the Big.js default of 20.
Big.DP = 60

const IUniswapV3Factory = require("@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json")
const IQuoterV2 = require("@uniswap/v3-periphery/artifacts/contracts/interfaces/IQuoterV2.sol/IQuoterV2.json")
const IERC20 = require("@openzeppelin/contracts/build/contracts/ERC20.json")

// Minimal pool ABI. Deliberately not the full Uniswap artifact: PancakeSwap's
// slot0 returns a different tuple, and these four getters are identical on both.
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidity() view returns (uint128)",
]

const FEE_TIERS = [100, 500, 2500, 3000, 10000]
const DEFAULT_SIZES = [0.01, 0.05, 0.1, 0.5, 1]

// -- ARGUMENTS -- //

function parseArgs(argv) {
  const args = { chain: null, sizes: DEFAULT_SIZES, minEdgeBps: 0 }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === "--sizes") {
      args.sizes = argv[++i].split(",").map(Number).filter((n) => n > 0)
    } else if (arg === "--min-edge-bps") {
      args.minEdgeBps = Number(argv[++i])
    } else if (!arg.startsWith("--")) {
      args.chain = arg
    }
  }

  return args
}

// -- PRICE MATH -- //

const Q96 = Big(2).pow(96)

/**
 * Uniswap V3 stores sqrt(reserve1/reserve0) * 2^96 in raw token units.
 * Squaring it gives raw token1 per raw token0; the decimal shift converts that
 * into human token1 per 1 human token0.
 */
function priceFromSqrtX96(sqrtPriceX96, decimals0, decimals1) {
  const ratio = Big(sqrtPriceX96.toString()).div(Q96)
  return ratio.times(ratio).times(Big(10).pow(Number(decimals0) - Number(decimals1)))
}

// -- ON-CHAIN READS -- //

async function loadToken(address, provider, cache) {
  const key = address.toLowerCase()
  if (cache.has(key)) return cache.get(key)

  const contract = new ethers.Contract(address, IERC20.abi, provider)
  const token = {
    contract,
    address,
    symbol: await contract.symbol(),
    decimals: Number(await contract.decimals()),
  }

  cache.set(key, token)
  return token
}

/**
 * Reads a pool's live price. Returns null when the factory reports no pool.
 *
 * The price is always oriented as "pool token1 per pool token0" using the
 * pool's own ordering, so the two exchanges are directly comparable regardless
 * of how the caller happened to order the pair.
 */
async function readPool(exchange, tokenA, tokenB, fee, provider) {
  const poolAddress = await exchange.factory.getPool(tokenA.address, tokenB.address, fee)

  if (poolAddress === ethers.ZeroAddress) return null

  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider)

  const [slot0, liquidity, token0Address] = await Promise.all([
    pool.slot0(),
    pool.liquidity(),
    pool.token0(),
  ])

  if (slot0.sqrtPriceX96 === 0n) return null

  // Orient decimals by the pool's ordering, not the caller's.
  const zeroIsA = token0Address.toLowerCase() === tokenA.address.toLowerCase()
  const token0 = zeroIsA ? tokenA : tokenB
  const token1 = zeroIsA ? tokenB : tokenA

  const [balance0, balance1] = await Promise.all([
    token0.contract.balanceOf(poolAddress),
    token1.contract.balanceOf(poolAddress),
  ])

  return {
    address: poolAddress,
    price: priceFromSqrtX96(slot0.sqrtPriceX96, token0.decimals, token1.decimals),
    liquidity,
    balances: [
      { symbol: token0.symbol, amount: balance0, decimals: token0.decimals },
      { symbol: token1.symbol, amount: balance1, decimals: token1.decimals },
    ],
  }
}

/**
 * Simulates the actual arbitrage: spend `amountIn` of the base token on `buyOn`,
 * then sell the proceeds back on `sellOn`. Returns the signed profit in base
 * token units. This is the honest number -- it includes both pools' swap fees
 * and the price impact of the trade itself, which a raw spread does not.
 */
async function quoteRoundTrip(buyOn, sellOn, base, quote, fee, amountIn) {
  const [bought] = await buyOn.quoter.quoteExactInputSingle.staticCall({
    tokenIn: base.address,
    tokenOut: quote.address,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0,
  })

  if (bought === 0n) return null

  const [returned] = await sellOn.quoter.quoteExactInputSingle.staticCall({
    tokenIn: quote.address,
    tokenOut: base.address,
    amountIn: bought,
    fee,
    sqrtPriceLimitX96: 0,
  })

  return returned - amountIn
}

// -- PREFLIGHT -- //

/**
 * A mistyped factory address silently returns the zero address for every pool,
 * which looks exactly like "no pools exist". Fail loudly instead.
 */
async function preflight(chain, provider) {
  const network = await provider.getNetwork()

  if (Number(network.chainId) !== chain.chainId) {
    throw new Error(
      `RPC is chain ${network.chainId}, but config expects ${chain.chainId} (${chain.label}). ` +
      `Check your RPC URL.`
    )
  }

  for (const [name, exchange] of Object.entries(chain.exchanges)) {
    for (const [role, address] of Object.entries(exchange)) {
      const code = await provider.getCode(address)

      if (code === "0x") {
        throw new Error(
          `${name} ${role} (${address}) has no contract code on ${chain.label}. ` +
          `Verify it against the protocol's official deployment list.`
        )
      }
    }
  }

  if (!chain.balancerVault) {
    console.log(
      `NOTE: no Balancer vault configured for ${chain.label}. Arbitrage.sol flash ` +
      `loans from Balancer, so it will not deploy usefully here without swapping ` +
      `in another flash-loan provider.\n`
    )
  }
}

// -- REPORTING -- //

function formatUsdish(amount, decimals) {
  return Number(ethers.formatUnits(amount, decimals)).toLocaleString(undefined, {
    maximumFractionDigits: 4,
  })
}

async function estimateGasCost(provider, gasLimit) {
  const feeData = await provider.getFeeData()
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice

  if (!gasPrice) return null

  return gasPrice * BigInt(gasLimit)
}

// -- MAIN -- //

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const chain = chains[args.chain]

  if (!chain) {
    const names = Object.keys(chains).filter((k) => !k.startsWith("_"))
    console.error(`Usage: node scripts/scan.js <${names.join("|")}> [--sizes 0.1,1] [--min-edge-bps 5]`)
    process.exit(1)
  }

  const rpcUrl = process.env[chain.rpcEnv] || chain.defaultRpc
  const provider = new ethers.JsonRpcProvider(rpcUrl)

  console.log(`\nScanning ${chain.label} via ${rpcUrl}\n`)

  await preflight(chain, provider)

  const exchanges = Object.entries(chain.exchanges).map(([name, addresses]) => ({
    name,
    factory: new ethers.Contract(addresses.factory, IUniswapV3Factory.abi, provider),
    quoter: new ethers.Contract(addresses.quoter, IQuoterV2.abi, provider),
  }))

  if (exchanges.length < 2) {
    throw new Error(`${chain.label} needs at least two exchanges configured to compare.`)
  }

  const cache = new Map()
  const base = await loadToken(chain.tokens[chain.baseToken], provider, cache)

  const gasCost = await estimateGasCost(provider, chain.gasLimitEstimate)
  const gasCostLabel = gasCost === null
    ? "unknown"
    : `${ethers.formatUnits(gasCost, 18)} ${chain.nativeSymbol}`

  console.log(`Base token: ${base.symbol}`)
  console.log(`Gas budget: ${chain.gasLimitEstimate} gas -> ~${gasCostLabel} per attempt`)
  console.log(`Trade sizes: ${args.sizes.join(", ")} ${base.symbol}\n`)

  const quotes = Object.entries(chain.tokens).filter(([symbol]) => symbol !== chain.baseToken)
  const results = []

  for (const [symbol, address] of quotes) {
    const quote = await loadToken(address, provider, cache)

    for (const fee of FEE_TIERS) {
      let pools

      try {
        pools = await Promise.all(
          exchanges.map((exchange) => readPool(exchange, base, quote, fee, provider))
        )
      } catch (error) {
        console.log(`  ${base.symbol}/${symbol} @ ${fee}: read failed (${error.shortMessage || error.message})`)
        continue
      }

      // Both venues must actually host the pair, otherwise there is nothing to
      // arbitrage between. This is where most candidate pairs drop out.
      if (pools.some((pool) => pool === null)) continue

      const [priceA, priceB] = pools.map((pool) => pool.price)
      const spreadBps = Number(priceA.minus(priceB).div(priceB).times(10000).toFixed(2))

      // Round-trip fee floor: you pay the fee tier on both legs.
      const feeFloorBps = (fee / 100) * 2

      let best = null

      for (const size of args.sizes) {
        const amountIn = ethers.parseUnits(String(size), base.decimals)

        // Buy where the quote token is cheaper, sell where it is dearer.
        const [buyOn, sellOn] = spreadBps >= 0
          ? [exchanges[1], exchanges[0]]
          : [exchanges[0], exchanges[1]]

        let profit
        try {
          profit = await quoteRoundTrip(buyOn, sellOn, base, quote, fee, amountIn)
        } catch {
          // Quoter reverts on pools too thin to fill the size. Expected; skip.
          continue
        }

        if (profit === null) continue
        if (best === null || profit > best.profit) {
          best = { size, profit, buyOn: buyOn.name, sellOn: sellOn.name }
        }
      }

      results.push({
        pair: `${base.symbol}/${symbol}`,
        fee,
        spreadBps,
        feeFloorBps,
        pools,
        best,
      })
    }
  }

  report(results, base, chain, gasCost, args)
}

function report(results, base, chain, gasCost, args) {
  if (results.length === 0) {
    console.log("No pair had a pool on both exchanges. Nothing to arbitrage here.\n")
    return
  }

  const tradable = results.filter((r) => r.best !== null)

  console.log(`Pairs with pools on both venues: ${results.length}`)
  console.log(`Pairs where a round-trip quote filled: ${tradable.length}\n`)

  console.log("Pair            Fee    Spread     Fee floor   Best net (round trip)")
  console.log("-".repeat(78))

  const sorted = [...results].sort((a, b) => {
    const aProfit = a.best ? a.best.profit : -(2n ** 255n)
    const bProfit = b.best ? b.best.profit : -(2n ** 255n)
    return bProfit > aProfit ? 1 : bProfit < aProfit ? -1 : 0
  })

  for (const r of sorted) {
    const net = r.best === null
      ? "no fill"
      : `${r.best.profit > 0n ? "+" : ""}${formatUsdish(r.best.profit, base.decimals)} ${base.symbol} @ ${r.best.size}`

    console.log(
      `${r.pair.padEnd(15)} ${String(r.fee).padEnd(6)} ` +
      `${(r.spreadBps.toFixed(1) + "bps").padEnd(10)} ` +
      `${(r.feeFloorBps.toFixed(0) + "bps").padEnd(11)} ${net}`
    )
  }

  console.log()

  const winners = tradable.filter((r) => {
    if (r.best.profit <= 0n) return false
    if (gasCost !== null && r.best.profit <= gasCost) return false
    return Math.abs(r.spreadBps) >= args.minEdgeBps
  })

  if (winners.length === 0) {
    console.log(
      "Nothing clears fees + gas right now. That is the normal resting state of an\n" +
      "efficient market -- opportunities appear for a block or two after a large swap.\n" +
      "Re-run this during volatile periods, or leave bot.js watching the best pairs above.\n"
    )
    return
  }

  console.log("Clears fees AND gas right now:\n")

  for (const r of winners) {
    console.log(`  ${r.pair} @ ${r.fee}`)
    console.log(`    buy on ${r.best.buyOn}, sell on ${r.best.sellOn}`)
    console.log(`    net ${formatUsdish(r.best.profit, base.decimals)} ${base.symbol} on ${r.best.size} ${base.symbol}`)

    for (const pool of r.pools) {
      const depth = pool.balances
        .map(({ symbol, amount, decimals }) => `${symbol} ${formatUsdish(amount, decimals)}`)
        .join(", ")
      console.log(`    pool ${pool.address} (~${depth})`)
    }

    console.log()
  }

  console.log(
    "A positive number here is necessary but not sufficient: by the time you land a\n" +
    "transaction, a faster searcher may already have taken it. Treat this as a list of\n" +
    "pairs worth watching, not as guaranteed profit.\n"
  )
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nScan failed: ${error.message}\n`)
    process.exit(1)
  })
}

module.exports = { priceFromSqrtX96, parseArgs, report, quoteRoundTrip, readPool }
