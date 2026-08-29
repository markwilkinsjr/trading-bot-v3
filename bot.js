// -- HANDLE INITIAL SETUP -- //
require("dotenv").config()
require('./helpers/server')

const Big = require('big.js')

const ethers = require("ethers")
const config = require('./config.json')
const { getTokenAndContract, getPoolContract, getPoolLiquidity, calculatePrice } = require('./helpers/helpers')
const { provider, uniswap, pancakeswap, arbitrage } = require('./helpers/initialization')
const { findOptimalTradeSize } = require('./helpers/profitability')

// -- CONFIGURATION VALUES HERE -- //
const ARB_FOR = config.TOKENS.ARB_FOR
const ARB_AGAINST = config.TOKENS.ARB_AGAINST
const POOL_FEE = config.TOKENS.POOL_FEE
const UNITS = config.PROJECT_SETTINGS.PRICE_UNITS
const PRICE_DIFFERENCE = config.PROJECT_SETTINGS.PRICE_DIFFERENCE
const GAS_LIMIT = config.PROJECT_SETTINGS.GAS_LIMIT
const GAS_PRICE = config.PROJECT_SETTINGS.GAS_PRICE

// Trade sizing. GAS_PRICE above is only used for display; the profitability
// check prices gas live off the provider.
const MIN_TRADE_SIZE = config.PROJECT_SETTINGS.MIN_TRADE_SIZE
const MIN_PROFIT = config.PROJECT_SETTINGS.MIN_PROFIT
const MAX_POOL_FRACTION_BPS = config.PROJECT_SETTINGS.MAX_POOL_FRACTION_BPS
const FLASH_LOAN_FEE_BPS = config.PROJECT_SETTINGS.FLASH_LOAN_FEE_BPS

let isExecuting = false

const main = async () => {
  const { token0, token1 } = await getTokenAndContract(ARB_FOR, ARB_AGAINST, provider)
  const uPool = await getPoolContract(uniswap, token0.address, token1.address, POOL_FEE, provider)
  const pPool = await getPoolContract(pancakeswap, token0.address, token1.address, POOL_FEE, provider)

  console.log(`Using ${token1.symbol}/${token0.symbol}\n`)

  console.log(`Uniswap Pool Address: ${await uPool.getAddress()}`)
  console.log(`Pancakeswap Pool Address: ${await pPool.getAddress()}\n`)

  uPool.on('Swap', () => eventHandler(uPool, pPool, token0, token1))
  pPool.on('Swap', () => eventHandler(uPool, pPool, token0, token1))

  console.log("Waiting for swap event...\n")
}

const eventHandler = async (_uPool, _pPool, _token0, _token1) => {
  if (!isExecuting) {
    isExecuting = true

    const priceDifference = await checkPrice([_uPool, _pPool], _token0, _token1)
    const exchangePath = await determineDirection(priceDifference)

    if (!exchangePath) {
      console.log(`No Arbitrage Currently Available\n`)
      console.log(`-----------------------------------------\n`)
      isExecuting = false
      return
    }

    const { isProfitable, amount } = await determineProfitability(exchangePath, _token0, _token1)

    if (!isProfitable) {
      console.log(`No Arbitrage Currently Available\n`)
      console.log(`-----------------------------------------\n`)
      isExecuting = false
      return
    }

    const receipt = await executeTrade(exchangePath, _token0, _token1, amount)

    isExecuting = false

    console.log("\nWaiting for swap event...\n")
  }
}

const checkPrice = async (_pools, _token0, _token1) => {
  isExecuting = true

  console.log(`Swap Detected, Checking Price...\n`)

  const currentBlock = await provider.getBlockNumber()

  const uPrice = await calculatePrice(_pools[0], _token0, _token1)
  const pPrice = await calculatePrice(_pools[1], _token0, _token1)

  const uFPrice = Number(uPrice).toFixed(UNITS)
  const pFPrice = Number(pPrice).toFixed(UNITS)
  const priceDifference = (((uFPrice - pFPrice) / pFPrice) * 100).toFixed(2)

  console.log(`Current Block: ${currentBlock}`)
  console.log(`-----------------------------------------`)
  console.log(`UNISWAP     | ${_token1.symbol}/${_token0.symbol}\t | ${uFPrice}`)
  console.log(`PANCAKESWAP | ${_token1.symbol}/${_token0.symbol}\t | ${pFPrice}\n`)
  console.log(`Percentage Difference: ${priceDifference}%\n`)

  return priceDifference
}

const determineDirection = async (_priceDifference) => {
  console.log(`Determining Direction...\n`)

  if (_priceDifference >= PRICE_DIFFERENCE) {

    console.log(`Potential Arbitrage Direction:\n`)
    console.log(`Buy\t -->\t ${uniswap.name}`)
    console.log(`Sell\t -->\t ${pancakeswap.name}\n`)
    return [uniswap, pancakeswap]

  } else if (_priceDifference <= -(PRICE_DIFFERENCE)) {

    console.log(`Potential Arbitrage Direction:\n`)
    console.log(`Buy\t -->\t ${pancakeswap.name}`)
    console.log(`Sell\t -->\t ${uniswap.name}\n`)
    return [pancakeswap, uniswap]

  } else {
    return null
  }
}

