const PlatformLedger = require('../models/PlatformLedger');

async function createLedgerEntry({
  category,
  direction,
  asset,
  amount,
  status = 'completed',
  reference,
  sourceType = null,
  sourceId = null,
  destinationType = null,
  destination = null,
  createdByUserId = null,
  metadata = {}
}) {
  return PlatformLedger.create({
    category,
    direction,
    asset: String(asset).toUpperCase(),
    amount: Number(amount),
    status,
    reference,
    sourceType,
    sourceId,
    destinationType,
    destination,
    createdByUserId,
    metadata
  });
}

async function getTreasuryBalances() {
  const rows = await PlatformLedger.aggregate([
    { $match: { status: 'completed' } },
    {
      $group: {
        _id: '$asset',
        credits: {
          $sum: {
            $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', 0]
          }
        },
        debits: {
          $sum: {
            $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', 0]
          }
        }
      }
    }
  ]);

  return rows.reduce((acc, row) => {
    acc[row._id] = Number((row.credits - row.debits).toFixed(8));
    return acc;
  }, {});
}

async function getTreasurySummary() {
  const [balances, pendingDebits, pendingCredits] = await Promise.all([
    getTreasuryBalances(),
    PlatformLedger.aggregate([
      { $match: { status: 'pending', direction: 'debit' } },
      { $group: { _id: '$asset', amount: { $sum: '$amount' } } }
    ]),
    PlatformLedger.aggregate([
      { $match: { status: 'pending', direction: 'credit' } },
      { $group: { _id: '$asset', amount: { $sum: '$amount' } } }
    ])
  ]);

  return {
    settledBalances: balances,
    pendingDebits: pendingDebits.reduce((acc, row) => {
      acc[row._id] = Number(row.amount || 0);
      return acc;
    }, {}),
    pendingCredits: pendingCredits.reduce((acc, row) => {
      acc[row._id] = Number(row.amount || 0);
      return acc;
    }, {})
  };
}

module.exports = {
  createLedgerEntry,
  getTreasuryBalances,
  getTreasurySummary
};
