# Staking Rewards

Stake one ERC-20 token, earn another. Rewards are streamed at a constant rate over a reward period and shared between stakers in proportion to their stake and staking time.

## How rewards are calculated

The contract uses the *reward-per-token* accumulator model (popularised by Synthetix):

```
rewardPerToken += rewardRate × Δt / totalStaked
earned(user)    = balance × (rewardPerToken − userRewardPerTokenPaid) + storedRewards
```

Every action is **O(1)** — gas costs don't grow with the number of stakers.

**Example:** 1,000 reward tokens over 10 days. Alice stakes 300, Bob stakes 100. Bob leaves after 5 days.
- Days 0–5: Alice 75% / Bob 25% of 500 → 375 / 125
- Days 5–10: Alice 100% of 500 → 500
- **Result:** Alice 875, Bob 125 (this exact scenario is covered by the tests)

## Features

- Reward periods can be extended; leftover rewards roll into the new period
- **Fully funded periods** — the owner can't start a period larger than the reward balance
- **Staked tokens are untouchable** — `recoverERC20` refuses the staking token
- **Pausable** — pause blocks only new stakes; users can always withdraw and claim
- `exit()` withdraws everything and claims rewards in one transaction
- `SafeERC20`, `ReentrancyGuard`, custom errors

## Contract overview

| Function | Who | Description |
|---|---|---|
| `stake(amount)` | user | Stake tokens (approve first) |
| `withdraw(amount)` | user | Unstake |
| `getReward()` | user | Claim rewards |
| `exit()` | user | Withdraw all + claim |
| `earned(account)` | view | Claimable rewards |
| `notifyRewardAmount(reward, duration)` | owner | Start / extend a reward period |
| `pause()` / `unpause()` | owner | Stop new stakes |
| `recoverERC20(token, amount)` | owner | Recover tokens sent by mistake (not the staking token) |

## Getting started

```bash
npm install
npx hardhat compile
npx hardhat test
npm run coverage
```

## Tests

12 tests: setup validation, staking/withdrawing, single- and multi-staker distribution, time-weighted splits, period end, rolling over leftovers, exit, pause and recovery safety.

```
  12 passing
```

Line coverage: 100%.

## Tech stack

Solidity 0.8.24 · OpenZeppelin Contracts 5 · Hardhat · Ethers v6 · Chai

## License

MIT
