// Internal channel where all partner inquiries are posted
export const ASSISTANT_CHANNEL_ID = 'C0AMG5WTMDK';

// Whitelist of channels the bot is allowed to post to.
// Add more internal channel IDs here as needed.
export const ALLOWED_POST_CHANNELS = new Set([
  'C0AMG5WTMDK', // #partners-assistant
]);

// Bot's own Slack user ID — skip messages from itself
export const BOT_USER_ID = 'U0AM4D8B01M';

// Team roster — Slack ID → name + what they handle
// Expertise derived from GitHub contribution analysis across all Breez repos
export const TEAM = {
  'U04SQF99B8S': { name: 'Ivan',    handles: 'QA, GitHub issues, Lightning address bugs, onchain deposit and claim issues, channel lifecycle, stuck transactions, scam and security reports, general escalations — not SDK internals' },
  'UDAHFACAC':   { name: 'Roy',     handles: 'Partnership decisions, business questions, feature roadmap, company strategy, press and public announcements' },
  'U05F5QSCKS7': { name: 'Ross',    handles: 'Spark SDK integration across all platforms (React Native, Go, Swift, Flutter bindings), Spark SDK core, glow-web wallet client, stable-balance and token features (bitcoin↔token conversions, USD stable mode), SSR/WASM packaging, client-side LNURL, build errors and SDK setup, API key provisioning' },
  'U0853N6R0TA': { name: 'Daniel',  handles: 'Spark payment failures, Spark leaf sync issues, missing balance and transaction states, Spark SDK internals, transaction debugging, Boltz cross-chain swaps (BTC↔USDT via Boltz), deposit address handling (single-use vs. static, pending deposits), data-sync / syncer server authentication (user-agent, API key, pubkey logging)' },
  'U043BRYE79V': { name: 'Jesse',   handles: 'Spark SDK core protocol (lead), Spark connectivity and node issues, LSP infrastructure, BOLT12, Spark-to-Spark transfers, Spark payment notification behavior, LNURL-server (sign-webhooks, allowed-domain auto-refresh, millisatoshi HTLC formats), Spark postgres / token-store backend' },
  'UDB9VJ37U':   { name: 'Yaacov', handles: 'Server infrastructure, lnd node, breez-server backend, critical service outages, ChainSync failures, API-not-ready errors, backend connectivity' },
  'UDB4XJZL4':   { name: 'Roei',    handles: 'Protocol architecture and R&D (Spark, ARK, Lightning design), SDK core architecture, Liquid SDK architecture, external signer, BOLT12 roadmap, USDB, Sparkscan and indexing design' },
  'U0650T5K3MZ': { name: 'Antonio', handles: 'Breez SDK Liquid core library maintainer (lib packaging, version bumps, clippy/rustc upgrades, swap fields, JWT auth, payment_hash dedup, side-swap USDT↔LBTC, bindings compatibility), misty-breez mobile releases (foreground service, version bumps, NWC webhook fixes), NWC / Nostr Wallet Connect, sdk-plugins crate (NIP-47 plugin storage, uniffi bindings — sole committer)' },
  'U074L9SHECR': { name: 'Danny',   handles: 'Marketing content, public announcements, press, company news only — never route technical questions here' },
  'UDL28AYSK':   { name: 'Erdem',   handles: 'Mobile apps (glow-flutter Bitcoin wallet, Misty-breez Flutter app, legacy breezmobile Dart app), iOS/Android builds and app store releases, SDK example apps & CLI tooling, dSYM shipping for Spark iOS xcframework, passkey integration, Buy-Bitcoin provider wiring (CashApp), mobile-specific crashes' },
  'U0AUPKBMW3S': { name: 'Maria',   handles: 'Business development and new-partner onboarding, setting up new partner Slack channels and Telegram groups, first-touch inquiries from companies that are assessing or beginning to evaluate the Breez SDK for integration, partnership setup and commercial-contact questions from prospects that have not started integrating yet — not technical SDK debugging, production issues, or existing-partner support tickets' },
};

export const TEAM_IDS = new Set(Object.keys(TEAM));

// Reverse lookup: name → Slack user ID (for mentions)
export const TEAM_ID_BY_NAME = Object.fromEntries(
  Object.entries(TEAM).map(([id, { name }]) => [name, id])
);

// Telegram IDs for team members — loaded from config.private.js, which is
// gitignored. Slack IDs above stay in the public repo (they only work inside
// our workspace); Telegram IDs are globally addressable so we keep them out.
// If config.private.js is missing the bot will fail to start — preflight
// enforces this.
export { BREEZ_TEAM_TELEGRAM_IDS, TELEGRAM_ID_TO_NAME } from './config.private.js';
