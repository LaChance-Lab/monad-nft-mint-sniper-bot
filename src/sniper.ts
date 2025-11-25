import { ethers, Contract, Wallet, TransactionResponse, TransactionReceipt, Interface } from "ethers";
import "dotenv/config";

// --- CONFIG ---
const RPC_WSS = process.env.RPC_WSS as string;
const PRIVATE_KEY = process.env.PRIVATE_KEY as string;
const TARGET_CONTRACT = process.env.TARGET_CONTRACT as string;
const MINT_ABI = process.env.MINT_ABI ? JSON.parse(process.env.MINT_ABI) : ["function mint() payable"];
const MINT_ARGS = process.env.MINT_ARGS ? JSON.parse(process.env.MINT_ARGS) : [];
const MINT_VALUE = BigInt(process.env.MINT_VALUE || "0");
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT || "500000");
const MAX_PRIORITY_FEE_GWEI = BigInt(process.env.MAX_PRIORITY_FEE_GWEI || "50");
const FEE_BUMP_FACTOR = parseFloat(process.env.FEE_BUMP_FACTOR || "1.5");
const DRY_RUN = !!parseInt(process.env.DRY_RUN || "1");

// --- GLOBALS ---
let provider: ethers.WebSocketProvider;
let wallet: Wallet | undefined;
let contract: Contract;
const MINT_SELECTOR = new Interface(MINT_ABI).getFunction("mint")?.selector;

class NonceManager {
  private locked = false;
  private nonce = -1;
  private provider: ethers.WebSocketProvider;

  constructor(provider: ethers.WebSocketProvider) {
    this.provider = provider;
  }

  async init(address: string) {
    this.nonce = await this.provider.getTransactionCount(address, "latest");
  }

  async getNonce() {
    while (this.locked) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.locked = true;
    return this.nonce++;
  }

  release() {
    this.locked = false;
  }

  async syncIfBehind(address: string) {
    const onChainNonce = await this.provider.getTransactionCount(address, "latest");
    if (onChainNonce > this.nonce) {
      console.log(`Nonce out of sync. Local: ${this.nonce}, On-chain: ${onChainNonce}. Syncing...`);
      this.nonce = onChainNonce;
    }
  }
}

let nonceManager: NonceManager;

