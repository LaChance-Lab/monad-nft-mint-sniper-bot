# Monad NFT Mint Sniper Bot

High-performance minting assistant tailored for the Monad ecosystem. The bot
monitors upcoming drops, estimates transaction success probability, and submits
optimized mint transactions faster than manual workflows.

## Features

- Real-time drop watcher with customizable allowlists and filters
- Gas-optimized transaction builder with automatic priority fee tuning
- Pluggable strategy layer for Dutch auctions, FCFS mints, and raffles
- Webhook and CLI notifications for status changes and on-chain events
- Built-in dry-run simulator to verify strategy logic before funding

## Contact
https://t.me/lachancelab

## Requirements

| Tool            | Version (min) |
|-----------------|---------------|
| Node.js         | 18 LTS        |
| pnpm or npm     | Latest        |
| Monad RPC       | HTTPS access  |

Set the following environment variables before running the bot:

- `RPC_URL` – HTTPS RPC endpoint with low latency to Monad
- `PRIVATE_KEY` – Wallet key used for minting (store securely)
- `MONAD_EXPLORER_URL` – Optional; used for deep linking in notifications

## Getting Started

```bash
git clone https://github.com/<your-org>/monad-nft-mint-sniper-bot.git
cd monad-nft-mint-sniper-bot
pnpm install        # or npm install
cp .env.example .env
pnpm start
```

Configure drop targets in `config/drops.json` and strategy parameters in
`config/strategies/*.ts`. Use `pnpm test` to run unit tests and the included
simulator.

## Security Notes

- Never commit `.env` files or private keys
- Use read-only RPC keys for monitoring nodes
- Limit wallet permissions and fund only what is necessary for each drop

## License

Distributed under the MIT License. See `LICENSE` for more information.