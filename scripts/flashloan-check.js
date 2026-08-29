/**
 * Flash-loan availability and capacity check.
 *
 * "Is the provider deployed here" is the easy half of the question. The half
 * that actually decides whether a trade can happen is "how much can it lend
 * me right now", and for Balancer that changed materially: the V2 vault was
 * exploited for ~$128M in November 2025, TVL fell by roughly two thirds, and
 * Balancer Labs wound down in March 2026. The vault is immutable so it still
 * functions, but its balance is what caps your trade size.
 *
 * Balancer lends whatever the vault holds, fee-free. Aave charges 5bps but is
 * actively maintained. This prints both so the choice is made on numbers.
 *
 *   node scripts/flashloan-check.js            # every configured chain
 *   node scripts/flashloan-check.js base
 */

require("dotenv").config()

const ethers = require("ethers")
const chains = require("../config/chains.json")

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]

// getReservesList is stable across every Aave V3 minor version, unlike
// getReserveData whose struct changed in 3.2. Listing is what determines
// whether an asset can be flash loaned at all.
const AAVE_POOL_ABI = [
  "function getReservesList() view returns (address[])",
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
]

async function hasCode(provider, address) {
  if (!address) return false
  try {
    return (await provider.getCode(address)) !== "0x"
  } catch {
    return false
  }
}

async function checkChain(key, chain) {
  const rpcUrl = process.env[chain.rpcEnv] || chain.defaultRpc
  const provider = new ethers.JsonRpcProvider(rpcUrl)

  console.log(`\n${"=".repeat(72)}`)
  console.log(`${chain.label}  (${key})`)
  console.log("=".repeat(72))

  let network
  try {
    network = await provider.getNetwork()
  } catch (error) {
    console.log(`  UNREACHABLE via ${rpcUrl}`)
    console.log(`  ${error.shortMessage || error.message}`)
    console.log(`  Set ${chain.rpcEnv} to a working endpoint.`)
    return
  }

  if (Number(network.chainId) !== chain.chainId) {
    console.log(`  WRONG CHAIN: RPC reports ${network.chainId}, config expects ${chain.chainId}`)
    return
  }

  const baseAddress = chain.tokens[chain.baseToken]
  const token = new ethers.Contract(baseAddress, ERC20_ABI, provider)

  let symbol = chain.baseToken
  let decimals = 18
  try {
    ;[symbol, decimals] = await Promise.all([token.symbol(), token.decimals()])
    decimals = Number(decimals)
  } catch {
    console.log(`  WARNING: could not read ${chain.baseToken} at ${baseAddress}`)
  }

  console.log(`  RPC:        ${rpcUrl}`)
  console.log(`  Base token: ${symbol} (${baseAddress})\n`)

  const fmt = (v) => Number(ethers.formatUnits(v, decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })

  // -- BALANCER V2 -- //
  const vault = chain.flashLoan?.balancerVault
  console.log(`  Balancer V2 vault`)

  if (!(await hasCode(provider, vault))) {
    console.log(`    NOT DEPLOYED (${vault || "no address configured"})`)
  } else {
    try {
      // The vault lends from its own token balance, so this is literally the
      // maximum single flash loan available.
      const held = await token.balanceOf(vault)
      console.log(`    deployed at ${vault}`)
      console.log(`    fee:      0 bps`)
      console.log(`    capacity: ${fmt(held)} ${symbol}`)
      if (held === 0n) {
        console.log(`    -> vault holds no ${symbol}. Flash loans of this token are impossible here.`)
      }
    } catch (error) {
      console.log(`    deployed, but balance read failed: ${error.shortMessage || error.message}`)
    }
  }

  // -- AAVE V3 -- //
  const aavePool = chain.flashLoan?.aavePool
  console.log(`\n  Aave V3 pool`)

  if (!(await hasCode(provider, aavePool))) {
    console.log(`    NOT DEPLOYED (${aavePool || "no address configured"})`)
  } else {
    const pool = new ethers.Contract(aavePool, AAVE_POOL_ABI, provider)
    console.log(`    deployed at ${aavePool}`)

    try {
      const premium = await pool.FLASHLOAN_PREMIUM_TOTAL()
      console.log(`    fee:      ${premium} bps (reported on-chain)`)
    } catch {
      console.log(`    fee:      ${chain.flashLoan?.aaveFeeBps ?? "?"} bps (from config; on-chain read failed)`)
    }

    try {
      const reserves = await pool.getReservesList()
      const listed = reserves.some((r) => r.toLowerCase() === baseAddress.toLowerCase())
      console.log(`    reserves: ${reserves.length} assets listed`)
      console.log(`    ${symbol}: ${listed ? "LISTED -- flash loanable" : "NOT LISTED -- cannot flash loan this token here"}`)
    } catch (error) {
      console.log(`    reserve list read failed: ${error.shortMessage || error.message}`)
      console.log(`    (address may not be an Aave V3 Pool -- verify at https://aave.com/docs/resources/addresses)`)
    }
  }

  console.log(`\n  Contract to deploy: ${vault ? "Arbitrage.sol (Balancer) or " : ""}ArbitrageAave.sol (Aave)`)
}

async function main() {
  const only = process.argv[2]
  const keys = Object.keys(chains).filter((k) => !k.startsWith("_"))

  if (only && !keys.includes(only)) {
    console.error(`Usage: node scripts/flashloan-check.js [${keys.join("|")}]`)
    process.exit(1)
  }

  for (const key of only ? [only] : keys) {
    await checkChain(key, chains[key])
  }

  console.log(`\n${"=".repeat(72)}`)
  console.log("Capacity is the number that matters. A provider being deployed means")
  console.log("nothing if it holds none of the token you want to borrow.")
  console.log(`${"=".repeat(72)}\n`)
}

main().catch((error) => {
  console.error(`\nCheck failed: ${error.message}\n`)
  process.exit(1)
})