(async function main() {
  // --- VALIDATION ---
  if (!RPC_WSS || !PRIVATE_KEY || !TARGET_CONTRACT) {
    console.error("Missing required environment variables. Check your .env file.");
    process.exit(1);
  }

  if (process.env.PRIVATE_KEY === "0xYOUR_BURNER_PRIVATE_KEY") {
    console.error("Please replace YOUR_BURNER_PRIVATE_KEY in your .env file with a valid private key.");
    process.exit(1);
  }

  console.log("--- CONFIGURATION ---");
  console.log("RPC_WSS:", RPC_WSS);
  console.log("TARGET_CONTRACT:", TARGET_CONTRACT);
  console.log("DRY_RUN:", DRY_RUN);
  console.log("---------------------");

  provider = new ethers.WebSocketProvider(RPC_WSS);
  try {
    console.log("Connecting to provider...");
    await provider.ready;
    console.log("Provider connected.");
  } catch (e) {
    console.error("Could not connect to provider.", e);
    provider.destroy();
    process.exit(1);
  }

  nonceManager = new NonceManager(provider);
  wallet = DRY_RUN ? undefined : new ethers.Wallet(PRIVATE_KEY, provider);
  contract = new Contract(TARGET_CONTRACT, MINT_ABI, wallet || provider);

  // --- FUNCTIONS ---

  async function getPriorityFee(): Promise<bigint> {
    const feeData = await provider.getFeeData();
    const priorityFee = feeData.maxPriorityFeePerGas;
    if (!priorityFee) {
      throw new Error("Could not get priority fee");
    }
    const maxPriorityGwei = ethers.parseUnits(MAX_PRIORITY_FEE_GWEI.toString(), "gwei");
    return priorityFee > maxPriorityGwei ? maxPriorityGwei : priorityFee;
  }

  async function buildAndSendMint(priorityFee: bigint): Promise<TransactionReceipt | undefined> {
    if (!wallet) {
      throw new Error("Wallet not initialized");
    }
    const addr = await wallet.getAddress();
    const nonce = await nonceManager.getNonce();

    const tx = await contract.mint.populateTransaction(...MINT_ARGS, {
      value: MINT_VALUE,
      gasLimit: GAS_LIMIT,
      maxPriorityFeePerGas: priorityFee,
      nonce: nonce,
    });

    if (DRY_RUN) {
      console.log("DRY RUN: tx built:", {
        to: tx.to,
        data: tx.data,
        value: tx.value?.toString(),
        gasLimit: tx.gasLimit?.toString(),
        priorityGwei: Number(ethers.formatUnits(priorityFee, "gwei")),
      });
      nonceManager.release();
      return;
    }

    try {
      const sent = await wallet.sendTransaction(tx);
      console.log("Tx sent:", sent.hash, "nonce:", nonce.toString(), "priority(gwei):", Number(ethers.formatUnits(priorityFee, "gwei")));

      const receipt = await sent.wait(1);
      if (receipt) {
        console.log("Receipt status:", receipt.status ?? "unknown", "tx:", sent.hash);
      } else {
        console.log("Receipt is null for tx:", sent.hash);
      }

      await nonceManager.syncIfBehind(addr);
      nonceManager.release();
      return receipt ?? undefined;
    } catch (err: any) {
      nonceManager.release();
      throw err;
    }
  }

  async function attemptMintWithBump() {
    const base = await getPriorityFee();
    try {
      await buildAndSendMint(base);
    } catch (e) {
      const baseGwei = Number(ethers.formatUnits(base, "gwei"));
      const bumpedGwei = Math.ceil(baseGwei * FEE_BUMP_FACTOR);
      const bumped = ethers.parseUnits(String(bumpedGwei), "gwei");
      console.log("Initial send failed; retrying with bumped priority:", bumpedGwei, "gwei");
      try {
        await buildAndSendMint(bumped);
      } catch (err: any) {
        console.error("Retry also failed:", err?.message ?? err);
      }
    }
  }

  async function handlePending(txHash: string) {
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx || !tx.to) return;
      if (tx.to.toLowerCase() !== TARGET_CONTRACT.toLowerCase()) return;
      if (!tx.data || !MINT_SELECTOR) return;
      if (tx.data.startsWith(MINT_SELECTOR)) {
        console.log("Detected pending mint call:", txHash, "from", tx.from);
        await attemptMintWithBump();
      }
    } catch {
      // ignore transient errors
    }
  }

  async function handleBlock(blockNumber: number) {
    try {
      const block = await provider.getBlock(blockNumber);
      if (!block) return;
      for (const txHash of block.transactions) {
          const tx = await provider.getTransaction(txHash);
          if (!tx || !tx.to) continue;
          if (tx.to.toLowerCase() !== TARGET_CONTRACT.toLowerCase()) continue;
          if (tx.data && MINT_SELECTOR && tx.data.startsWith(MINT_SELECTOR)) {
              console.log("Detected mint call in block tx:", tx.hash);
              await attemptMintWithBump();
          }
      }
    } catch (err) {
      console.error("Block handler error:", err);
    }
  }

  if (wallet) {
    await nonceManager.init(await wallet.getAddress());
  } else {
    console.log("No wallet loaded — running in DRY_RUN mode (signing/broadcast disabled).");
  }

  provider.on("pending", handlePending);
  console.log("Listening to pending txs (if provider supports it).");

  provider.on("block", handleBlock);

  console.log("Sniper started. Target:", TARGET_CONTRACT);
})();
