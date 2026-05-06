/**
 * Alchemy Blockchain Service
 * Blockchain Node Provider & Data Fetching
 * Docs: https://docs.alchemy.com/
 */

const { Alchemy, Network, Wallet } = require('alchemy-sdk');
const { ethers } = require('ethers');

class AlchemyService {
  constructor() {
    this.networks = {
      ethereum: Network.ETH_MAINNET,
      ethereumSepolia: Network.ETH_SEPOLIA,
      polygon: Network.MATIC_MAINNET,
      polygonMumbai: Network.MATIC_MUMBAI,
      bsc: Network.BSC_MAINNET,
      arbitrum: Network.ARB_MAINNET,
      optimism: Network.OPT_MAINNET,
      base: Network.BASE_MAINNET,
      avalanche: Network.AVAX_MAINNET
    };
    this.alchemy = null;
    this.isInitialized = false;
  }

  /**
   * Initialize Alchemy SDK
   * @param {string} network - Network name (ethereum, polygon, etc.)
   */
  initialize(network = 'ethereum') {
    if (this.isInitialized && this.alchemy) return;

    const apiKey = process.env.ALCHEMY_API_KEY;

    if (!apiKey) {
      console.warn('Alchemy API key not configured');
      return;
    }

    try {
      const config = {
        apiKey,
        network: this.networks[network] || Network.ETH_MAINNET
      };

      this.alchemy = new Alchemy(config);
      this.currentNetwork = network;
      this.isInitialized = true;
      console.log(`Alchemy SDK initialized for ${network}`);
    } catch (error) {
      console.error('Alchemy initialization error:', error);
    }
  }

  /**
   * Get native balance for an address
   * @param {string} address - Wallet address
   * @param {string} network - Network name
   */
  async getBalance(address, network = 'ethereum') {
    this.initialize(network);

    try {
      const balance = await this.alchemy.core.getBalance(address, 'latest');

      return {
        success: true,
        address,
        network,
        rawBalance: balance.toString(),
        formatted: ethers.formatEther(balance),
        symbol: this.getNetworkSymbol(network)
      };
    } catch (error) {
      console.error('Get balance error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get token balance for an address
   * @param {string} address - Wallet address
   * @param {string} tokenAddress - Token contract address
   * @param {string} network - Network name
   */
  async getTokenBalance(address, tokenAddress, network = 'ethereum') {
    this.initialize(network);

    try {
      // Get token metadata first
      const metadata = await this.alchemy.core.getTokenMetadata(tokenAddress);

      // Get token balance
      const balance = await this.alchemy.core.getTokenBalances(address, {
        contractAddresses: [tokenAddress]
      });

      const tokenBalance = balance.tokenBalances[0];

      return {
        success: true,
        address,
        token: metadata.symbol,
        rawBalance: tokenBalance?.tokenBalance || '0',
        formatted: ethers.formatUnits(
          tokenBalance?.tokenBalance || '0',
          metadata.decimals
        ),
        decimals: metadata.decimals
      };
    } catch (error) {
      console.error('Get token balance error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get all token balances for an address
   * @param {string} address - Wallet address
   * @param {string} network - Network name
   */
  async getTokenBalances(address, network = 'ethereum') {
    this.initialize(network);

    try {
      const balances = await this.alchemy.core.getTokenBalances(address);

      // Filter out zero balances and get metadata
      const tokens = [];
      for (const token of balances.tokenBalances) {
        if (token.tokenBalance && token.tokenBalance !== '0') {
          try {
            const metadata = await this.alchemy.core.getTokenMetadata(
              token.contractAddress
            );
            tokens.push({
              contractAddress: token.contractAddress,
              symbol: metadata.symbol,
              name: metadata.name,
              decimals: metadata.decimals,
              balance: token.tokenBalance,
              formatted: ethers.formatUnits(
                token.tokenBalance,
                metadata.decimals
              )
            });
          } catch (e) {
            // Skip tokens without metadata
          }
        }
      }

      return {
        success: true,
        address,
        network,
        tokens
      };
    } catch (error) {
      console.error('Get token balances error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get transaction history for an address
   * @param {string} address - Wallet address
   * @param {number} pageKey - Pagination key
   * @param {string} network - Network name
   */
  async getTransactionHistory(address, pageKey = null, network = 'ethereum') {
    this.initialize(network);

    try {
      const result = await this.alchemy.core.getAssetTransfers({
        fromBlock: '0x0',
        toBlock: 'latest',
        fromAddress: address,
        category: ['erc20', 'external'],
        withMetadata: true,
        maxCount: 50,
        pageKey
      });

      return {
        success: true,
        transfers: result.transfers.map(t => ({
          hash: t.hash,
          from: t.from,
          to: t.to,
          value: t.value,
          asset: t.asset,
          category: t.category,
          timestamp: t.metadata?.blockTimestamp,
          blockNum: t.blockNum
        })),
        pageKey: result.pageKey
      };
    } catch (error) {
      console.error('Get transaction history error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get current gas prices
   * @param {string} network - Network name
   */
  async getGasPrices(network = 'ethereum') {
    this.initialize(network);

    try {
      const gasPrices = await this.alchemy.core.getGasPrices();

      return {
        success: true,
        network,
        slow: {
          gasPrice: gasPrices.Slow?.gasPrice?.toString(),
          maxFeePerGas: gasPrices.Slow?.maxFeePerGas?.toString(),
          maxPriorityFeePerGas: gasPrices.Slow?.maxPriorityFeePerGas?.toString()
        },
        average: {
          gasPrice: gasPrices.Average?.gasPrice?.toString(),
          maxFeePerGas: gasPrices.Average?.maxFeePerGas?.toString(),
          maxPriorityFeePerGas: gasPrices.Average?.maxPriorityFeePerGas?.toString()
        },
        fast: {
          gasPrice: gasPrices.Fast?.gasPrice?.toString(),
          maxFeePerGas: gasPrices.Fast?.maxFeePerGas?.toString(),
          maxPriorityFeePerGas: gasPrices.Fast?.maxPriorityFeePerGas?.toString()
        }
      };
    } catch (error) {
      console.error('Get gas prices error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get transaction receipt
   * @param {string} txHash - Transaction hash
   * @param {string} network - Network name
   */
  async getTransactionReceipt(txHash, network = 'ethereum') {
    this.initialize(network);

    try {
      const receipt = await this.alchemy.core.getTransactionReceipt(txHash);

      return {
        success: true,
        transactionHash: txHash,
        blockNumber: receipt?.blockNumber,
        status: receipt?.status,
        gasUsed: receipt?.gasUsed?.toString(),
        logs: receipt?.logs || []
      };
    } catch (error) {
      console.error('Get transaction receipt error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get current block number
   * @param {string} network - Network name
   */
  async getBlockNumber(network = 'ethereum') {
    this.initialize(network);

    try {
      const blockNumber = await this.alchemy.core.getBlockNumber();

      return {
        success: true,
        network,
        blockNumber,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('Get block number error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get network symbol
   */
  getNetworkSymbol(network) {
    const symbols = {
      ethereum: 'ETH',
      ethereumSepolia: 'ETH',
      polygon: 'MATIC',
      polygonMumbai: 'MATIC',
      bsc: 'BNB',
      arbitrum: 'ETH',
      optimism: 'ETH',
      base: 'ETH',
      avalanche: 'AVAX'
    };
    return symbols[network] || 'ETH';
  }

  /**
   * Get supported networks
   */
  getSupportedNetworks() {
    return Object.keys(this.networks);
  }
}

module.exports = new AlchemyService();