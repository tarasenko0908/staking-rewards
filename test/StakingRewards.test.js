const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const e18 = (n) => ethers.parseUnits(n.toString(), 18);

// Rewards are computed with integer division, so allow a tiny rounding error.
const closeTo = (actual, expected, tolerance = e18("0.001")) =>
  expect(actual).to.be.closeTo(expected, tolerance);

describe("StakingRewards", function () {
  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockToken");
    const stakeToken = await Token.deploy("Stake Token", "STK", e18(1_000_000));
    const rewardToken = await Token.deploy("Reward Token", "RWD", e18(1_000_000));

    const Staking = await ethers.getContractFactory("StakingRewards");
    const staking = await Staking.deploy(await stakeToken.getAddress(), await rewardToken.getAddress(), owner.address);
    const stakingAddr = await staking.getAddress();

    for (const user of [alice, bob]) {
      await stakeToken.transfer(user.address, e18(1000));
      await stakeToken.connect(user).approve(stakingAddr, ethers.MaxUint256);
    }
    return { staking, stakeToken, rewardToken, owner, alice, bob, stakingAddr };
  }

  // 10 days, 1000 reward tokens => 100 tokens/day.
  async function runningFixture() {
    const ctx = await deployFixture();
    await ctx.rewardToken.transfer(ctx.stakingAddr, e18(1000));
    await ctx.staking.notifyRewardAmount(e18(1000), 10 * DAY);
    return ctx;
  }

  describe("Setup", function () {
    it("rejects identical tokens", async function () {
      const { stakeToken, owner } = await loadFixture(deployFixture);
      const Staking = await ethers.getContractFactory("StakingRewards");
      const addr = await stakeToken.getAddress();
      await expect(Staking.deploy(addr, addr, owner.address)).to.be.revertedWithCustomError(Staking, "SameTokens");
    });

    it("cannot start an unfunded reward period", async function () {
      const { staking } = await loadFixture(deployFixture);
      await expect(staking.notifyRewardAmount(e18(1000), 10 * DAY)).to.be.revertedWithCustomError(staking, "RewardTooHigh");
      await expect(staking.notifyRewardAmount(e18(1000), 0)).to.be.revertedWithCustomError(staking, "ZeroDuration");
    });

    it("only owner starts reward periods", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await expect(staking.connect(alice).notifyRewardAmount(1, 1))
        .to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
    });
  });

  describe("Staking and withdrawing", function () {
    it("tracks balances", async function () {
      const { staking, stakeToken, alice } = await loadFixture(runningFixture);
      await expect(staking.connect(alice).stake(e18(100))).to.emit(staking, "Staked").withArgs(alice.address, e18(100));
      expect(await staking.balanceOf(alice.address)).to.equal(e18(100));
      expect(await staking.totalStaked()).to.equal(e18(100));

      await expect(staking.connect(alice).withdraw(e18(40))).to.changeTokenBalance(stakeToken, alice, e18(40));
      expect(await staking.balanceOf(alice.address)).to.equal(e18(60));
    });

    it("rejects zero amounts and over-withdrawals", async function () {
      const { staking, alice } = await loadFixture(runningFixture);
      await expect(staking.connect(alice).stake(0)).to.be.revertedWithCustomError(staking, "ZeroAmount");
      await staking.connect(alice).stake(e18(10));
      await expect(staking.connect(alice).withdraw(e18(11))).to.be.revertedWithCustomError(staking, "InsufficientBalance");
    });
  });

  describe("Reward distribution", function () {
    it("a single staker earns the full reward stream", async function () {
      const { staking, rewardToken, alice } = await loadFixture(runningFixture);
      await staking.connect(alice).stake(e18(100));
      await time.increase(10 * DAY);

      // Alice staked 1 second after the period started, so she misses 1 second of rewards.
      closeTo(await staking.earned(alice.address), e18(1000), e18("0.01"));
      await staking.connect(alice).getReward();
      closeTo(await rewardToken.balanceOf(alice.address), e18(1000), e18("0.01"));
    });

    it("splits rewards by stake size and time", async function () {
      const { staking, rewardToken, stakingAddr, alice, bob } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(e18(300));
      await staking.connect(bob).stake(e18(100));
      await rewardToken.transfer(stakingAddr, e18(1000));

      const start = BigInt(await time.latest()) + 1n;
      await time.setNextBlockTimestamp(start);
      await staking.notifyRewardAmount(e18(1000), 10 * DAY);

      // Days 0-5: alice 75%, bob 25% of 500 => 375 / 125.
      // At day 5 bob withdraws everything; days 5-10 alice gets all 500.
      await time.setNextBlockTimestamp(start + BigInt(5 * DAY));
      await staking.connect(bob).withdraw(e18(100));
      await time.increaseTo(start + BigInt(10 * DAY));

      closeTo(await staking.earned(alice.address), e18(875));
      closeTo(await staking.earned(bob.address), e18(125));
    });

    it("no rewards accrue after the period ends", async function () {
      const { staking, alice } = await loadFixture(runningFixture);
      await staking.connect(alice).stake(e18(100));
      await time.increase(10 * DAY);
      const atEnd = await staking.earned(alice.address);
      await time.increase(30 * DAY);
      expect(await staking.earned(alice.address)).to.equal(atEnd);
    });

    it("leftover rewards roll into a new period", async function () {
      const { staking, rewardToken, stakingAddr, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(e18(100));
      await rewardToken.transfer(stakingAddr, e18(2000));

      const start = BigInt(await time.latest()) + 1n;
      await time.setNextBlockTimestamp(start);
      await staking.notifyRewardAmount(e18(1000), 10 * DAY);

      // Halfway through: 500 left + 1000 new over 10 more days.
      await time.setNextBlockTimestamp(start + BigInt(5 * DAY));
      await staking.notifyRewardAmount(e18(1000), 10 * DAY);
      await time.increaseTo(start + BigInt(15 * DAY));

      closeTo(await staking.earned(alice.address), e18(2000));
    });

    it("exit withdraws stake and claims rewards", async function () {
      const { staking, stakeToken, rewardToken, alice } = await loadFixture(runningFixture);
      await staking.connect(alice).stake(e18(100));
      await time.increase(5 * DAY);

      await staking.connect(alice).exit();
      expect(await staking.balanceOf(alice.address)).to.equal(0);
      expect(await stakeToken.balanceOf(alice.address)).to.equal(e18(1000));
      closeTo(await rewardToken.balanceOf(alice.address), e18(500), e18("0.01"));
      expect(await staking.earned(alice.address)).to.equal(0);
    });
  });

  describe("Admin safety", function () {
    it("pause blocks new stakes but not withdrawals", async function () {
      const { staking, alice } = await loadFixture(runningFixture);
      await staking.connect(alice).stake(e18(100));
      await staking.pause();
      await expect(staking.connect(alice).stake(e18(1))).to.be.revertedWithCustomError(staking, "EnforcedPause");
      await expect(staking.connect(alice).withdraw(e18(100))).to.not.be.reverted;
      await staking.unpause();
      await expect(staking.connect(alice).stake(e18(1))).to.not.be.reverted;
    });

    it("owner can never take staked tokens", async function () {
      const { staking, stakeToken, rewardToken, owner } = await loadFixture(runningFixture);
      await expect(staking.recoverERC20(await stakeToken.getAddress(), 1))
        .to.be.revertedWithCustomError(staking, "CannotRecoverStakingToken");
      await expect(staking.recoverERC20(await rewardToken.getAddress(), e18(1)))
        .to.changeTokenBalance(rewardToken, owner, e18(1));
    });
  });
});
