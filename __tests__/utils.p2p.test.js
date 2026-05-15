const {
  getAvailableBalance,
  getLockedBalance,
  lockFunds,
  unlockFunds,
  releaseLockedFunds
} = require('../utils/p2p');

describe('utils/p2p escrow balance helpers', () => {
  test('lockFunds moves crypto from available balance into locked balance', () => {
    const user = {
      balances: { USDT: 100 },
      lockedBalances: { USDT: 0 }
    };

    lockFunds(user, 'USDT', 25);

    expect(user.balances.USDT).toBe(75);
    expect(getAvailableBalance(user, 'USDT')).toBe(50);
    expect(getLockedBalance(user, 'USDT')).toBe(25);
  });

  test('unlockFunds restores locked crypto to the seller balance', () => {
    const user = {
      balances: { USDT: 75 },
      lockedBalances: { USDT: 25 }
    };

    unlockFunds(user, 'USDT', 10);

    expect(user.balances.USDT).toBe(85);
    expect(getLockedBalance(user, 'USDT')).toBe(15);
    expect(getAvailableBalance(user, 'USDT')).toBe(70);
  });

  test('getAvailableBalance excludes locked funds from spendable balance', () => {
    const user = {
      balances: { USDT: 100 },
      lockedBalances: { USDT: 35 }
    };

    expect(getAvailableBalance(user, 'USDT')).toBe(65);
  });

  test('releaseLockedFunds debits seller escrow and credits buyer wallet', () => {
    const seller = {
      balances: { USDT: 80 },
      lockedBalances: { USDT: 20 }
    };
    const buyer = {
      balances: { USDT: 5 },
      lockedBalances: { USDT: 0 }
    };

    releaseLockedFunds(seller, buyer, 'USDT', 20);

    expect(getLockedBalance(seller, 'USDT')).toBe(0);
    expect(seller.balances.USDT).toBe(80);
    expect(buyer.balances.USDT).toBe(25);
  });
});
