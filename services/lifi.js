/**
 * LI.FI SDK Service
 * Official docs: https://docs.li.fi/sdk/overview
 */

const {
  createConfig,
  getChains,
  getTokens,
  getQuote,
  getStatus,
  getTools
} = require('@lifi/sdk');

const CHAIN_IDS = {
  ethereum: 1,
  polygon: 137,
  bsc: 56,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  avalanche: 43114
};

class LifiService {
  constructor() {
    this.apiKey = process.env.LIFI_API_KEY || undefined;
    this.integrator = process.env.LIFI_INTEGRATOR || 'FlameX';
    this.isConfigured = true;

    createConfig({
      integrator: this.integrator,
      apiKey: this.apiKey,
      preloadChains: false
    });
  }

  getChainId(chain) {
    return CHAIN_IDS[String(chain || '').toLowerCase()] || null;
  }

  async getChains() {
    try {
      const chains = await getChains();
      return { success: true, chains };
    } catch (error) {
      console.error('LI.FI SDK getChains error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getTokens(chain) {
    try {
      const chainId = this.getChainId(chain);
      if (!chainId) {
        return { success: false, error: `Unsupported chain: ${chain}` };
      }

      const response = await getTokens({ chains: [chainId] });
      return {
        success: true,
        tokens: response.tokens?.[chainId] || []
      };
    } catch (error) {
      console.error('LI.FI SDK getTokens error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getQuote(params) {
    try {
      const fromChainId = this.getChainId(params.fromChain);
      const toChainId = this.getChainId(params.toChain);

      if (!fromChainId || !toChainId) {
        return {
          success: false,
          error: `Unsupported LI.FI chain pair: ${params.fromChain} -> ${params.toChain}`
        };
      }

      const quote = await getQuote({
        fromChain: fromChainId,
        toChain: toChainId,
        fromToken: params.fromToken,
        toToken: params.toToken,
        fromAddress: params.fromAddress,
        toAddress: params.toAddress,
        fromAmount: String(params.amount),
        slippage: Number(params.slippage || 0.5)
      });

      return { success: true, quote };
    } catch (error) {
      console.error('LI.FI SDK getQuote error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getSwapStatus(params) {
    try {
      const status = await getStatus(params);
      return { success: true, status };
    } catch (error) {
      console.error('LI.FI SDK getStatus error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getTools(params = {}) {
    try {
      const tools = await getTools(params);
      return { success: true, tools };
    } catch (error) {
      console.error('LI.FI SDK getTools error:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new LifiService();
