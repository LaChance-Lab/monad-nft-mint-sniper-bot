import { Contract, Interface, TransactionReceipt, Wallet, ethers } from "ethers";
import process from "node:process";
import "dotenv/config";

type HexString = `0x${string}`;

interface AppConfig {
  rpcWss: string;
  privateKey: string;
  targetContract: HexString;
  mintAbi: string[];
  mintArgs: unknown[];
  mintValue: bigint;
  gasLimit: bigint;
  maxPriorityFeeGwei: bigint;
  feeBumpFactor: number;
  dryRun: boolean;
}

const DEFAULT_ABI = ["function mint() payable"];

const config: AppConfig = buildConfig();

class NonceManager {
  private locked = false;
  private nonce = -1;

  constructor(private readonly provider: ethers.WebSocketProvider) {}

  async init(address: string) {
    this.nonce = await this.provider.getTransactionCount(address, "latest");
  }

  async next(): Promise<number> {
    while (this.locked) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.locked = true;
    return this.nonce++;
  }

  release() {
    this.locked = false;
  }

  async sync(address: string) {
    const chainNonce = await this.provider.getTransactionCount(address, "latest");
    if (chainNonce > this.nonce) {
      console.warn(`Nonce drift detected. Local ${this.nonce}, chain ${chainNonce}. Syncing.`);
      this.nonce = chainNonce;
    }
  }
}

class MintSniper {
  private provider!: ethers.WebSocketProvider;
  private wallet?: Wallet;
  private contract!: Contract;
  private nonceManager?: NonceManager;
  private mintSelector?: string;

  constructor(private readonly cfg: AppConfig) {}

  async start() {
    await this.bootstrap();
    this.registerEventHandlers();
    console.log(`Sniper ready. Target ${this.cfg.targetContract}`);
  }

  private async bootstrap() {
    this.provider = new ethers.WebSocketProvider(this.cfg.rpcWss);
    try {
      console.log("Connecting to provider...");
      await this.provider.ready;
      console.log("Provider connected.");
    } catch (err) {
      console.error("Provider connection failed.", err);
      this.provider.destroy();
      process.exit(1);
    }

    this.wallet = this.cfg.dryRun ? undefined : new Wallet(this.cfg.privateKey, this.provider);
    this.contract = new Contract(this.cfg.targetContract, this.cfg.mintAbi, this.wallet ?? this.provider);
    this.mintSelector = new Interface(this.cfg.mintAbi).getFunction("mint")?.selector;
    this.nonceManager = new NonceManager(this.provider);

    if (this.wallet) {
      await this.nonceManager.init(await this.wallet.getAddress());
    } else {
      console.log("Running in DRY_RUN mode. Transactions will not be broadcast.");
    }
  }

  private registerEventHandlers() {
    this.provider.on("pending", (txHash: string) => this.handlePending(txHash).catch(() => undefined));
    console.log("Listening to pending txs (if supported).");
    this.provider.on("block", (blockNumber: number) => this.handleBlock(blockNumber).catch(err => console.error("Block handler error", err)));
  }

  private async handlePending(txHash: string) {
    if (!this.mintSelector) return;
    const tx = await this.provider.getTransaction(txHash).catch(() => undefined);
    if (!tx || !tx.to || tx.to.toLowerCase() !== this.cfg.targetContract.toLowerCase()) return;
    if (tx.data?.startsWith(this.mintSelector)) {
      console.log("Detected pending mint call:", txHash, "from", tx.from);
      await this.attemptMint();
    }
  }

  private async handleBlock(blockNumber: number) {
    if (!this.mintSelector) return;
    const block = await this.provider.getBlock(blockNumber);
    if (!block) return;
    for (const txHash of block.transactions) {
      const tx = await this.provider.getTransaction(txHash);
      if (!tx || !tx.to || tx.to.toLowerCase() !== this.cfg.targetContract.toLowerCase()) continue;
      if (tx.data?.startsWith(this.mintSelector)) {
        console.log("Detected mint call in block:", tx.hash);
        await this.attemptMint();
      }
    }
  }

