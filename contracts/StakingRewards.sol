// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title StakingRewards
 * @notice Stake token A, earn token B. Rewards are streamed at a constant rate during a reward
 *         period and split between stakers proportionally to their stake and staking time.
 *
 * Accounting ("reward per token" model):
 *  - `rewardPerTokenStored` grows over time by `rewardRate * dt / totalStaked`.
 *  - Each user stores the value it had when their balance last changed (`userRewardPerTokenPaid`).
 *  - A user's earnings = balance * (current rewardPerToken - userRewardPerTokenPaid) + rewards.
 *  This makes every operation O(1) no matter how many stakers there are.
 *
 * Safety:
 *  - The owner can't start a period that isn't fully funded by the contract's reward balance.
 *  - Staked tokens can never be withdrawn by the owner (`recoverERC20` refuses the staking token).
 *  - Pausing only blocks new stakes; users can always withdraw and claim.
 */
contract StakingRewards is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 private constant PRECISION = 1e18;

    IERC20 public immutable stakingToken;
    IERC20 public immutable rewardsToken;

    /// @notice End of the current reward period.
    uint256 public periodFinish;
    /// @notice Reward tokens distributed per second.
    uint256 public rewardRate;
    /// @notice Last time the reward accumulator was updated.
    uint256 public lastUpdateTime;
    /// @notice Accumulated rewards per staked token, scaled by 1e18.
    uint256 public rewardPerTokenStored;

    uint256 public totalStaked;
    mapping(address account => uint256) public balanceOf;
    mapping(address account => uint256) public userRewardPerTokenPaid;
    mapping(address account => uint256) public rewards;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(uint256 reward, uint256 duration);
    event Recovered(address token, uint256 amount);

    error ZeroAmount();
    error ZeroDuration();
    error InsufficientBalance();
    error RewardTooHigh();
    error CannotRecoverStakingToken();
    error SameTokens();

    constructor(IERC20 stakingToken_, IERC20 rewardsToken_, address owner_) Ownable(owner_) {
        if (address(stakingToken_) == address(rewardsToken_)) revert SameTokens();
        stakingToken = stakingToken_;
        rewardsToken = rewardsToken_;
    }

    /// @dev Brings global and per-user accounting up to date before any balance change.
    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    // ─────────────────────────────── Views ───────────────────────────────

    /// @notice Current time capped at the end of the reward period.
    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    /// @notice Accumulated rewards per staked token (scaled by 1e18).
    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * PRECISION) / totalStaked;
    }

    /// @notice Rewards `account` can claim right now.
    function earned(address account) public view returns (uint256) {
        return (balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / PRECISION + rewards[account];
    }

    // ─────────────────────────────── Users ───────────────────────────────

    function stake(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        totalStaked += amount;
        balanceOf[msg.sender] += amount;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) public nonReentrant updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        if (amount > balanceOf[msg.sender]) revert InsufficientBalance();
        totalStaked -= amount;
        balanceOf[msg.sender] -= amount;
        stakingToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function getReward() public nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardsToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    /// @notice Withdraws the whole stake and claims rewards in one call.
    function exit() external {
        withdraw(balanceOf[msg.sender]);
        getReward();
    }

    // ─────────────────────────────── Admin ───────────────────────────────

    /**
     * @notice Starts (or extends) a reward period. Reward tokens must be sent to the contract first.
     * @dev If a period is running, leftover rewards are rolled into the new one.
     * @param reward Amount of new reward tokens to distribute.
     * @param duration Length of the new period in seconds.
     */
    function notifyRewardAmount(uint256 reward, uint256 duration) external onlyOwner updateReward(address(0)) {
        if (duration == 0) revert ZeroDuration();

        if (block.timestamp >= periodFinish) {
            rewardRate = reward / duration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (reward + leftover) / duration;
        }
        if (rewardRate == 0) revert ZeroAmount();

        // The whole period must be covered by the contract's reward balance.
        uint256 available = rewardsToken.balanceOf(address(this));
        if (rewardRate * duration > available) revert RewardTooHigh();

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(reward, duration);
    }

    /// @notice Recovers tokens sent here by mistake. The staking token can never be recovered.
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        if (token == address(stakingToken)) revert CannotRecoverStakingToken();
        IERC20(token).safeTransfer(owner(), amount);
        emit Recovered(token, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
