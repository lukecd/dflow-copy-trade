/**
 * Trade Executor Module
 * 
 * Handles real trading execution via DFlow Trade API
 * Only used when PAPER_TRADE_ONLY=0
 */

import { Connection, Keypair, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { Market } from "./types";

const DFLOW_API_KEY = process.env.DFLOW_API_KEY;
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || "50", 10);

let connection: Connection | null = null;
let keypair: Keypair | null = null;

/**
 * Initialize Solana connection and wallet for real trading
 */
export function initializeTrading(): void {
  if (!process.env.SOLANA_PRIVATE_KEY) {
    throw new Error("SOLANA_PRIVATE_KEY is required for real trading");
  }

  if (!process.env.SOLANA_RPC_URL) {
    throw new Error("SOLANA_RPC_URL is required for real trading");
  }

  // Initialize Solana connection
  connection = new Connection(process.env.SOLANA_RPC_URL, "confirmed");

  // Load wallet from private key (base64 encoded)
  const privateKeyBytes = Buffer.from(process.env.SOLANA_PRIVATE_KEY, "base64");
  keypair = Keypair.fromSecretKey(privateKeyBytes);

  console.log(
    `✅ Trading initialized with wallet: ${keypair.publicKey.toBase58()}`
  );
}

/**
 * Extract outcome token mint addresses from market data
 * @param market Market data from the metadata API
 * @returns Object with yesMint and noMint, or null if not found
 */
export function getOutcomeTokenMints(market: Market): {
  yesMint: string;
  noMint: string;
} | null {
  // The accounts field contains market account data
  // Based on DFlow docs, accounts should have yesMint and noMint
  // Structure may vary - we'll try to extract it
  try {
    // Try to find yesMint and noMint in the accounts object
    // Accounts might be an object with keys, or an array, or nested
    const accounts = market.accounts;
    
    // Try direct access first
    if (typeof accounts === "object" && accounts !== null) {
      // Check if accounts has yesMint/noMint directly
      if ("yesMint" in accounts && "noMint" in accounts) {
        return {
          yesMint: accounts.yesMint as string,
          noMint: accounts.noMint as string,
        };
      }
      
      // Try iterating through account values
      for (const value of Object.values(accounts)) {
        if (typeof value === "object" && value !== null) {
          if ("yesMint" in value && "noMint" in value) {
            return {
              yesMint: (value as any).yesMint as string,
              noMint: (value as any).noMint as string,
            };
          }
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error("Error extracting outcome token mints:", error);
    return null;
  }
}

/**
 * Execute a buy order for prediction market contracts
 * @param inputMint The input token mint (e.g., USDC)
 * @param outputMint The outcome token mint (YES or NO token)
 * @param amount Amount in smallest unit of input token (e.g., for USDC: amount = dollars * 1_000_000)
 * @returns Order response with transaction and execution mode
 */
export async function executeBuyOrder(
  inputMint: string,
  outputMint: string,
  amount: number
): Promise<{ transaction: string; executionMode: "sync" | "async"; signature: string }> {
  if (!connection || !keypair) {
    throw new Error("Trading not initialized. Call initializeTrading() first.");
  }

  const quoteApiEndpoint =
    process.env.DFLOW_QUOTE_API_ENDPOINT || "quote-api.dflow.net";
  const API_BASE_URL = `https://${quoteApiEndpoint}`;

  // Build query parameters for GET /order endpoint
  const queryParams = new URLSearchParams();
  queryParams.append("inputMint", inputMint);
  queryParams.append("outputMint", outputMint);
  queryParams.append("amount", amount.toString());
  queryParams.append("slippageBps", SLIPPAGE_BPS.toString());
  queryParams.append("userPublicKey", keypair.publicKey.toBase58());

  const headers: Record<string, string> = {};
  if (DFLOW_API_KEY) {
    headers["x-api-key"] = DFLOW_API_KEY;
  }

  // Request order from DFlow Trade API
  const response = await fetch(
    `${API_BASE_URL}/order?${queryParams.toString()}`,
    { headers }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create order: ${response.status} ${error}`);
  }

  const orderData = (await response.json()) as {
    transaction: string;
    executionMode: "sync" | "async";
  };

  // Deserialize and sign transaction
  const transactionBuffer = Buffer.from(orderData.transaction, "base64");
  const transaction = VersionedTransaction.deserialize(transactionBuffer);
  transaction.sign([keypair]);

  // Submit transaction
  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    maxRetries: 3,
  });

  return {
    transaction: orderData.transaction,
    executionMode: orderData.executionMode,
    signature,
  };
}

/**
 * Execute a sell/close order for prediction market contracts
 * To close a position, you sell the outcome token back to the settlement token (e.g., USDC)
 * @param inputMint The outcome token mint you're selling (YES or NO token)
 * @param outputMint The settlement token mint (e.g., USDC)
 * @param amount Amount of outcome tokens to sell (in smallest unit)
 * @returns Order response with transaction and execution mode
 */
export async function executeSellOrder(
  inputMint: string,
  outputMint: string,
  amount: number
): Promise<{ transaction: string; executionMode: "sync" | "async"; signature: string }> {
  // For closing, we swap the outcome token back to settlement token
  // This uses the same /order endpoint but with outcome token as input and settlement as output
  return executeBuyOrder(inputMint, outputMint, amount);
}

/**
 * Check order status for async trades
 * @param signature The transaction signature from the order
 * @returns Order status information
 */
export async function checkOrderStatus(signature: string): Promise<{
  status: "open" | "closed" | "pendingClose" | "failed";
  fills?: Array<{ amount: number; price: number }>;
}> {
  const quoteApiEndpoint =
    process.env.DFLOW_QUOTE_API_ENDPOINT || "quote-api.dflow.net";
  const API_BASE_URL = `https://${quoteApiEndpoint}`;

  const headers: Record<string, string> = {};
  if (DFLOW_API_KEY) {
    headers["x-api-key"] = DFLOW_API_KEY;
  }

  const response = await fetch(
    `${API_BASE_URL}/order-status?signature=${signature}`,
    { headers }
  );

  if (!response.ok) {
    throw new Error(`Failed to check order status: ${response.status}`);
  }

  return (await response.json()) as {
    status: "open" | "closed" | "pendingClose" | "failed";
    fills?: Array<{ amount: number; price: number }>;
  };
}

/**
 * Get the actual token balance for a specific mint address
 * @param mintAddress The token mint address
 * @returns Token balance in smallest unit (with decimals), or 0 if account doesn't exist
 */
export async function getTokenBalance(mintAddress: string): Promise<number> {
  if (!connection || !keypair) {
    throw new Error("Trading not initialized. Call initializeTrading() first.");
  }

  try {
    // Get the associated token address for this mint and user's wallet
    const mintPublicKey = new PublicKey(mintAddress);
    const associatedTokenAddress = await getAssociatedTokenAddress(
      mintPublicKey,
      keypair.publicKey
    );

    // Get token account info
    const tokenAccountInfo = await connection.getTokenAccountBalance(associatedTokenAddress);

    if (!tokenAccountInfo.value) {
      return 0;
    }

    // Return balance in smallest unit (raw amount, not UI amount)
    return parseInt(tokenAccountInfo.value.amount);
  } catch (error: any) {
    // If token account doesn't exist, return 0
    if (error.message?.includes("Invalid param") || error.message?.includes("could not find account")) {
      return 0;
    }
    throw error;
  }
}

