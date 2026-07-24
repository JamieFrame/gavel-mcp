import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireTier } from '../../tiers.js';

// ============================================================================
// Protocol reference data.
//
// Source of truth for The Gavel Protocol's on-chain wiring. Lets an LLM agent
// look up a contract address, function signature, or convention in a single
// MCP call rather than scraping the frontend bundle or Etherscan.
//
// This is descriptive data: addresses, tokens, function signatures, and a
// handful of conventions that affect how transactions must be constructed.
// No recommendation is provided. Anyone constructing a transaction is
// responsible for signing and broadcasting it via their own wallet; Aletheia
// never holds keys or dispatches transactions.
//
// NOTE(Phase 1.5): when api.thegavel.io grows a /v1/protocol/reference
// endpoint, refactor this tool to fetch from there via upstreamGet(). The
// hardcoded JSON here is acceptable for now because the data changes only on
// contract redeploy.
// ============================================================================

const KEY_FUNCTIONS = {
  LoanProtocol: [
    'createAuction(address collateralToken, uint256 collateralAmount, address loanToken, uint256 loanAmount, uint256 maxRepayment, uint256 loanDuration, uint256 auctionDuration, uint256 bidStep) returns (uint256 auctionId)',
    'placeBid(uint256 auctionId, uint256 repaymentAmount)',
    'finalizeAuction(uint256 auctionId)',
    'cancelAuction(uint256 auctionId)',
    'claimExpiredAuction(uint256 auctionId)',
    'repayLoan(uint256 loanId)',
    'claimCollateral(uint256 loanId)',
    'claimRefund(address token)',
    'getPendingRefund(address user, address token) view returns (uint256)',
    'getAuction(uint256 auctionId) view returns (tuple)',
    'getLoan(uint256 loanId) view returns (tuple)',
    'isLoanTokenWhitelisted(address token) view returns (bool)',
    'calculateAuctionFee(uint256 loanAmount) view returns (uint256)',
    'auctionFeeBps() view returns (uint256)',
  ],
  ListingService: [
    'listPosition(uint256 tokenId, uint256 price, address paymentToken, uint256 duration)',
    'listPositionFor(uint256 tokenId, uint256 price, address paymentToken, uint256 duration, address seller)',
    'buyPosition(uint256 tokenId, uint256 maxPrice, address expectedPaymentToken)',
    'cancelListing(uint256 tokenId)',
    'getListing(uint256 tokenId) view returns (tuple)',
    'isListedAuction(uint256 auctionId) view returns (bool)',
    'marketplaceListingFee() view returns (uint256)',
  ],
  PositionNFT: [
    'getBorrowerTokenId(uint256 loanId) view returns (uint256)',
    'getLenderTokenId(uint256 loanId) view returns (uint256)',
    'ownerOf(uint256 tokenId) view returns (address)',
    'approve(address to, uint256 tokenId)',
    'setApprovalForAll(address operator, bool approved)',
  ],
  NFTLoanProtocol: [
    'createAuction(address collateralNFT, uint256 collateralTokenId, address loanToken, uint256 loanAmount, uint256 maxRepayment, uint256 loanDuration, uint256 auctionDuration, uint256 bidStep) returns (uint256 auctionId)',
    'placeBid(uint256 auctionId, uint256 repaymentAmount)',
    'finalizeAuction(uint256 auctionId)',
    'cancelAuction(uint256 auctionId)',
    'claimExpiredAuction(uint256 auctionId)',
    'repayLoan(uint256 loanId)',
    'claimCollateral(uint256 loanId)',
  ],
  ERC20: [
    'approve(address spender, uint256 amount) returns (bool)',
    'balanceOf(address account) view returns (uint256)',
    'allowance(address owner, address spender) view returns (uint256)',
    'decimals() view returns (uint8)',
  ],
} as const;

