import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireTier } from '../../tiers.js';

// ============================================================================
// list_fiat_onramps — Layer C external integration catalog (Phase 1.5).
//
// Returns a hand-maintained catalog of fiat-to-USDC-on-Arbitrum onramps with
// fees, KYC requirements, and supported jurisdictions. Filtered by the
// caller's country / amount / chain — does NOT rank providers by quality.
// Internal order is alphabetical so the response is deterministic and
// auditable.
//
// RENAMED 2026-08-26: recommend_fiat_onramp -> list_fiat_onramps.
//
// The old name was a deliberate choice, justified here as "that's what users
// will ask for in natural language", under the AI Concierge spec §12. Both
// halves of that justification are now gone. The concierge is retired
// (aletheia-docs data/canonical/surfaces_v1_1_amendment.md), so no Aletheia-
// hosted model is translating a human's phrasing into a tool name; and the
// public-copy editorial guideline v1.2 makes a TOOL NAME public copy in its
// own right, with "recommend" barred of onramps, wallets, venues and tenors.
//
// A careful description underneath a name that says "recommend" does not
// cure it: the name is what appears in a client's tool list, and it is the
// string most likely to be read alone.
// ============================================================================

interface OnrampProvider {
  provider: string;
  fiat_methods: string[];
  delivers_native_usdc_arbitrum: boolean;
  fee_pct_estimate_low: number;
  fee_pct_estimate_high: number;
  fee_notes: string;
  kyc_required: boolean;
  kyc_typical_duration: string;
  supported_countries: string[]; // ISO 3166 alpha-2; ['*'] means worldwide
  amount_limits_usd: { min?: number; max?: number; notes?: string };
  deeplink: string;
  notes: string;
}

const CATALOG: OnrampProvider[] = [
  {
    provider: 'Coinbase',
    fiat_methods: ['bank_transfer', 'card', 'apple_pay', 'google_pay'],
    delivers_native_usdc_arbitrum: true,
    fee_pct_estimate_low: 0.0,
    fee_pct_estimate_high: 3.99,
    fee_notes: 'Bank transfer is the cheapest path (~0-1%); card payments incur ~3.5-4% fee.',
    kyc_required: true,
    kyc_typical_duration: 'minutes to 24h for most retail users',
    supported_countries: ['US', 'GB', 'DE', 'FR', 'IE', 'IT', 'ES', 'NL', 'PT', 'AT', 'BE', 'FI', 'SE', 'NO', 'DK', 'PL', 'CA', 'AU', 'SG', 'JP'],
    amount_limits_usd: { min: 1, max: 50_000, notes: 'Daily limits scale with account age and verification level.' },
    deeplink: 'https://www.coinbase.com/onramp',
    notes: 'Native USDC delivery on Arbitrum One supported. Lowest-friction onramp for most retail users in supported countries. Bank transfer takes 1-3 days; card delivery is near-instant but pricier.',
  },
  {
    provider: 'MoonPay',
    fiat_methods: ['card', 'bank_transfer', 'apple_pay', 'google_pay', 'sepa'],
    delivers_native_usdc_arbitrum: true,
    fee_pct_estimate_low: 1.0,
    fee_pct_estimate_high: 4.5,
    fee_notes: 'SEPA bank transfer ~1%, card ~3-4.5% depending on country.',
    kyc_required: true,
    kyc_typical_duration: '5-30 minutes for basic verification',
    supported_countries: ['*'],
    amount_limits_usd: { min: 30, max: 50_000 },
    deeplink: 'https://www.moonpay.com/buy/usdc',
    notes: 'Widest country coverage in the catalog (~160 countries). Higher card fees than Coinbase but accepts customers Coinbase rejects geographically.',
  },
  {
    provider: 'Ramp Network',
    fiat_methods: ['card', 'bank_transfer', 'sepa', 'apple_pay', 'google_pay'],
    delivers_native_usdc_arbitrum: true,
    fee_pct_estimate_low: 0.49,
    fee_pct_estimate_high: 2.9,
    fee_notes: 'SEPA/open banking ~0.49-1%, cards ~2.9%.',
    kyc_required: true,
    kyc_typical_duration: '5-15 minutes',
    supported_countries: ['GB', 'DE', 'FR', 'IE', 'IT', 'ES', 'NL', 'PT', 'AT', 'BE', 'FI', 'SE', 'NO', 'DK', 'PL', 'CZ', 'GR', 'RO', 'BG', 'US', 'CA', 'AU', 'BR'],
    amount_limits_usd: { min: 20, max: 30_000 },
    deeplink: 'https://ramp.network/buy',
    notes: 'EU-headquartered, strong UK/EU coverage with cheap SEPA-rail transfers. Open banking flow available in supported countries — often the cheapest path for EU users.',
  },
  {
    provider: 'Stripe Crypto Onramp',
    fiat_methods: ['card', 'bank_transfer', 'apple_pay', 'google_pay'],
    delivers_native_usdc_arbitrum: true,
    fee_pct_estimate_low: 1.5,
    fee_pct_estimate_high: 3.5,
    fee_notes: 'Card ~3.5%, bank transfer ~1.5%.',
    kyc_required: true,
    kyc_typical_duration: '2-10 minutes; Stripe leverages existing identity if user has a Stripe account',
    supported_countries: ['US', 'GB', 'DE', 'FR', 'IE', 'IT', 'ES', 'NL', 'PT', 'AT', 'BE'],
    amount_limits_usd: { min: 1, max: 30_000 },
    deeplink: 'https://crypto.link.com',
    notes: 'Lowest UX friction for users who already have a Stripe (Link) account; passwordless flow.',
  },
  {
    provider: 'Transak',
    fiat_methods: ['card', 'bank_transfer', 'sepa', 'apple_pay', 'google_pay'],
    delivers_native_usdc_arbitrum: true,
    fee_pct_estimate_low: 0.99,
    fee_pct_estimate_high: 5.5,
    fee_notes: 'SEPA ~1%, cards ~3-5.5%.',
    kyc_required: true,
    kyc_typical_duration: '5-30 minutes',
    supported_countries: ['*'],
    amount_limits_usd: { min: 30, max: 25_000 },
    deeplink: 'https://global.transak.com',
    notes: 'Broad global coverage (~125 countries). Often a fallback when other onramps reject a user.',
  },
];

