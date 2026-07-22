import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireTier } from '../../tiers.js';

// ============================================================================
// list_wallet_options — Layer C external integration catalog (Phase 1.5).
//
// Returns a catalog of wallet applications compatible with Gavel (i.e., that
// support Arbitrum One). Filtered by platform — does NOT rank wallets by
// quality. Internal order is alphabetical.
//
// The description gives an LLM enough context to surface the right choice
// for a novice user without the tool itself prescribing one — for example,
// the `recommended_for` field tags wallets with their typical user fit
// ('beginner', 'mobile-first', 'hardware') as factual attributes, leaving
// the matching to the LLM and the user.
// ============================================================================

interface WalletOption {
  name: string;
  platforms: string[];
  download_url: string;
  supports_arbitrum_one: true;
  custody_model: 'self_custody' | 'mpc' | 'smart_account';
  has_built_in_simulation: boolean;
  has_hardware_support: boolean;
  recommended_for: string[];
  notes: string;
}

const CATALOG: WalletOption[] = [
  {
    name: 'Coinbase Wallet',
    platforms: ['ios', 'android', 'browser_extension'],
    download_url: 'https://www.coinbase.com/wallet/downloads',
    supports_arbitrum_one: true,
    custody_model: 'self_custody',
    has_built_in_simulation: false,
    has_hardware_support: true,
    recommended_for: ['beginner', 'coinbase_user'],
    notes: 'Self-custody wallet from Coinbase, separate from the Coinbase exchange account. Smoothest onboarding for users already familiar with the Coinbase brand. Recovery phrase backup required.',
  },
  {
    name: 'Frame',
    platforms: ['desktop'],
    download_url: 'https://frame.sh',
    supports_arbitrum_one: true,
    custody_model: 'self_custody',
    has_built_in_simulation: false,
    has_hardware_support: true,
    recommended_for: ['desktop_power_user', 'multi_chain'],
    notes: 'Desktop-native wallet that connects via system-wide protocol handler. Strong hardware wallet integration (Ledger, Trezor, GridPlus). Power-user tool, not for beginners.',
  },
  {
    name: 'Ledger (with Ledger Live)',
    platforms: ['hardware'],
    download_url: 'https://www.ledger.com',
    supports_arbitrum_one: true,
    custody_model: 'self_custody',
    has_built_in_simulation: false,
    has_hardware_support: true,
    recommended_for: ['high_value', 'hardware', 'long_term_holder'],
    notes: 'Hardware wallet — private key never leaves the device. Pairs with software wallets (Rabby, MetaMask) for daily use; signing happens on-device. Recommended for any deployment over a few thousand USD.',
  },
  {
    name: 'MetaMask',
    platforms: ['ios', 'android', 'browser_extension'],
    download_url: 'https://metamask.io/download',
    supports_arbitrum_one: true,
    custody_model: 'self_custody',
    has_built_in_simulation: false,
    has_hardware_support: true,
    recommended_for: ['general_purpose'],
    notes: 'The most widely-supported wallet in DeFi. Familiar UX, but transaction summaries are more cryptic than newer alternatives. Pairs well with hardware wallets via the bridge feature.',
  },
  {
    name: 'Rabby',
    platforms: ['ios', 'android', 'browser_extension', 'desktop'],
    download_url: 'https://rabby.io',
    supports_arbitrum_one: true,
    custody_model: 'self_custody',
    has_built_in_simulation: true,
    has_hardware_support: true,
    recommended_for: ['beginner', 'safety_conscious', 'first_time_defi'],
    notes: 'Built-in transaction simulation shows the user what a transaction will do BEFORE signing — catches drainer scams and incorrect approve calls. Strong safety UX makes it well-suited to first-time DeFi users. Cross-platform.',
  },
  {
    name: 'Safe (Gnosis Safe)',
    platforms: ['browser_extension', 'mobile_app'],
    download_url: 'https://safe.global',
    supports_arbitrum_one: true,
    custody_model: 'smart_account',
    has_built_in_simulation: true,
    has_hardware_support: true,
    recommended_for: ['multisig', 'team_treasury', 'institutional'],
    notes: 'Multisig smart-account wallet — multiple keys must sign. Standard for team treasuries and institutional self-custody. Higher complexity than EOAs but stronger security model. Each transaction requires the threshold number of signers to approve.',
  },
  {
    name: 'Trezor (with Trezor Suite)',
    platforms: ['hardware'],
    download_url: 'https://trezor.io',
    supports_arbitrum_one: true,
    custody_model: 'self_custody',
    has_built_in_simulation: false,
    has_hardware_support: true,
    recommended_for: ['high_value', 'hardware', 'open_source_preference'],
    notes: 'Hardware wallet alternative to Ledger; fully open-source firmware. Same usage pattern: pair with a software wallet for daily transactions, sign on-device.',
  },
  {
    name: 'Trust Wallet',
    platforms: ['ios', 'android', 'browser_extension'],
    download_url: 'https://trustwallet.com',
    supports_arbitrum_one: true,
    custody_model: 'self_custody',
    has_built_in_simulation: false,
    has_hardware_support: false,
    recommended_for: ['mobile_first'],
    notes: 'Mobile-first wallet with broad chain support. Owned by Binance but operates as an independent self-custody wallet. Good for users who prefer phone over desktop.',
  },
];

export function registerListWalletsTool(server: McpServer): void {
  server.registerTool(
    'list_wallet_options',
    {
      title: 'Compatible Wallet Catalog',
      description:
        `Returns a catalog of self-custody wallet apps compatible with Gavel ` +
        `(i.e., that support Arbitrum One). Does not rank wallets by quality. ` +
        `Each entry has a 'recommended_for' tag list describing the typical ` +
        `user fit as factual attributes ('beginner', 'mobile_first', 'hardware', ` +
        `'multisig', etc.) — the LLM and user pick based on those.\n\n` +
        `Useful for: an LLM agent helping a user without an existing wallet ` +
        `choose one before onramping funds. The LLM should explain the ` +
        `custody-model and platform implications relevant to the user's ` +
        `situation, then let the user pick.\n\n` +
        `Returns: { wallets: WalletOption[], filter_echo, notes }.`,
      inputSchema: {
        platform: z
          .enum(['ios', 'android', 'browser_extension', 'desktop', 'hardware', 'mobile_app'])
          .optional()
          .describe(`Filter wallets to those available on the specified platform. Omit to return all.`),
      },
    },
    async ({ platform }) => {
      requireTier('free');

      const filtered = platform
        ? CATALOG.filter((w) => w.platforms.includes(platform))
        : CATALOG;

      const response = {
        wallets: filtered,
        filter_echo: { platform: platform ?? null },
        notes:
          filtered.length === 0
            ? `No wallets matched the filter. Try a different platform or omit the filter.`
            : `${filtered.length} wallet(s) match. Entries are alphabetical, not ranked. The user picks based on their situation; the LLM can help by explaining custody-model and platform implications.`,
        catalog_disclaimer:
          'Wallet information is hand-maintained and refreshed per release. Features and support may have changed since this catalog was last updated. Verify current capabilities on each wallet\'s site.',
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