const IMPORTANT_NOTES = [
  'Position NFT tokenId convention: tokenId = loanId * 2 for the borrower position, tokenId = loanId * 2 + 1 for the lender position. Use getBorrowerTokenId(loanId) / getLenderTokenId(loanId) as a safer derivation.',
  'Marketplace operations after the Sherlock audit (April 2026) use tokenId, not loanId. The buyPosition call requires three parameters — (tokenId, maxPrice, expectedPaymentToken) — for MEV protection: an unexpected price or payment token reverts the trade.',
  'Auction fee bps and marketplace listing fee are currently 0 — the protocol is fee-free under the Model B revenue strategy. The view functions auctionFeeBps() and marketplaceListingFee() return the live values; do not assume they will always be 0 in future versions.',
  'MIN_OFFER_DURATION = 1 day; MATURITY_BUFFER = 1 day. Marketplace offers can only be created on loans with at least 2 days remaining to maturity.',
  'Loan and auction durations are in SECONDS. For a 30-day loan, pass 30 * 86400 = 2,592,000. The frontend converts user-friendly day inputs to seconds before calling.',
  'The borrower NFT secondary market is mechanically equivalent to an American call option on BTC. The lender NFT secondary market is a yield instrument. Together they form an oracle-free options surface emergent from the lending mechanics.',
  'Before createAuction, the borrower must call ERC20.approve(LoanProtocol, collateralAmount) on the collateral token.',
  'Before placeBid, the lender must call ERC20.approve(LoanProtocol, repaymentAmount) on the loan token — note: approval covers the BID amount, since the lender pays the lower of repayment vs loanAmount up front.',
  'For marketplace operations involving Position NFTs, the holder must first call setApprovalForAll(ListingService, true) on the relevant PositionNFT contract.',
  'The whitelisted loan tokens are USDC and USDT (USD₮0). WBTC is the only whitelisted collateral. Custom pairs require admin action — see isLoanTokenWhitelisted().',
] as const;

export interface ContractAddresses {
  LoanProtocol: string;
  PositionNFT: string;
  ListingService: string;
  NFTLoanProtocol: string;
  NFTPositionNFT: string;
  NFTListingService: string;
}

interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
  roles: string[];
}

interface NetworkReference {
  network: string;
  chain_id: number;
  explorer: string;
  rpc_endpoints: string[];
  status: 'live' | 'testnet' | 'deprecated';
  contracts: ContractAddresses;
  tokens: TokenInfo[];
  key_functions: typeof KEY_FUNCTIONS;
  important_notes: readonly string[];
  abi_references: {
    full_abis_url: string;
    etherscan_links: Record<string, string>;
  };
}

export const MAINNET_CONTRACTS: ContractAddresses = {
  LoanProtocol:      '0xFCDd6Ef75638D8D19ad634004C234Ad18751fEf2',
  PositionNFT:       '0xAD6Edb72409605a51dc6C990A09829616178A8f4',
  ListingService:    '0x22B2C327Ed73da9e32a3eEB9DcBaa9AEBD8BD0d8',
  NFTLoanProtocol:   '0x506e414c7D39639B2E9E318C46eD378AD51147eb',
  NFTPositionNFT:    '0x9A1728C87ac0456cCd882b5D5637e856be0fEec8',
  NFTListingService: '0x43fD6Fda249820D98BC34733D4B5c896c613C674',
};

export const TESTNET_CONTRACTS: ContractAddresses = {
  LoanProtocol:      '0xB15336ba21410181AF1B8751Ee88aB4AFc9F1c26',
  PositionNFT:       '0x004eAfB3017E60A6574136bcF4e07364E438801D',
  ListingService:    '0xd1C6073d550E1C0A588081087E30B3091c635B6e',
  NFTLoanProtocol:   '0xe52111f2261173b81680610E36fE8fE813308068',
  NFTPositionNFT:    '0x409a8a526C61386eC88EaA9521de6d0943355671',
  NFTListingService: '0x4B581b6304c03A3C9f0bBeA0b69de807B841ba05',
};

function makeEtherscanLinks(addresses: ContractAddresses, explorer: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(addresses).map(([name, addr]) => [name, `${explorer}/address/${addr}#code`])
  );
}

