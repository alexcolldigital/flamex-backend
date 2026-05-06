/**
 * Thirdweb Wallet Service
 * Non-Custodial Wallet & Smart Account Management
 * Docs: https://portal.thirdweb.com/
 */

const { ThirdwebSDK } = require('@thirdweb-dev/sdk');
const { ethers } = require('ethers');
const axios = require('axios');

class ThirdwebService {
  constructor() {
    this.sdk = null;
    this.isInitialized = false;
  }

  /**
   * Initialize Thirdweb SDK
   */
  async initialize() {
    if (this.isInitialized) return;

    const secretKey = process.env.THIRDWEB_SECRET_KEY;
    const clientId = process.env.THIRDWEB_CLIENT_ID;

    if (!secretKey || !clientId) {
      console.warn('Thirdweb credentials not configured');
      return;
    }

    try {
      // Initialize with secret key for server-side operations
      this.sdk = ThirdwebSDK.fromPrivateKey(
        process.env.PRIVATE_KEY || '',
        'mainnet', // default chain
        {
          secretKey,
          clientId
        }
      );
      this.isInitialized = true;
      console.log('Thirdweb SDK initialized');
    } catch (error) {
      console.error('Thirdweb initialization error:', error);
    }
  }

  /**
   * Create a smart wallet for a user
   * @param {string} ownerAddress - The owner's wallet address
   * @param {string} chain - The chain to create the wallet on
   */
  async createSmartWallet(ownerAddress, chain = 'ethereum') {
    await this.initialize();

    try {
      // Get the wallet module
      const wallet = this.sdk.getWalletModule(chain);

      // Create a smart account
      const smartAccount = await wallet.create({
        owner: ownerAddress,
        entryPoint: '0x5FF137D4b0FD99CdA3b998f50f3833FEb1C8B20A', // Entry point v0.6
      });

      return {
        success: true,
        address: smartAccount.address,
        owner: ownerAddress,
        chain
      };
    } catch (error) {
      console.error('Create smart wallet error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get wallet address for a user
   * @param {string} ownerAddress - Owner's address
   * @param {string} chain - Chain identifier
   */
  async getSmartWalletAddress(ownerAddress, chain = 'ethereum') {
    await this.initialize();

    try {
      const wallet = this.sdk.getWalletModule(chain);
      const smartAccount = await wallet.getAddress({
        owner: ownerAddress
      });

      return {
        success: true,
        address: smartAccount
      };
    } catch (error) {
      console.error('Get smart wallet address error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get token balance for a wallet
   * @param {string} walletAddress - Wallet address
   * @param {string} tokenAddress - Token contract address
   * @param {string} chain - Chain identifier
   */
  async getTokenBalance(walletAddress, tokenAddress, chain = 'ethereum') {
    await this.initialize();

    try {
      const contract = await this.sdk.getContract(tokenAddress, chain);
      const balance = await contract.erc20.balanceOf(walletAddress);

      return {
        success: true,
        balance: balance.toString(),
        formatted: ethers.formatEther(balance)
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
   * Transfer tokens from smart wallet
   * @param {string} to - Recipient address
   * @param {string} tokenAddress - Token contract address
   * @param {string} amount - Amount to transfer
   * @param {string} chain - Chain identifier
   */
  async transferToken(to, tokenAddress, amount, chain = 'ethereum') {
    await this.initialize();

    try {
      const contract = await this.sdk.getContract(tokenAddress, chain);

      // Encode the transfer function
      const data = contract.erc20.encoder.encode('transfer', [
        to,
        ethers.parseEther(amount).toString()
      ]);

      return {
        success: true,
        transactionData: data,
        note: 'Transaction signed, submit to blockchain'
      };
    } catch (error) {
      console.error('Transfer token error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send transaction (gasless)
   * @param {string} to - Recipient address
   * @param {string} value - Amount in native token
   * @param {string} data - Transaction data
   * @param {string} chain - Chain identifier
   */
  async sendTransaction(to, value = '0', data = '0x', chain = 'ethereum') {
    await this.initialize();

    try {
      const wallet = this.sdk.getWalletModule(chain);

      // Build transaction
      const transaction = await wallet.sendTransaction({
        to,
        value: ethers.parseEther(value).toString(),
        data
      });

      return {
        success: true,
        transactionHash: transaction.hash,
        chain
      };
    } catch (error) {
      console.error('Send transaction error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get supported chains
   */
  getSupportedChains() {
    return [
      { id: 'ethereum', name: 'Ethereum', symbol: 'ETH' },
      { id: 'polygon', name: 'Polygon', symbol: 'MATIC' },
      { id: 'bsc', name: 'BNB Chain', symbol: 'BNB' },
      { id: 'arbitrum', name: 'Arbitrum', symbol: 'ETH' },
      { id: 'optimism', name: 'Optimism', symbol: 'ETH' },
      { id: 'base', name: 'Base', symbol: 'ETH' },
      { id: 'avalanche', name: 'Avalanche', symbol: 'AVAX' },
      { id: 'fantom', name: 'Fantom', symbol: 'FTM' }
    ];
  }
}

module.exports = new ThirdwebService();