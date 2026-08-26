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
    // MOVED 2026-08-26: isLoanTokenWhitelisted(address) is on ListingService,
    // not here. Its selector is absent from this implementation and calling it
    // on the LoanProtocol proxy reverts.
    //
    // buyPosition lives here, not on ListingService, despite the name: the
    // marketplace was folded into LoanProtocol at the Sherlock audit (see the
    // tokenId note in important_notes). Verified by selector 2026-08-26.
    'buyPosition(uint256 tokenId, uint256 maxPrice, address expectedPaymentToken)',
    // REMOVED 2026-08-26: calculateAuctionFee(uint256) and auctionFeeBps().
    // Neither exists. Both revert when called on the deployed mainnet and
    // testnet contracts, and neither appears in the published source at
    // bfb5086. They were advertised here for an unknown period while this
    // tool's own description told agents to use it to look up a function
    // signature *before constructing a transaction*.
  ],
  ListingService: [
    // ⚠ CORRECTED 2026-08-26 against the deployed implementation
    //   (0xc03e7a7934807aac5759b73f0d1c1270ce166a82).
    //
    // Five of the seven signatures previously listed here exist in NONE of the
    // six deployed implementations, checked by selector against each runtime:
    //   listPosition(uint256,uint256,address,uint256)
    //   listPositionFor(uint256,uint256,address,uint256,address)
    //   cancelListing(uint256)
    //   getListing(uint256)
    //   marketplaceListingFee()
    // A sixth, buyPosition(...), is real but lives on LoanProtocol.
    //
    // Selector absence proves those exact signatures are not callable. It does
    // NOT prove the operations are missing — they may exist under different
    // parameter types. Resolving that needs the implementation ABI, which this
    // hardcoded table cannot substitute for, so the missing entries are not
    // guessed back into place. Read the ABI from the `implementation` link in
    // abi_references.etherscan_links.
    'isLoanTokenWhitelisted(address token) view returns (bool)',
    'isListedAuction(uint256 auctionId) view returns (bool)',
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
  'The function signatures in key_functions were checked against the deployed implementations by selector on 2026-08-26, and several were wrong: three fee functions that exist nowhere, five marketplace signatures absent from all six implementations, and two filed under the wrong contract. What survives is verified. For anything not listed, read the ABI from the implementation link in abi_references.etherscan_links rather than assuming a signature — this table is hand-maintained and has drifted before. Run `npm run check:advertised` in gavel-mcp to re-verify.',
  'Position NFT tokenId convention: tokenId = loanId * 2 for the borrower position, tokenId = loanId * 2 + 1 for the lender position. Use getBorrowerTokenId(loanId) / getLenderTokenId(loanId) as a safer derivation.',
  'Marketplace operations after the Sherlock audit (April 2026) use tokenId, not loanId. The buyPosition call requires three parameters — (tokenId, maxPrice, expectedPaymentToken) — for MEV protection: an unexpected price or payment token reverts the trade.',
  'The protocol charges no fee, and there is no fee parameter that could introduce one. This is stronger than a fee set to zero: there is no fee state, no setter and no fee arithmetic in the deployed contracts, and no fee function to read. Verified 2026-08-26 — auctionFeeBps(), calculateAuctionFee(uint256) and marketplaceListingFee() all revert on mainnet, and the published source at bfb5086 contains no fee mechanism. This note previously claimed those three functions returned live values and warned they might change; that was wrong in both directions and is corrected here.',
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
  implementations: ContractAddresses;
  upgradeability: {
    proxy: true;
    pattern: string;
    admin_slot: string | null;
    upgrade_entrypoint: 'none' | 'proxy_admin';
    note: string;
  };
  tokens: TokenInfo[];
  key_functions: typeof KEY_FUNCTIONS;
  important_notes: readonly string[];
  abi_references: {
    full_abis_url: string;
    abi_note: string;
    etherscan_links: Record<string, { proxy: string; implementation: string }>;
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

/**
 * The six addresses above are PROXIES. Added 2026-08-26.
 *
 * Every advertised address holds a 133-byte minimal ERC-1967 proxy whose whole
 * runtime is: load the implementation slot, delegatecall, return. The contract
 * code an agent actually wants to read is at the implementation address below.
 *
 * Mainnet is NOT upgradeable: the proxy has no admin branch and no selector of
 * any kind, the EIP-1967 admin slot is zero, and no implementation exposes
 * upgradeTo / upgradeToAndCall / proxiableUUID. No reachable code path can
 * rewrite an implementation slot.
 *
 * This matters for anyone verifying: a bytecode hash of the ADDRESS hashes 133
 * bytes of proxy and will never match LoanProtocol.sol. Hash the implementation.
 */
export const MAINNET_IMPLEMENTATIONS: ContractAddresses = {
  LoanProtocol:      '0xfdaf4f783a29b55186ab6152f317c8998ad72fda',
  PositionNFT:       '0xf97cd596ce454cf854abf9975c1add3591e8befa',
  ListingService:    '0xc03e7a7934807aac5759b73f0d1c1270ce166a82',
  NFTLoanProtocol:   '0xd02e03340e46e9417511dd6d327acd6f48827958',
  NFTPositionNFT:    '0xb7b8316a3bb7ee37c95e93c9b72192654b92a5b0',
  NFTListingService: '0xd94f7f02c64629f7d4f6d7836b8d1f82bedeb2a7',
};

/**
 * Testnet is deployed differently from mainnet and the difference is material.
 *
 * These are 1,167-byte OpenZeppelin ERC1967 proxies with a NON-ZERO admin slot
 * — a ProxyAdmin per contract. Testnet IS upgradeable. That is the right
 * configuration for a surface meant to be iterated, but it means the
 * immutability property holds for MAINNET ONLY and must not be claimed of
 * testnet. Verified 2026-08-26.
 */
export const TESTNET_IMPLEMENTATIONS: ContractAddresses = {
  LoanProtocol:      '0x170a7a4f9cf44947800ad683b34869b7f88b5d72',
  PositionNFT:       '0x95e4bc4e41097fc0c9bacf774d6245585df12881',
  ListingService:    '0x3d1b574e2d9be8691d7aa89928b4e90115549f57',
  NFTLoanProtocol:   '0x206bad29fc79ab2900f975eb19da1136ffb32fae',
  NFTPositionNFT:    '0x247060acab898dc18e7bb182d1a4671f9ecaa944',
  NFTListingService: '0x073a24566461d4a92292070e66d6e1079f30363b',
};

export const TESTNET_CONTRACTS: ContractAddresses = {
  LoanProtocol:      '0xB15336ba21410181AF1B8751Ee88aB4AFc9F1c26',
  PositionNFT:       '0x004eAfB3017E60A6574136bcF4e07364E438801D',
  ListingService:    '0xd1C6073d550E1C0A588081087E30B3091c635B6e',
  NFTLoanProtocol:   '0xe52111f2261173b81680610E36fE8fE813308068',
  NFTPositionNFT:    '0x409a8a526C61386eC88EaA9521de6d0943355671',
  NFTListingService: '0x4B581b6304c03A3C9f0bBeA0b69de807B841ba05',
};

/**
 * Links for BOTH the proxy and the implementation. Before 2026-08-26 this
 * returned the proxy only, while abi_note offered "the verified contract on
 * Arbiscan" — so an agent following the link to read source landed on 133
 * bytes of proxy and found nothing resembling the contract it was promised.
 */
function makeEtherscanLinks(
  addresses: ContractAddresses,
  implementations: ContractAddresses,
  explorer: string
): Record<string, { proxy: string; implementation: string }> {
  return Object.fromEntries(
    Object.entries(addresses).map(([name, addr]) => [
      name,
      {
        proxy: `${explorer}/address/${addr}#code`,
        implementation: `${explorer}/address/${implementations[name as keyof ContractAddresses]}#code`,
      },
    ])
  );
}

export const REFERENCES: Record<'arbitrum-one' | 'arbitrum-sepolia', NetworkReference> = {
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
    implementations: MAINNET_IMPLEMENTATIONS,
    upgradeability: {
      proxy: true,
      pattern: 'minimal ERC-1967 proxy (133-byte runtime: sload slot, delegatecall, return)',
      admin_slot: null,
      upgrade_entrypoint: 'none',
      note:
        'The addresses in `contracts` are proxies; the code is at `implementations`. ' +
        'No upgrade path exists: the proxy has no admin branch and no function selector, ' +
        'the EIP-1967 admin slot is zero, and no implementation exposes upgradeTo, ' +
        'upgradeToAndCall or proxiableUUID — all three revert. Observed 2026-08-26; ' +
        'the check is one eth_getStorageAt per address and anyone can repeat it.',
    },
    tokens: [
      { symbol: 'WBTC', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8, roles: ['collateral'] },
      { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, roles: ['loan'] },
      { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, roles: ['loan'] },
    ],
    key_functions: KEY_FUNCTIONS,
    important_notes: IMPORTANT_NOTES,
    abi_references: {
      full_abis_url: 'https://github.com/JamieFrame/The-Gavel-Protocol',
      abi_note: 'The repository publishes Solidity source, not built ABIs — it is a Foundry project and the out/ directory is not committed. For a ready-to-use ABI, read the verified contract on Arbiscan via etherscan_links — use the `implementation` link, not the `proxy` link: the proxy is 133 bytes of delegatecall and carries none of the ABI you want.',
      etherscan_links: makeEtherscanLinks(MAINNET_CONTRACTS, MAINNET_IMPLEMENTATIONS, 'https://arbiscan.io'),
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
    implementations: TESTNET_IMPLEMENTATIONS,
    upgradeability: {
      proxy: true,
      pattern: 'OpenZeppelin ERC1967Proxy (1,167-byte runtime) with a ProxyAdmin per contract',
      admin_slot: 'set',
      upgrade_entrypoint: 'proxy_admin',
      note:
        'TESTNET IS UPGRADEABLE AND MAINNET IS NOT — do not carry a claim from one to the other. ' +
        'Each testnet proxy has a non-zero EIP-1967 admin slot holding a ProxyAdmin that can ' +
        'replace the implementation. That is deliberate for a surface meant to be iterated, but ' +
        'it means any immutability statement about Gavel is a statement about arbitrum-one only. ' +
        'Observed 2026-08-26.',
    },
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
      full_abis_url: 'https://github.com/JamieFrame/The-Gavel-Protocol',
      abi_note: 'The repository publishes Solidity source, not built ABIs — it is a Foundry project and the out/ directory is not committed. For a ready-to-use ABI, read the verified contract on Arbiscan via etherscan_links — use the `implementation` link, not the `proxy` link.',
      etherscan_links: makeEtherscanLinks(TESTNET_CONTRACTS, TESTNET_IMPLEMENTATIONS, 'https://sepolia.arbiscan.io'),
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
