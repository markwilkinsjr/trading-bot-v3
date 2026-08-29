// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

/**
 * Aave V3 flash-loan variant of Arbitrage.sol.
 *
 * Balancer V2 was exploited for ~$128M in November 2025 and Balancer Labs wound
 * down as a corporate entity in March 2026. The V2 vault is immutable so it
 * still functions, but its TVL fell by roughly two thirds, which directly caps
 * how much you can flash loan from it, and the code is now unmaintained.
 *
 * Aave V3 charges a 0.05% premium where Balancer charged nothing, but it is
 * actively maintained, deeply funded, and deployed on every chain this bot
 * targets. On a trade whose edge is thinner than 5bps you had no business
 * trading anyway.
 *
 * The Pool address differs per chain, so it is a constructor argument rather
 * than a constant. Get it from https://aave.com/docs/resources/addresses
 */
// Declared inline rather than imported: OpenZeppelin v5 requires solc >=0.8.20
// and this project is pinned to 0.8.18 to match Arbitrage.sol.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

contract ArbitrageAave {
    IPool public immutable pool;
    address public owner;

    struct Trade {
        address[] routerPath;
        address[] tokenPath;
        uint24 fee;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _pool) {
        pool = IPool(_pool);
        owner = msg.sender;
    }

    /**
     * Restricted to the owner. Without this, anyone could call in with an
     * attacker-controlled `routerPath` and have this contract approve tokens to
     * it. The flash-loan repayment would revert the whole transaction, so funds
     * were never truly at risk, but there is no reason to leave it open.
     */
    function executeTrade(
        address[] memory _routerPath,
        address[] memory _tokenPath,
        uint24 _fee,
        uint256 _flashAmount
    ) external onlyOwner {
        bytes memory data = abi.encode(
            Trade({routerPath: _routerPath, tokenPath: _tokenPath, fee: _fee})
        );

        pool.flashLoanSimple(address(this), _tokenPath[0], _flashAmount, data, 0);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(pool), "caller must be pool");
        require(initiator == address(this), "initiator must be this contract");

        Trade memory trade = abi.decode(params, (Trade));

        // Aave pulls back principal + premium, so both legs must clear that.
        uint256 owed = amount + premium;

        // Buy the quote token on the first exchange.
        _swapOnV3(
            trade.routerPath[0],
            trade.tokenPath[0],
            amount,
            trade.tokenPath[1],
            0,
            trade.fee
        );

        // Sell it back on the second, requiring at least what we owe.
        _swapOnV3(
            trade.routerPath[1],
            trade.tokenPath[1],
            IERC20(trade.tokenPath[1]).balanceOf(address(this)),
            trade.tokenPath[0],
            owed,
            trade.fee
        );

        // Aave transfers the repayment out of this contract itself.
        IERC20(asset).approve(address(pool), owed);

        return true;
    }

    /**
     * Profit is swept separately rather than inside the callback, because the
     * repayment has not been pulled yet while executeOperation is running.
     */
    function withdraw(address _token) external onlyOwner {
        IERC20(_token).transfer(owner, IERC20(_token).balanceOf(address(this)));
    }

    // -- INTERNAL FUNCTIONS -- //

    function _swapOnV3(
        address _router,
        address _tokenIn,
        uint256 _amountIn,
        address _tokenOut,
        uint256 _amountOut,
        uint24 _fee
    ) internal {
        IERC20(_tokenIn).approve(_router, _amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter
            .ExactInputSingleParams({
                tokenIn: _tokenIn,
                tokenOut: _tokenOut,
                fee: _fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: _amountIn,
                amountOutMinimum: _amountOut,
                sqrtPriceLimitX96: 0
            });

        ISwapRouter(_router).exactInputSingle(params);
    }
}