  private async attemptMint() {
    const basePriority = await this.getPriorityFee();
    try {
      await this.buildAndSendMint(basePriority);
      return;
    } catch (err) {
      console.warn("Initial send failed:", (err as Error).message);
    }

    const bumped = this.bumpPriority(basePriority);
    try {
      console.log("Retrying with bumped priority:", ethers.formatUnits(bumped, "gwei"), "gwei");
      await this.buildAndSendMint(bumped);
    } catch (err) {
      console.error("Retry failed:", (err as Error).message);
    }
  }

  private bumpPriority(base: bigint) {
    const baseGwei = Number(ethers.formatUnits(base, "gwei"));
    const bumpedGwei = Math.ceil(baseGwei * this.cfg.feeBumpFactor);
    return ethers.parseUnits(String(bumpedGwei), "gwei");
  }

  private async getPriorityFee(): Promise<bigint> {
    const feeData = await this.provider.getFeeData();
    const priority = feeData.maxPriorityFeePerGas;
    if (!priority) throw new Error("Could not fetch priority fee.");

    const maxPriority = ethers.parseUnits(this.cfg.maxPriorityFeeGwei.toString(), "gwei");
    return priority > maxPriority ? maxPriority : priority;
  }

  private async buildAndSendMint(priorityFee: bigint): Promise<TransactionReceipt | undefined> {
    if (!this.contract || !this.mintSelector) throw new Error("Contract not initialized.");
    const nonceMgr = this.nonceManager;
    const signer = this.wallet;

    if (!nonceMgr) throw new Error("Nonce manager unavailable.");
    const nonce = await nonceMgr.next();

    const txRequest = await this.contract.mint.populateTransaction(...this.cfg.mintArgs, {
      value: this.cfg.mintValue,
      gasLimit: this.cfg.gasLimit,
      maxPriorityFeePerGas: priorityFee,
      nonce,
    });

    if (this.cfg.dryRun || !signer) {
      console.log("DRY RUN tx:", {
        to: txRequest.to,
        priorityGwei: Number(ethers.formatUnits(priorityFee, "gwei")),
        data: txRequest.data,
      });
      nonceMgr.release();
      return undefined;
    }

    try {
      const sentTx = await signer.sendTransaction(txRequest);
      console.log("Tx sent:", sentTx.hash, "nonce:", nonce);
      const receipt = await sentTx.wait(1);
      console.log("Receipt status:", receipt?.status ?? "unknown", "hash:", sentTx.hash);
      await nonceMgr.sync(await signer.getAddress());
      return receipt ?? undefined;
    } finally {
      nonceMgr.release();
    }
  }
}

function buildConfig(): AppConfig {
  const required = ["RPC_WSS", "PRIVATE_KEY", "TARGET_CONTRACT"] as const;
  required.forEach(key => {
    if (!process.env[key]) {
      console.error(`Missing required env ${key}. Check your .env file.`);
      process.exit(1);
    }
  });

  if (process.env.PRIVATE_KEY === "0xYOUR_BURNER_PRIVATE_KEY") {
    console.error("Replace YOUR_BURNER_PRIVATE_KEY with a valid key.");
    process.exit(1);
  }

  return {
    rpcWss: process.env.RPC_WSS!,
    privateKey: process.env.PRIVATE_KEY!,
    targetContract: process.env.TARGET_CONTRACT! as HexString,
    mintAbi: parseJson<string[]>("MINT_ABI", DEFAULT_ABI),
    mintArgs: parseJson<unknown[]>("MINT_ARGS", []),
    mintValue: BigInt(process.env.MINT_VALUE ?? "0"),
    gasLimit: BigInt(process.env.GAS_LIMIT ?? "500000"),
    maxPriorityFeeGwei: BigInt(process.env.MAX_PRIORITY_FEE_GWEI ?? "50"),
    feeBumpFactor: Number(process.env.FEE_BUMP_FACTOR ?? "1.5"),
    dryRun: Boolean(Number(process.env.DRY_RUN ?? "1")),
  };
}

function parseJson<T>(envKey: string, fallback: T): T {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Failed to parse ${envKey}. Using fallback.`);
    return fallback;
  }
}

(async () => {
  const sniper = new MintSniper(config);
  await sniper.start();
})();