const REFERENCES: Record<'arbitrum-one' | 'arbitrum-sepolia', NetworkReference> = {
  'arbitrum-one': {
    network: 'arbitrum-one',
    chain_id: 42161,
    explorer: 'https://arbiscan.io',
    rpc_endpoints: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum-one-rpc.publicnode.com',
    ],
    status: 'live',
    contracts: MAINNET_CONTRACTS,
    tokens: [
      { symbol: 'WBTC', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8, roles: ['collateral'] },
      { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, roles: ['loan'] },
      { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, roles: ['loan'] },
    ],
    key_functions: KEY_FUNCTIONS,
    important_notes: IMPORTANT_NOTES,
    abi_references: {
      full_abis_url: 'https://github.com/aletheia/gavel-contracts/tree/v1.0/abi',
      etherscan_links: makeEtherscanLinks(MAINNET_CONTRACTS, 'https://arbiscan.io'),
    },
  },
  'arbitrum-sepolia': {
    network: 'arbitrum-sepolia',
    chain_id: 421614,
    explorer: 'https://sepolia.arbiscan.io',
    rpc_endpoints: [
      'https://arbitrum-sepolia-rpc.publicnode.com',
      'https://sepolia-rollup.arbitrum.io/rpc',
    ],
    status: 'testnet',
    contracts: TESTNET_CONTRACTS,
    tokens: [
      { symbol: 'WBTC', address: '0x967dd019bFaa7AC83BB508Ee33cDF6660e181e8D', decimals: 8, roles: ['collateral', 'test_mint'] },
      { symbol: 'USDC', address: '0x7873E00010f5f1a28AC9470048b175baB8dcB60D', decimals: 6, roles: ['loan', 'test_mint'] },
      { symbol: 'USDT', address: '0x31BdCE6Ba62F8FC466f8aBC7c29d884d2A82de62', decimals: 6, roles: ['loan', 'test_mint'] },
    ],
    key_functions: KEY_FUNCTIONS,
    important_notes: [
      ...IMPORTANT_NOTES,
      'Testnet tokens expose a public mint(address to, uint256 amount) function so anyone can fund a test wallet without faucet friction.',
    ],
    abi_references: {
      full_abis_url: 'https://github.com/aletheia/gavel-contracts/tree/v1.0/abi',
      etherscan_links: makeEtherscanLinks(TESTNET_CONTRACTS, 'https://sepolia.arbiscan.io'),
    },
  },
};

export function registerProtocolReferenceTool(server: McpServer): void {
  server.registerTool(
    'get_protocol_reference',
    {
      title: 'Gavel Protocol Reference',
      description:
        `Returns the Gavel Protocol's complete on-chain reference data for the requested ` +
        `network: contract addresses, supported tokens (collateral and loan), key function ` +
        `signatures, operational conventions (like the Position NFT tokenId formula), and ` +
        `Etherscan/ABI references.\n\n` +
        `Use this tool when an agent needs to:\n` +
        `  - Look up a contract address before constructing a transaction\n` +
        `  - Get the function signature for placeBid, createAuction, repayLoan, etc.\n` +
        `  - Understand the tokenId convention for borrower vs lender position NFTs\n` +
        `  - Find an Etherscan link to verify a contract's source code\n` +
        `  - Confirm which loan tokens are whitelisted\n\n` +
        `This is descriptive data; no recommendation is provided. The agent is responsible ` +
        `for constructing, signing, and broadcasting any transactions via the user's own ` +
        `wallet. Aletheia never holds keys or dispatches transactions.\n\n` +
        `Returns: { network, chain_id, explorer, rpc_endpoints, status, contracts, tokens, ` +
        `key_functions, important_notes, abi_references }.`,
      inputSchema: {
        network: z
          .enum(['arbitrum-one', 'arbitrum-sepolia'])
          .default('arbitrum-one')
          .describe(`Network to look up. Default 'arbitrum-one' (mainnet, live protocol). Use 'arbitrum-sepolia' for the testnet deployment.`),
      },
    },
    async ({ network }) => {
      requireTier('free');
      const ref = REFERENCES[network];
      return {
        content: [{ type: 'text', text: JSON.stringify(ref, null, 2) }],
      };
    }
  );
}