const determineProfitability = async (_exchangePath, _token0, _token1) => {
  console.log(`Determining Profitability...\n`)

  try {
    /**
     * One round trip: spend `amountIn` of token0 buying token1 on the first
     * exchange, then sell that token1 back for token0 on the second. Both
     * quoters price their leg including the pool fee and the impact of this
     * exact size, so the number that comes back is what the trade would really
     * return -- not a spread reading that ignores its own footprint.
     */
    const quote = async (amountIn) => {
      const [bought] = await _exchangePath[0].quoter.quoteExactInputSingle.staticCall({
        tokenIn: _token0.address,
        tokenOut: _token1.address,
        amountIn,
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0,
      })

      if (bought === 0n) throw new Error("buy leg quoted zero")

      const [returned] = await _exchangePath[1].quoter.quoteExactInputSingle.staticCall({
        tokenIn: _token1.address,
        tokenOut: _token0.address,
        amountIn: bought,
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0,
      })

      return returned
    }

    // Bound the search by what the pools hold. Taking a large fraction of a pool
    // moves the price against you faster than the edge grows, and the flash loan
    // has to be repaid regardless.
    const [buyLiquidity, sellLiquidity] = await Promise.all([
      getPoolLiquidity(_exchangePath[0].factory, _token0, _token1, POOL_FEE, provider),
      getPoolLiquidity(_exchangePath[1].factory, _token0, _token1, POOL_FEE, provider),
    ])

    const thinnest = buyLiquidity[0] < sellLiquidity[0] ? buyLiquidity[0] : sellLiquidity[0]
    const maxSize = (thinnest * BigInt(MAX_POOL_FRACTION_BPS)) / 10000n
    const minSize = ethers.parseUnits(String(MIN_TRADE_SIZE), _token0.decimals)

    if (maxSize <= minSize) {
      console.log(`Pools too thin to trade (cap ${ethers.formatUnits(maxSize, _token0.decimals)} ${_token0.symbol})\n`)
      return { isProfitable: false, amount: 0n }
    }

    // Price gas live rather than from a hardcoded constant. This assumes token0
    // is the chain's wrapped gas token, which holds for the pairs this bot
    // targets (WETH/*, WBNB/*, WAVAX/*). Trading a non-gas base token would
    // need a conversion here.
    const feeData = await provider.getFeeData()
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n
    const gasCost = gasPrice * BigInt(GAS_LIMIT)

    const best = await findOptimalTradeSize({
      quote,
      min: minSize,
      max: maxSize,
      costs: gasCost,
      flashLoanFeeBps: FLASH_LOAN_FEE_BPS,
    })

    if (!best) {
      console.log(`No fillable trade size between ${ethers.formatUnits(minSize, _token0.decimals)} and ${ethers.formatUnits(maxSize, _token0.decimals)} ${_token0.symbol}\n`)
      return { isProfitable: false, amount: 0n }
    }

    const minProfit = ethers.parseUnits(String(MIN_PROFIT), _token0.decimals)
    const premium = (best.amountIn * BigInt(FLASH_LOAN_FEE_BPS)) / 10000n
    const show = (value) => ethers.formatUnits(value, _token0.decimals)

    console.table({
      'Optimal size': `${show(best.amountIn)} ${_token0.symbol}`,
      'Returned': `${show(best.amountOut)} ${_token0.symbol}`,
      'Gross profit': show(best.grossProfit),
      'Flash loan fee': show(premium),
      'Gas cost': show(gasCost),
      'NET PROFIT': show(best.netProfit),
      'Required minimum': show(minProfit),
      'Quoter probes': best.probes,
    })
    console.log()

    if (best.netProfit < minProfit) {
      console.log(`Below minimum profit threshold\n`)
      return { isProfitable: false, amount: 0n }
    }

    return { isProfitable: true, amount: best.amountIn }

  } catch (error) {
    console.log(`Profitability check failed: ${error.shortMessage || error.message}\n`)
    return { isProfitable: false, amount: 0n }
  }
}

const executeTrade = async (_exchangePath, _token0, _token1, _amount) => {
  console.log(`Attempting Arbitrage...\n`)

  const routerPath = [
    await _exchangePath[0].router.getAddress(),
    await _exchangePath[1].router.getAddress()
  ]

  const tokenPath = [
    _token0.address,
    _token1.address
  ]

  // Create Signer
  const account = new ethers.Wallet(process.env.PRIVATE_KEY, provider)

  // Fetch token balances before
  const tokenBalanceBefore = await _token0.contract.balanceOf(account.address)
  const ethBalanceBefore = await provider.getBalance(account.address)

  if (config.PROJECT_SETTINGS.isDeployed) {
    const transaction = await arbitrage.connect(account).executeTrade(
      routerPath,
      tokenPath,
      POOL_FEE,
      _amount
    )

    const receipt = await transaction.wait(0)
  }

  console.log(`Trade Complete:\n`)

  // Fetch token balances after
  const tokenBalanceAfter = await _token0.contract.balanceOf(account.address)
  const ethBalanceAfter = await provider.getBalance(account.address)

  const tokenBalanceDifference = tokenBalanceAfter - tokenBalanceBefore
  const ethBalanceDifference = ethBalanceBefore - ethBalanceAfter

  const data = {
    'ETH Balance Before': ethers.formatUnits(ethBalanceBefore, 18),
    'ETH Balance After': ethers.formatUnits(ethBalanceAfter, 18),
    'ETH Spent (gas)': ethers.formatUnits(ethBalanceDifference.toString(), 18),
    '-': {},
    'WETH Balance BEFORE': ethers.formatUnits(tokenBalanceBefore, _token0.decimals),
    'WETH Balance AFTER': ethers.formatUnits(tokenBalanceAfter, _token0.decimals),
    'WETH Gained/Lost': ethers.formatUnits(tokenBalanceDifference.toString(), _token0.decimals),
    '-': {},
    'Total Gained/Lost': `${ethers.formatUnits((tokenBalanceDifference - ethBalanceDifference).toString(), _token0.decimals)}`
  }

  console.table(data)
}

main()