const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/;

export function registerOnrampsTool(server: McpServer): void {
  server.registerTool(
    'list_fiat_onramps',
    {
      title: 'Fiat Onramp Catalog',
      description:
        `Returns a catalog of fiat-to-USDC onramps that deliver native USDC on ` +
        `the requested chain. Does not rank or endorse a specific provider — ` +
        `entries are listed alphabetically so the response is deterministic. ` +
        `The user chooses which onramp to use.\n\n` +
        `Filter by country (ISO 3166 alpha-2) and amount to narrow the catalog ` +
        `to providers that operate in the user's jurisdiction and accept their ` +
        `transaction size.\n\n` +
        `Useful for: an LLM agent helping a novice user fund their wallet from ` +
        `fiat USD/EUR/GBP. The LLM presents the catalog to the user; the user ` +
        `picks one and proceeds.\n\n` +
        `IMPORTANT — a cold-start user needs TWO purchases, not one. None of ` +
        `these providers delivers gas ETH alongside the USDC. A wallet holding ` +
        `only USDC cannot transact at all, and the failure is opaque (the ` +
        `transaction simply will not send). Surface the gas purchase to the ` +
        `user at the same time as the USDC purchase — see 'gas_requirement' ` +
        `in the response.\n\n` +
        `Returns: { providers: OnrampProvider[], gas_requirement, filter_echo, notes }.`,
      inputSchema: {
        country: z
          .string()
          .optional()
          .describe(`ISO 3166 alpha-2 country code (e.g. 'US', 'GB', 'FR'). Filters to providers supporting that country. Omit to return all providers.`),
        amount_usd: z
          .number()
          .optional()
          .describe(`Amount in USD the user plans to onramp. Filters out providers whose limits don't cover this amount. Omit to ignore amount limits.`),
        chain: z
          .enum(['arbitrum-one'])
          .default('arbitrum-one')
          .describe(`Target chain. Currently only 'arbitrum-one' supported — all listed providers deliver native USDC on Arbitrum One.`),
      },
    },
    async ({ country, amount_usd }) => {
      requireTier('free');

      // Normalise country code to uppercase if provided
      const cc = country?.toUpperCase();
      if (cc != null && !COUNTRY_CODE_REGEX.test(cc)) {
        const response = {
          providers: [],
          filter_echo: { country, amount_usd },
          notes: `Country '${country}' is not a valid ISO 3166 alpha-2 code. Use 'US', 'GB', 'FR' etc.`,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
        };
      }

      const filtered = CATALOG.filter((p) => {
        if (cc) {
          const supportsCountry = p.supported_countries.includes('*') || p.supported_countries.includes(cc);
          if (!supportsCountry) return false;
        }
        if (amount_usd != null) {
          if (p.amount_limits_usd.min != null && amount_usd < p.amount_limits_usd.min) return false;
          if (p.amount_limits_usd.max != null && amount_usd > p.amount_limits_usd.max) return false;
        }
        return true;
      });

      const response = {
        providers: filtered,
        // R18 Phase 6 / MD11 — the two-purchase reality.
        //
        // Verified 2026-07-21 against the providers' own APIs (MoonPay
        // /v3/currencies, Ramp /host-api/v3/assets, the Transak catalogue):
        // none of them delivers gas ETH together with the USDC. Both assets
        // exist on Arbitrum One at all three, but as two separate purchases,
        // each with its own euro minimum.
        //
        // This is stated unconditionally rather than as a footnote because a
        // user funded with USDC and no ETH is stuck in a way that gives no
        // useful error — the single most likely place for a cold-start
        // concierge session to fail silently.
        gas_requirement: {
          summary:
            'Two separate purchases are required. USDC is what you lend or borrow; ETH on Arbitrum One is what pays network fees. No provider in this catalogue delivers both in one transaction.',
          native_gas_token: 'ETH (on Arbitrum One)',
          why: 'Every on-chain action — approving a token, placing a bid, creating an auction, repaying — costs a small ETH network fee. A wallet holding only USDC cannot send any transaction.',
          typical_need_eth: '0.002–0.005 ETH covers many transactions; Arbitrum fees are small.',
          minimum_purchase_note:
            'Each provider enforces its own minimum per purchase, so the ETH order is often floored well above what the gas actually costs — roughly €12 at the cheapest observed (Ramp) up to ~€40 (MoonPay). Compare minimums before choosing.',
          verified_on: '2026-07-21',
        },
        filter_echo: { country: cc, amount_usd, chain: 'arbitrum-one' },
        notes: filtered.length === 0
          ? `No providers matched the filter. Consider relaxing the criteria — most users in unlisted countries can still onramp through MoonPay or Transak (broadest country coverage).`
          : `${filtered.length} provider(s) match. The user chooses one based on their own preferences; this catalog is descriptive, not a ranking.`,
        catalog_disclaimer: 'Provider information is hand-maintained and refreshed per release. Fees and country coverage may have changed since this catalog was last updated. Verify current terms on each provider\'s site before transacting.',
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
