const express = require('express');
const axios = require('axios');
const router = express.Router();

// Token IDs for CoinGecko
const TOKEN_IDS = {
  SOL: 'solana',
  ETH: 'ethereum',
  BNB: 'binancecoin',
  USDT: 'tether',
  USDC: 'usd-coin',
  FLAME: 'solana' // Using SOL price as base for FLAME (would be a real token in production)
};

// Get token prices
router.get('/', async (req, res) => {
  try {
    // Fetch prices from CoinGecko
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum,binancecoin,tether,usd-coin&vs_currencies=usd,ngn&include_24hr_change=true'
    );
    
    const data = response.data;
    
    // Format prices
    const prices = {
      SOL: {
        usd: data.solana.usd,
        ngn: data.solana.ngn,
        change24h: data.solana.usd_24h_change || 0
      },
      ETH: {
        usd: data.ethereum.usd,
        ngn: data.ethereum.ngn,
        change24h: data.ethereum.usd_24h_change || 0
      },
      BNB: {
        usd: data.binancecoin.usd,
        ngn: data.binancecoin.ngn,
        change24h: data.binancecoin.usd_24h_change || 0
      },
      USDT: {
        usd: data.tether.usd,
        ngn: data.tether.ngn,
        change24h: data.tether.usd_24h_change || 0
      },
      USDC: {
        usd: data['usd-coin'].usd,
        ngn: data['usd-coin'].ngn,
        change24h: data['usd-coin'].usd_24h_change || 0
      },
      FLAME: {
        usd: data.solana.usd * 0.001, // Mock FLAME price
        ngn: data.solana.ngn * 0.001,
        change24h: data.solana.usd_24h_change * 1.5 || 0 // Higher volatility
      }
    };
    
    res.json(prices);
  } catch (error) {
    console.error('Price fetch error:', error.message);
    
    // Return fallback prices
    res.json({
      SOL: { usd: 150, ngn: 225000, change24h: 2.5 },
      ETH: { usd: 3000, ngn: 4500000, change24h: 1.8 },
      BNB: { usd: 600, ngn: 900000, change24h: 1.4 },
      USDT: { usd: 1, ngn: 1500, change24h: 0.1 },
      USDC: { usd: 1, ngn: 1500, change24h: 0.05 },
      FLAME: { usd: 0.15, ngn: 225, change24h: 5.2 }
    });
  }
});

// Get NGN rate
router.get('/ngn', async (req, res) => {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=ngn'
    );
    
    res.json({
      rate: response.data.tether.ngn,
      source: 'coingecko'
    });
  } catch (error) {
    res.json({
      rate: 1500,
      source: 'fallback'
    });
  }
});

module.exports = router;
