const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const axios = require('axios');
const lifiService = require('../services/lifi');
const { withTransaction } = require('../utils/database');
const { AppError } = require('../utils/errorHandler');

const JUPITER_API = 'https://quote-api.jup.ag/v6';
const EVM_NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
const SUPPORTED_TOKENS = {
  solana: [
    { symbol: 'SOL', name: 'Solana', address: 'native', decimals: 9 },
    { symbol: 'USDT', name: 'Tether USD', address: 'Es9vMFrzaCERmJfrmrP3cu6UytzszbmWzxubUANe1yoy', decimals: 6 },
    { symbol: 'USDC', name: 'USD Coin', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
    { symbol: 'FLAME', name: 'Flame Token', address: 'flame-token', decimals: 6 }
  ],
  ethereum: [
    { symbol: 'ETH', name: 'Ethereum', address: EVM_NATIVE_TOKEN, decimals: 18 },
    { symbol: 'USDT', name: 'Tether USD', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    { symbol: 'USDC', name: 'USD Coin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 }
  ],
  bsc: [
    { symbol: 'BNB', name: 'BNB', address: EVM_NATIVE_TOKEN, decimals: 18 },
    { symbol: 'USDT', name: 'Tether USD', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    { symbol: 'USDC', name: 'USD Coin', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 }
  ]
};

const getTokenConfig = (chain, symbolOrAddress) => {
  if (!symbolOrAddress) return null;
  const normalizedValue = String(symbolOrAddress).toLowerCase();

  return (SUPPORTED_TOKENS[chain] || []).find((token) => (
    token.symbol.toLowerCase() === normalizedValue ||
    token.address.toLowerCase() === normalizedValue
  )) || null;
};

router.get('/tokens', authMiddleware, async (req, res) => {
  const { chain = 'solana' } = req.query;
  res.json({ tokens: SUPPORTED_TOKENS[chain] || SUPPORTED_TOKENS.solana });
});

const getTokenDecimals = (chain, symbolOrAddress) => getTokenConfig(chain, symbolOrAddress)?.decimals || 18;

const getAvailableBalance = (user, asset) => {
  const symbol = String(asset || '').toUpperCase();
  const balance = Number(user?.balances?.[symbol] || 0);
  const locked = Number(user?.lockedBalances?.[symbol] || 0);
  return Math.max(0, balance - locked);
};

const toBaseUnits = (amount, decimals) => {
  const numericAmount = Number(amount);
  if (!numericAmount || numericAmount <= 0) {
    return null;
  }

  return String(Math.round(numericAmount * (10 ** decimals)));
};

// Get swap quote
router.get('/quote', authMiddleware, async (req, res) => {
  try {
    const { fromChain, toChain, fromToken, toToken, fromAmount, slippage = 0.5 } = req.query;

    if (!fromChain || !toChain || !fromToken || !toToken || !fromAmount) {
      return res.status(400).json({ message: 'Missing required parameters' });
    }

    const user = await User.findById(req.userId);
    const resolvedFromToken = getTokenConfig(fromChain, fromToken);
    const resolvedToToken = getTokenConfig(toChain, toToken);

    // Same-chain swap via Jupiter (Solana)
    if (fromChain === toChain && fromChain === 'solana') {
      const inputMint = resolvedFromToken?.address;
      const outputMint = resolvedToToken?.address;
      const normalizedAmount = Number(fromAmount);

      if (!inputMint || !outputMint) {
        return res.status(400).json({ message: 'Unsupported token pair for Solana quote' });
      }
      if (!normalizedAmount || normalizedAmount <= 0) {
        return res.status(400).json({ message: 'Invalid amount' });
      }

      const quoteAmount = Math.round(normalizedAmount * (10 ** resolvedFromToken.decimals));

      const response = await axios.get(`${JUPITER_API}/quote`, {
        params: {
          inputMint,
          outputMint,
          amount: quoteAmount,
          slippageBps: slippage * 100
        }
      });

      return res.json({
        type: 'same-chain',
        chainId: fromChain,
        fromToken: resolvedFromToken.symbol,
        toToken: resolvedToToken.symbol,
        fromAmount: normalizedAmount,
        toAmount: Number(response.data.outAmount) / (10 ** resolvedToToken.decimals),
        minimumReceived: Number(response.data.otherAmountThreshold) / (10 ** resolvedToToken.decimals),
        priceImpact: response.data.priceImpactPct,
        route: response.data.routePlan,
        provider: 'jupiter',
        slippage
      });
    }

    // Any non-Solana route uses LI.FI SDK
    if (!(fromChain === toChain && fromChain === 'solana')) {
      const fromTokenDecimals = getTokenDecimals(fromChain, fromToken);
      const toTokenDecimals = getTokenDecimals(toChain, toToken);
      const quoteAmount = toBaseUnits(fromAmount, fromTokenDecimals);

      if (!quoteAmount) {
        return res.status(400).json({ message: 'Invalid amount' });
      }

      const lifiQuote = await lifiService.getQuote({
        fromChain,
        toChain,
        fromToken: resolvedFromToken?.address || fromToken,
        toToken: resolvedToToken?.address || toToken,
        fromAddress: user.primaryWalletAddress,
        toAddress: user.primaryWalletAddress,
        amount: quoteAmount,
        slippage
      });

      if (lifiQuote.success) {
        const estimate = lifiQuote.quote?.estimate || {};
        const toAmountRaw = estimate.toAmount || lifiQuote.quote?.toAmount || '0';
        const minReceivedRaw = estimate.toAmountMin || toAmountRaw;

        return res.json({
          type: fromChain === toChain ? 'same-chain' : 'cross-chain',
          fromChain,
          toChain,
          fromToken: resolvedFromToken?.symbol || fromToken,
          toToken: resolvedToToken?.symbol || toToken,
          fromAmount: Number(fromAmount),
          toAmount: Number(toAmountRaw) / (10 ** toTokenDecimals),
          minimumReceived: Number(minReceivedRaw) / (10 ** toTokenDecimals),
          provider: 'lifi',
          slippage,
          estimatedTime: estimate.executionDuration || 300,
          route: [lifiQuote.quote],
          priceImpact: estimate.toAmountUSD && estimate.fromAmountUSD
            ? ((Number(estimate.toAmountUSD) / Number(estimate.fromAmountUSD) - 1) * 100).toFixed(2)
            : '0',
          quote: lifiQuote.quote
        });
      }
    }

    return res.status(503).json({
      message: 'Swap provider is unavailable. No quote was created.'
    });
  } catch (error) {
    console.error('Quote error:', error);
    res.status(500).json({ message: 'Failed to get quote' });
  }
});

// Execute swap
router.post('/execute', authMiddleware, [
  body('fromChain').notEmpty(),
  body('toChain').notEmpty(),
  body('fromToken').notEmpty(),
  body('toToken').notEmpty(),
  body('fromAmount').optional().isNumeric(),
  body('amount').optional().isNumeric()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      fromChain,
      toChain,
      fromToken,
      toToken,
      fromAmount,
      toAmount,
      amount
    } = req.body;
    const user = await User.findById(req.userId);
    const debitAmount = Number(fromAmount || amount);
    const creditAmount = Number(toAmount);
    const fromSymbol = String(fromToken).toUpperCase();
    const toSymbol = String(toToken).toUpperCase();

    if (!debitAmount || debitAmount <= 0) {
      return res.status(400).json({ message: 'Invalid swap amount' });
    }

    if (!creditAmount || creditAmount <= 0) {
      return res.status(400).json({ message: 'Invalid output amount' });
    }

    if (fromSymbol === toSymbol && fromChain === toChain) {
      return res.status(400).json({ message: 'Source and destination asset cannot be the same' });
    }

    const currentBalance = getAvailableBalance(user, fromSymbol);

    if (currentBalance < debitAmount) {
      return res.status(400).json({ message: `Insufficient available ${fromToken} balance` });
    }

    const reference = `SWAP-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const { transaction } = await withTransaction(async (session) => {
      const sessionUser = await User.findById(user._id).session(session);
      if (!sessionUser) {
        throw new AppError('User not found', 404);
      }

      const sessionAvailableBalance = getAvailableBalance(sessionUser, fromSymbol);
      if (sessionAvailableBalance < debitAmount) {
        throw new AppError(`Insufficient available ${fromToken} balance`, 400);
      }

      const transaction = new Transaction({
        userId: req.userId,
        type: fromChain === toChain ? 'swap' : 'cross_chain_swap',
        amount: debitAmount,
        currency: fromSymbol,
        chainId: fromChain,
        fromCurrency: fromSymbol,
        toCurrency: toSymbol,
        fromAmount: debitAmount,
        toAmount: creditAmount,
        fromChainId: fromChain,
        toChainId: toChain,
        description: `Swap ${debitAmount} ${fromSymbol} to ${toSymbol}`,
        status: 'completed',
        reference,
        metadata: {
          executionMode: fromChain === toChain ? 'internal_ledger_swap' : 'internal_ledger_cross_chain_credit'
        }
      });

      sessionUser.balances[fromSymbol] = Number((Number(sessionUser.balances[fromSymbol] || 0) - debitAmount).toFixed(8));
      sessionUser.balances[toSymbol] = Number((Number(sessionUser.balances[toSymbol] || 0) + creditAmount).toFixed(8));

      await Promise.all([
        sessionUser.save({ session }),
        transaction.save({ session })
      ]);

      return { transaction };
    });

    res.json({
      message: 'Swap completed',
      transaction: {
        id: transaction._id,
        type: transaction.type,
        status: transaction.status,
        reference
      }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

router.get('/history', authMiddleware, async (req, res) => {
  try {
    const swaps = await Transaction.find({
      userId: req.userId,
      type: { $in: ['swap', 'cross_chain_swap'] }
    })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({ swaps });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
