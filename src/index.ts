#!/usr/bin/env node

/**
 * DFlow Copy Trading Bot
 * 
 * A TypeScript CLI tool for automated copy trading on DFlow's Kalshi prediction markets.
 * Uses real-time momentum detection from WebSocket trade data to identify and execute
 * paper trading positions.
 * 
 * Key features:
 * - Real-time trade monitoring via WebSocket
 * - Momentum-based entry signals
 * - Fixed dollar amount position sizing
 * - Automatic profit target and stop loss management
 * - Cooldown periods to prevent repeated entries
 * - Automatic WebSocket reconnection
 * - Performance metrics tracking and logging
 */

import WebSocket from "ws";
import dotenv from "dotenv";
import { writeFileSync, appendFileSync, existsSync } from "fs";
import { join } from "path";
import { TradeUpdate, Market, MomentumMetrics, Position } from "./types";
import { startServer, stopServer } from "./server";
import {
  initializeTrading,
  getOutcomeTokenMints,
  executeBuyOrder,
  executeSellOrder,
  checkOrderStatus,
  getTokenBalance,
} from "./trade-executor";

// Load environment variables from .env file
dotenv.config();

// Validate required configuration
const endpoint = process.env.DFLOW_ENDPOINT;
if (!endpoint || endpoint.trim() === "") {
  console.error("❌ ERROR: DFLOW_ENDPOINT is required but not set.");
  console.error("");
  console.error("Please set DFLOW_ENDPOINT in your .env file.");
  console.error("Example:");
  console.error("  DFLOW_ENDPOINT=foo-api.dflow.net");
  console.error("");
  console.error("See .env.example for more details.");
  process.exit(1);
}

const WEBSOCKET_URL = `wss://${endpoint}/api/v1/ws`;
const API_BASE_URL = `https://${endpoint}/api/v1`;
const MIN_VOLUME = parseInt(process.env.MIN_VOLUME || "0", 10);

// Momentum configuration
const MOMENTUM_WINDOW_SECONDS = parseInt(process.env.MOMENTUM_WINDOW_SECONDS || "60", 10);
const MOMENTUM_MIN_VOLUME = parseInt(process.env.MOMENTUM_MIN_VOLUME || "500", 10);
const MOMENTUM_MIN_TRADES = parseInt(process.env.MOMENTUM_MIN_TRADES || "5", 10);
const MOMENTUM_MIN_DIRECTIONAL_BIAS = parseFloat(process.env.MOMENTUM_MIN_DIRECTIONAL_BIAS || "0.7");

// Paper trading configuration
// POSITION_SIZE is now a fixed dollar amount (e.g., 1 = $1.00 per position)
const POSITION_SIZE_DOLLARS = parseFloat(process.env.POSITION_SIZE || "1");
const MAX_OPEN_POSITIONS = parseInt(process.env.MAX_OPEN_POSITIONS || "10", 10);
const PROFIT_TARGET = process.env.PROFIT_TARGET ? parseFloat(process.env.PROFIT_TARGET) : null; // Percentage (e.g., 0.1 = 10%)
const STOP_LOSS = process.env.STOP_LOSS ? parseFloat(process.env.STOP_LOSS) : null; // Percentage (e.g., 0.05 = 5%)
const PRICE_CHECK_INTERVAL_MS = parseInt(process.env.PRICE_CHECK_INTERVAL_MS || "5000", 10); // Default 5 seconds
const MAX_POSITION_AGE_MS = parseInt(process.env.MAX_POSITION_AGE_MS || "300000", 10); // Default 5 minutes - force close if can't get price data
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY_MS || "5000", 10); // Default 5 seconds between reconnection attempts

// Cooldown configuration
const LOSS_COOLDOWN_ENABLED = parseInt(process.env.LOSS_COOLDOWN || "1", 10) !== 0; // Default: enabled
const WIN_COOLDOWN_ENABLED = parseInt(process.env.WIN_COOLDOWN || "0", 10) !== 0; // Default: disabled
const COOLDOWN_TIME_MS = parseInt(process.env.COOLDOWN_TIME || "60000", 10); // Default: 60 seconds

// Output verbosity flags (0 = hide, any other value = show)
const SHOW_SKIPPED_TRADES = parseInt(process.env.SHOW_SKIPPED_TRADES || "0", 10) !== 0;
const SHOW_MOMENTUM_BUILDING = parseInt(process.env.SHOW_MOMENTUM_BUILDING || "0", 10) !== 0;

// Real trading configuration
const PAPER_TRADE_ONLY = parseInt(process.env.PAPER_TRADE_ONLY || "1", 10) !== 0; // Default: paper trading only

// Initialize real trading if enabled
if (!PAPER_TRADE_ONLY) {
  try {
    initializeTrading();
    console.log("⚠️  REAL TRADING ENABLED - You are risking real money!");
  } catch (error) {
    console.error("❌ Failed to initialize real trading:", error);
    console.error("Falling back to paper trading mode.");
    // Continue with paper trading
  }
} else {
  console.log("📊 Paper trading mode enabled (PAPER_TRADE_ONLY=1)");
}

// Cache for market data to avoid repeated API calls
const marketCache = new Map<string, Market>();

// HTTP server configuration
const UI_PORT = parseInt(process.env.UI_PORT || "3001", 10);

// Momentum tracking: Map<ticker, Array<{trade, timestamp}>>
const momentumTrades = new Map<string, Array<{ trade: TradeUpdate; timestamp: number }>>();

// Paper trading positions: Map<ticker, Position>
const positions = new Map<string, Position>();

// Store momentum metrics at entry for each position
const positionMomentumMetrics = new Map<string, MomentumMetrics>();

// Cooldown tracking: Map<ticker, {timestamp, wasWin}>
// Tracks when we last closed a position (win or loss) for cooldown purposes
const tickerCooldowns = new Map<string, { timestamp: number; wasWin: boolean }>();

// Metrics tracking
interface ClosedTrade {
  ticker: string;
  side: "yes" | "no";
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  duration: number; // seconds
  pnl: number; // in dollars
  pnlPercent: number;
  reason: string;
  momentumMetrics?: {
    volume: number;
    trades: number;
    bias: number;
    priceChange: number;
  };
}

const closedTrades: ClosedTrade[] = [];
let sessionStartTime = Date.now();

/**
 * Calculates performance metrics from closed trades
 * @returns Performance metrics including win rate, P&L, profit factor, etc.
 */
function getMetrics() {
  if (closedTrades.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalPnL: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      largestWin: 0,
      largestLoss: 0,
    };
  }

  const wins = closedTrades.filter(t => t.pnl > 0);
  const losses = closedTrades.filter(t => t.pnl < 0);
  const totalPnL = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const totalWins = wins.reduce((sum, t) => sum + t.pnl, 0);
  const totalLosses = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  return {
    totalTrades: closedTrades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    totalPnL,
    winRate: (wins.length / closedTrades.length) * 100,
    avgWin: wins.length > 0 ? totalWins / wins.length : 0,
    avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
    profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
    largestWin: wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0,
    largestLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
  };
}

/**
 * Logs a closed trade to trades.jsonl file in JSON Lines format
 * @param trade The closed trade to log
 */
function logTradeToFile(trade: ClosedTrade) {
  const logFile = join(process.cwd(), "trades.jsonl");
  const logEntry = JSON.stringify({
    ...trade,
    entryTime: new Date(trade.entryTime).toISOString(),
    exitTime: new Date(trade.exitTime).toISOString(),
  }) + "\n";
  
  appendFileSync(logFile, logEntry, "utf-8");
}

/**
 * Logs momentum signals to momentum-signals.jsonl file
 * This helps analyze entry timing and signal quality
 */
function logMomentumSignal(data: {
  timestamp: number;
  ticker: string;
  tradeId: string;
  momentumMetrics: MomentumMetrics;
  triggeredEntry: boolean;
  reason?: string; // Why it didn't trigger (if triggeredEntry is false)
  entryPrice?: number; // If entry was made, include entry price
  contracts?: number; // If entry was made, include contracts
}) {
  const logFile = join(process.cwd(), "momentum-signals.jsonl");
  const logEntry = JSON.stringify({
    ...data,
    timestamp: new Date(data.timestamp).toISOString(),
  }) + "\n";
  
  appendFileSync(logFile, logEntry, "utf-8");
}

/**
 * Prints formatted performance metrics to console
 * Called periodically (every 5 minutes) during operation
 */
function printMetrics() {
  const metrics = getMetrics();
  const sessionDuration = (Date.now() - sessionStartTime) / 1000 / 60; // minutes
  
  console.log("\n" + "=".repeat(60));
  console.log("📊 PERFORMANCE METRICS");
  console.log("=".repeat(60));
  console.log(`Total Trades: ${metrics.totalTrades}`);
  console.log(`Win Rate: ${metrics.winRate.toFixed(1)}% (${metrics.winningTrades}W / ${metrics.losingTrades}L)`);
  console.log(`Total P&L: $${metrics.totalPnL.toFixed(2)}`);
  console.log(`Avg Win: $${metrics.avgWin.toFixed(2)}`);
  console.log(`Avg Loss: $${metrics.avgLoss.toFixed(2)}`);
  console.log(`Profit Factor: ${metrics.profitFactor === Infinity ? "∞" : metrics.profitFactor.toFixed(2)}`);
  console.log(`Largest Win: $${metrics.largestWin.toFixed(2)}`);
  console.log(`Largest Loss: $${metrics.largestLoss.toFixed(2)}`);
  console.log(`Session Duration: ${sessionDuration.toFixed(1)} minutes`);
  if (metrics.totalTrades > 0) {
    console.log(`Trades/Hour: ${((metrics.totalTrades / sessionDuration) * 60).toFixed(1)}`);
  }
  console.log("=".repeat(60) + "\n");
}

/**
 * Fetches market data from REST API with caching
 * @param ticker Market ticker symbol
 * @param skipCache If true, bypasses cache and forces fresh fetch (useful for retries after 404)
 * @returns Market data or null if fetch fails
 */
async function fetchMarket(ticker: string, skipCache = false): Promise<Market | null> {
  // Check cache first (unless we're retrying after a 404)
  if (!skipCache && marketCache.has(ticker)) {
    const cached = marketCache.get(ticker);
    // Only return cached value if it exists and is not null (null means previous fetch failed)
    if (cached !== null && cached !== undefined) {
      return cached;
    }
    // If cached value is null, skip cache and retry (markets might come back)
  }

  try {
    const response = await fetch(`${API_BASE_URL}/market/${ticker}`);
    if (!response.ok) {
      if (response.status === 404) {
        // Don't cache 404s - markets might be temporarily unavailable or ticker might be wrong
        // Only log if we're not skipping cache (to avoid spam on retries)
        if (!skipCache) {
          console.error(`Market not found (404): ${ticker}`);
        }
      } else {
        console.error(`Failed to fetch market ${ticker}: ${response.status}`);
      }
      return null;
    }
    const market = (await response.json()) as Market;
    // Cache successful market data
    marketCache.set(ticker, market);
    return market;
  } catch (error) {
    console.error(`Error fetching market ${ticker}:`, error);
    return null;
  }
}

/**
 * Checks if a market meets the minimum volume threshold
 * @param ticker Market ticker symbol
 * @returns true if market volume >= MIN_VOLUME, false otherwise
 */
async function checkVolume(ticker: string): Promise<boolean> {
  const market = await fetchMarket(ticker);
  if (!market) {
    return false; // If we can't fetch market data, skip it
  }
  return market.volume >= MIN_VOLUME;
}

/**
 * Adds a trade to the momentum tracking window for a ticker
 * Automatically removes trades outside the time window
 * @param trade The trade update to add
 */
function addTradeToMomentum(trade: TradeUpdate): void {
  const ticker = trade.market_ticker;
  const now = Date.now();
  
  if (!momentumTrades.has(ticker)) {
    momentumTrades.set(ticker, []);
  }
  
  const trades = momentumTrades.get(ticker)!;
  trades.push({ trade, timestamp: now });
  
  // Clean up old trades outside the window
  const windowMs = MOMENTUM_WINDOW_SECONDS * 1000;
  const cutoff = now - windowMs;
  const filtered = trades.filter((t) => t.timestamp > cutoff);
  momentumTrades.set(ticker, filtered);
}

/**
 * Calculates momentum metrics for a ticker based on trades in the current window
 * @param ticker Market ticker symbol
 * @returns Momentum metrics (volume, trade count, directional bias, price change) or null if no trades
 */
function calculateMomentumMetrics(ticker: string): MomentumMetrics | null {
  const trades = momentumTrades.get(ticker);
  if (!trades || trades.length === 0) {
    return null;
  }
  
  let totalVolume = 0;
  let yesCount = 0;
  let noCount = 0;
  let firstPrice: number | null = null;
  let lastPrice: number | null = null;
  
  for (const { trade } of trades) {
    totalVolume += trade.count;
    if (trade.taker_side === "yes") {
      yesCount++;
    } else {
      noCount++;
    }
    
    if (firstPrice === null) {
      firstPrice = trade.price;
    }
    lastPrice = trade.price;
  }
  
  const tradeCount = trades.length;
  const directionalBias = tradeCount > 0 ? yesCount / tradeCount : 0.5;
  const priceChange = firstPrice !== null && lastPrice !== null ? lastPrice - firstPrice : 0;
  
  return {
    totalVolume,
    tradeCount,
    yesCount,
    noCount,
    directionalBias,
    priceChange,
  };
}

/**
 * Checks if momentum thresholds are met for a ticker
 * @param ticker Market ticker symbol
 * @returns true if all momentum thresholds are met (volume, trades, directional bias)
 */
function checkMomentum(ticker: string): boolean {
  const metrics = calculateMomentumMetrics(ticker);
  if (!metrics) {
    return false;
  }
  
  // Check all thresholds
  const volumeMet = metrics.totalVolume >= MOMENTUM_MIN_VOLUME;
  const tradesMet = metrics.tradeCount >= MOMENTUM_MIN_TRADES;
  
  // Directional bias: either strongly YES (>= threshold) or strongly NO (<= 1-threshold)
  const directionalMet =
    metrics.directionalBias >= MOMENTUM_MIN_DIRECTIONAL_BIAS ||
    metrics.directionalBias <= 1 - MOMENTUM_MIN_DIRECTIONAL_BIAS;
  
  return volumeMet && tradesMet && directionalMet;
}

/**
 * Opens a position based on momentum signal (paper or real trading)
 * Checks for existing positions, max positions limit, and cooldown before opening
 * @param trade The trade update that triggered the momentum signal
 * @param metrics The momentum metrics that met the thresholds
 */
async function openPosition(trade: TradeUpdate, metrics: MomentumMetrics): Promise<void> {
  const ticker = trade.market_ticker;
  
  // Don't open if we already have a position
  if (positions.has(ticker)) {
    return;
  }
  
  // Don't open if we've reached max positions
  if (positions.size >= MAX_OPEN_POSITIONS) {
    return;
  }
  
  // Check cooldown - ALWAYS enforce cooldown to prevent rapid re-entry
  const cooldown = tickerCooldowns.get(ticker);
  if (cooldown) {
    const cooldownAge = Date.now() - cooldown.timestamp;
    
    // Always enforce cooldown if it hasn't expired, regardless of win/loss settings
    // This prevents rapid re-entry on the same ticker
    if (cooldownAge < COOLDOWN_TIME_MS) {
      // Silently skip - don't log to avoid spam
      return;
    }
    
    // Cooldown expired, remove it
    tickerCooldowns.delete(ticker);
  }
  
  // Determine direction based on momentum
  const side: "yes" | "no" = metrics.directionalBias >= 0.5 ? "yes" : "no";
  const entryPrice = side === "yes" ? trade.yes_price : trade.no_price;
  
  // Calculate number of contracts based on fixed dollar amount
  // entryPrice is in cents, so: contracts = (dollars * 100) / price_in_cents
  const contracts = Math.floor((POSITION_SIZE_DOLLARS * 100) / entryPrice);
  
  if (contracts <= 0) {
    console.warn(`⚠️  Cannot open position for ${ticker}: entry price ${entryPrice} cents is too high for $${POSITION_SIZE_DOLLARS} position size`);
    return;
  }
  
  // Log momentum triggered
  console.log("🚀 MOMENTUM TRIGGERED - Copy trade candidate:", {
    ticker: trade.market_ticker,
    tradeId: trade.trade_id,
    side: trade.taker_side,
    count: trade.count,
    yesPrice: trade.yes_price_dollars,
    noPrice: trade.no_price_dollars,
    time: new Date(trade.created_time).toISOString(),
    momentum: {
      volume: metrics.totalVolume,
      trades: metrics.tradeCount,
      bias: (metrics.directionalBias * 100).toFixed(1) + "% YES",
      priceChange: metrics.priceChange,
    },
  });
  
  if (PAPER_TRADE_ONLY) {
    // Paper trading - just track the position
    const position: Position = {
      ticker,
      side,
      entryPrice,
      contracts: contracts,
      entryTime: Date.now(),
      entryTradeId: trade.trade_id,
    };
    
    positions.set(ticker, position);
    positionMomentumMetrics.set(ticker, metrics);
    
    // Log entry with momentum context
    logMomentumSignal({
      timestamp: Date.now(),
      ticker,
      tradeId: trade.trade_id,
      momentumMetrics: metrics,
      triggeredEntry: true,
      entryPrice,
      contracts,
    });
    
    console.log(`📈 OPENED PAPER POSITION: ${ticker}`, {
      side: side.toUpperCase(),
      contracts: contracts,
      entryPrice: entryPrice,
      entryPriceDollars: `$${(entryPrice / 100).toFixed(4)}`,
      positionSize: `$${POSITION_SIZE_DOLLARS.toFixed(2)}`,
    });
  } else {
    // Real trading - execute actual order
    try {
      // Get market data to extract outcome token mints
      const market = await fetchMarket(ticker);
      if (!market) {
        console.error(`❌ Cannot open real position: failed to fetch market data for ${ticker}`);
        return;
      }
      
      const outcomeMints = getOutcomeTokenMints(market);
      if (!outcomeMints) {
        console.error(`❌ Cannot open real position: failed to extract outcome token mints for ${ticker}`);
        return;
      }
      
      // Determine outcome token mint based on side
      const outcomeMint = side === "yes" ? outcomeMints.yesMint : outcomeMints.noMint;
      
      // TODO: Get settlement token mint from market data or config
      // For now, using USDC mainnet mint address
      // EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v is USDC on Solana mainnet
      const settlementMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
      
      // Calculate amount in settlement token (USDC has 6 decimals)
      // POSITION_SIZE_DOLLARS is in dollars, convert to smallest unit (micro-USDC)
      const amount = Math.floor(POSITION_SIZE_DOLLARS * 1_000_000); // USDC has 6 decimals
      
      console.log(`🔄 Executing REAL trade: ${ticker} ${side.toUpperCase()} ${contracts} contracts...`);
      
      const orderResult = await executeBuyOrder(settlementMint, outcomeMint, amount);
      
      const position: Position = {
        ticker,
        side,
        entryPrice,
        contracts: contracts,
        entryTime: Date.now(),
        entryTradeId: trade.trade_id,
        transactionSignature: orderResult.signature,
        executionMode: orderResult.executionMode,
        isFilled: orderResult.executionMode === "sync", // Sync trades are immediately filled
      };
      
            positions.set(ticker, position);
            positionMomentumMetrics.set(ticker, metrics);

            // Log entry with momentum context
            logMomentumSignal({
              timestamp: Date.now(),
              ticker,
              tradeId: trade.trade_id,
              momentumMetrics: metrics,
              triggeredEntry: true,
              entryPrice,
              contracts,
            });

            console.log(`✅ REAL POSITION OPENED: ${ticker}`, {
        side: side.toUpperCase(),
        contracts,
        entryPrice,
        entryPriceDollars: `$${(entryPrice / 100).toFixed(4)}`,
        positionSize: `$${POSITION_SIZE_DOLLARS.toFixed(2)}`,
        transactionSignature: orderResult.signature,
        executionMode: orderResult.executionMode,
      });
      
      // For async trades, check status after a delay
      if (orderResult.executionMode === "async") {
        setTimeout(async () => {
          try {
            const status = await checkOrderStatus(orderResult.signature);
            if (status.status === "closed" && status.fills && status.fills.length > 0) {
              position.isFilled = true;
              console.log(`✅ Order ${orderResult.signature} filled`);
            } else if (status.status === "failed") {
              console.error(`❌ Order ${orderResult.signature} failed`);
            }
          } catch (error) {
            console.error(`⚠️  Error checking order status:`, error);
          }
        }, 5000);
      }
    } catch (error) {
      console.error(`❌ Failed to execute real trade for ${ticker}:`, error);
      // Don't add to positions if trade failed
      return;
    }
  }
}

/**
 * Gets current market prices (mid-price of bid/ask) for a ticker
 * Uses mid-price to avoid spread issues in paper trading
 * @param ticker Market ticker symbol
 * @returns Object with yesPrice and noPrice in cents, or null if fetch fails
 */
async function getCurrentPrice(ticker: string): Promise<{ yesPrice: number; noPrice: number } | null> {
  try {
    // Try fetching market, and if it fails, retry once (skip cache in case it was a 404)
    let market = await fetchMarket(ticker);
    if (!market) {
      // Retry once, skipping cache (in case previous fetch was a 404 that we didn't cache)
      market = await fetchMarket(ticker, true);
      if (!market) {
        return null;
      }
    }
    
    // Use mid price (average of bid and ask) to avoid spread issues in paper trading
    let yesPrice: number | null = null;
    if (market.yesBid && market.yesAsk) {
      const yesBid = parseFloat(market.yesBid) * 100;
      const yesAsk = parseFloat(market.yesAsk) * 100;
      yesPrice = (yesBid + yesAsk) / 2;
    } else if (market.yesBid) {
      yesPrice = parseFloat(market.yesBid) * 100;
    } else if (market.yesAsk) {
      yesPrice = parseFloat(market.yesAsk) * 100;
    }
    
    let noPrice: number | null = null;
    if (market.noBid && market.noAsk) {
      const noBid = parseFloat(market.noBid) * 100;
      const noAsk = parseFloat(market.noAsk) * 100;
      noPrice = (noBid + noAsk) / 2;
    } else if (market.noBid) {
      noPrice = parseFloat(market.noBid) * 100;
    } else if (market.noAsk) {
      noPrice = parseFloat(market.noAsk) * 100;
    }
    
    if (yesPrice === null || noPrice === null) {
      return null;
    }
    
    return { yesPrice, noPrice };
  } catch (error) {
    console.error(`Error getting current price for ${ticker}:`, error);
    return null;
  }
}

/**
 * Calculates profit/loss for a position in cents
 * @param position The position to calculate P&L for
 * @param currentPrice Current market price in cents
 * @returns P&L in cents (positive = profit, negative = loss)
 */
function calculatePnL(position: Position, currentPrice: number): number {
  if (position.side === "yes") {
    // For YES: profit if current price > entry price
    return (currentPrice - position.entryPrice) * position.contracts;
  } else {
    // For NO: profit if current price < entry price
    return (position.entryPrice - currentPrice) * position.contracts;
  }
}

/**
 * Calculates profit/loss percentage for a position
 * @param position The position to calculate P&L % for
 * @param currentPrice Current market price in cents
 * @returns P&L as a percentage (positive = profit, negative = loss)
 */
function calculatePnLPercentage(position: Position, currentPrice: number): number {
  if (position.side === "yes") {
    return ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  } else {
    return ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
  }
}

/**
 * Manually closes a position (called from UI)
 * @param ticker The ticker to close
 * @param reason Reason for closing (default: "Manual close")
 * @returns Success status and error message if failed
 */
async function closePositionManually(ticker: string, reason: string = "Manual close"): Promise<{ success: boolean; error?: string }> {
  const position = positions.get(ticker);
  if (!position) {
    return { success: false, error: "Position not found" };
  }

  const prices = await getCurrentPrice(ticker);
  if (!prices) {
    return { success: false, error: "Unable to fetch current price" };
  }

  const currentPrice = position.side === "yes" ? prices.yesPrice : prices.noPrice;
  const pnl = calculatePnL(position, currentPrice);
  const pnlPercent = calculatePnLPercentage(position, currentPrice);

  if (PAPER_TRADE_ONLY) {
    // Paper trading - just close the position
    const exitTime = Date.now();
    const duration = (exitTime - position.entryTime) / 1000;
    const momentumMetrics = positionMomentumMetrics.get(ticker);
    
    const closedTrade: ClosedTrade = {
      ticker,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: currentPrice,
      entryTime: position.entryTime,
      exitTime,
      duration,
      pnl: pnl / 100, // Convert cents to dollars
      pnlPercent,
      reason,
      momentumMetrics: momentumMetrics ? {
        volume: momentumMetrics.totalVolume,
        trades: momentumMetrics.tradeCount,
        bias: momentumMetrics.directionalBias,
        priceChange: momentumMetrics.priceChange,
      } : undefined,
    };
    
    closedTrades.push(closedTrade);
    logTradeToFile(closedTrade);
    positions.delete(ticker);
    positionMomentumMetrics.delete(ticker);
    
    // ALWAYS record cooldown to prevent rapid re-entry on same ticker
    const wasWin = pnl > 0;
    tickerCooldowns.set(ticker, {
      timestamp: Date.now(),
      wasWin: wasWin,
    });
    
    console.log(`📉 MANUALLY CLOSED PAPER POSITION: ${ticker}`, {
      side: position.side.toUpperCase(),
      entryPrice: position.entryPrice,
      exitPrice: currentPrice,
      pnl: `$${(pnl / 100).toFixed(2)}`,
      pnlPercent: `${pnlPercent.toFixed(2)}%`,
      duration: `${duration.toFixed(1)}s`,
      reason,
    });
    
    return { success: true };
  } else {
    // Real trading - execute sell order
    try {
      // For async trades, only close if order was filled
      if (position.executionMode === "async" && !position.isFilled) {
        return { success: false, error: "Order not yet filled" };
      }
      
      // Get market data to extract outcome token mints
      const market = await fetchMarket(ticker);
      if (!market) {
        return { success: false, error: "Failed to fetch market data" };
      }
      
      const outcomeMints = getOutcomeTokenMints(market);
      if (!outcomeMints) {
        return { success: false, error: "Failed to extract outcome token mints" };
      }
      
      // Determine outcome token mint based on position side
      const outcomeMint = position.side === "yes" ? outcomeMints.yesMint : outcomeMints.noMint;
      
      // Settlement token (USDC)
      const settlementMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
      
      // Get actual token balance from Solana
      const outcomeTokenBalance = await getTokenBalance(outcomeMint);
      
      if (outcomeTokenBalance === 0) {
        return { success: false, error: "No tokens found - position may not have filled" };
      }
      
      console.log(`🔄 Manually closing REAL position: ${ticker} (balance: ${outcomeTokenBalance} tokens)...`);
      
      const sellResult = await executeSellOrder(outcomeMint, settlementMint, outcomeTokenBalance);
      
      const exitTime = Date.now();
      const duration = (exitTime - position.entryTime) / 1000;
      const momentumMetrics = positionMomentumMetrics.get(ticker);
      
      const closedTrade: ClosedTrade = {
        ticker,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: currentPrice,
        entryTime: position.entryTime,
        exitTime,
        duration,
        pnl: pnl / 100, // Convert cents to dollars
        pnlPercent,
        reason,
        momentumMetrics: momentumMetrics ? {
          volume: momentumMetrics.totalVolume,
          trades: momentumMetrics.tradeCount,
          bias: momentumMetrics.directionalBias,
          priceChange: momentumMetrics.priceChange,
        } : undefined,
      };
      
      closedTrades.push(closedTrade);
      logTradeToFile(closedTrade);
      positions.delete(ticker);
      positionMomentumMetrics.delete(ticker);
      
      // ALWAYS record cooldown to prevent rapid re-entry on same ticker
      const wasWin = pnl > 0;
      tickerCooldowns.set(ticker, {
        timestamp: Date.now(),
        wasWin: wasWin,
      });
      
      console.log(`✅ MANUALLY CLOSED REAL POSITION: ${ticker}`, {
        side: position.side.toUpperCase(),
        entryPrice: position.entryPrice,
        exitPrice: currentPrice,
        pnl: `$${(pnl / 100).toFixed(2)}`,
        pnlPercent: `${pnlPercent.toFixed(2)}%`,
        duration: `${duration.toFixed(1)}s`,
        reason,
        transactionSignature: sellResult.signature,
        executionMode: sellResult.executionMode,
      });
      
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || "Failed to close position" };
    }
  }
}

/**
 * Checks all open positions for exit conditions (profit target or stop loss)
 * Also handles force-closing positions that can't get price data after timeout
 * Called periodically based on PRICE_CHECK_INTERVAL_MS
 */
async function checkPositions(): Promise<void> {
  if (positions.size === 0) {
    return;
  }
  
  for (const [ticker, position] of positions.entries()) {
    const positionAge = Date.now() - position.entryTime;
    const prices = await getCurrentPrice(ticker);
    
    // If we can't get price data and position is too old, force close it
    if (!prices) {
      if (positionAge > MAX_POSITION_AGE_MS) {
        // Force close position due to inability to get price data
        const momentumMetrics = positionMomentumMetrics.get(ticker);
        const closedTrade: ClosedTrade = {
          ticker,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: position.entryPrice, // Use entry price as exit (break even assumption)
          entryTime: position.entryTime,
          exitTime: Date.now(),
          duration: positionAge / 1000,
          pnl: 0, // Assume break even if we can't get price
          pnlPercent: 0,
          reason: `Force closed - unable to fetch price data after ${(MAX_POSITION_AGE_MS / 1000).toFixed(0)}s`,
          momentumMetrics: momentumMetrics ? {
            volume: momentumMetrics.totalVolume,
            trades: momentumMetrics.tradeCount,
            bias: momentumMetrics.directionalBias,
            priceChange: momentumMetrics.priceChange,
          } : undefined,
        };
        
        closedTrades.push(closedTrade);
        logTradeToFile(closedTrade);
        positions.delete(ticker);
        positionMomentumMetrics.delete(ticker);
        
        // ALWAYS record cooldown for force-closed positions (treat as loss)
        tickerCooldowns.set(ticker, {
          timestamp: Date.now(),
          wasWin: false,
        });
        
        console.log(`⚠️  FORCE CLOSED POSITION: ${ticker} (unable to fetch price data)`);
        continue;
      }
      
      // If we can't get price data but position is still young, log it but don't spam
      if (positionAge > 30000) {
        console.warn(`⚠️  Cannot fetch price data for ${ticker} (position age: ${(positionAge / 1000).toFixed(0)}s)`);
      }
      continue;
    }
    
    const currentPrice = position.side === "yes" ? prices.yesPrice : prices.noPrice;
    const pnl = calculatePnL(position, currentPrice);
    const pnlPercent = calculatePnLPercentage(position, currentPrice);
    
    // Check exit conditions
    let shouldClose = false;
    let closeReason = "";
    
    // Debug: Log position status every 30 seconds (to avoid spam)
    const debugLogInterval = 30000; // 30 seconds
    const lastLogTime = (position as any).lastDebugLogTime || 0;
    const now = Date.now();
    if (now - lastLogTime >= debugLogInterval) {
      console.log(`🔍 Position: ${ticker} | Entry: ${position.entryPrice}¢ | Current: ${currentPrice}¢ | P&L: $${(pnl / 100).toFixed(2)} (${pnlPercent.toFixed(2)}%) | Target: ${PROFIT_TARGET !== null ? (PROFIT_TARGET * 100).toFixed(2) + '%' : 'none'} | Stop: ${STOP_LOSS !== null ? (-STOP_LOSS * 100).toFixed(2) + '%' : 'none'}`);
      (position as any).lastDebugLogTime = now;
    }
    
    if (PROFIT_TARGET !== null && pnlPercent >= PROFIT_TARGET * 100) {
      shouldClose = true;
      closeReason = `Profit target reached (${pnlPercent.toFixed(2)}%)`;
    } else if (STOP_LOSS !== null && pnlPercent <= -STOP_LOSS * 100) {
      shouldClose = true;
      closeReason = `Stop loss hit (${pnlPercent.toFixed(2)}%)`;
    }
    
    if (shouldClose) {
      if (PAPER_TRADE_ONLY) {
        // Paper trading - just close the position
        const exitTime = Date.now();
        const duration = (exitTime - position.entryTime) / 1000;
        
        const momentumMetrics = positionMomentumMetrics.get(ticker);
        
        const closedTrade: ClosedTrade = {
          ticker,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: currentPrice,
          entryTime: position.entryTime,
          exitTime,
          duration,
          pnl: pnl / 100, // Convert cents to dollars
          pnlPercent,
          reason: closeReason,
          momentumMetrics: momentumMetrics ? {
            volume: momentumMetrics.totalVolume,
            trades: momentumMetrics.tradeCount,
            bias: momentumMetrics.directionalBias,
            priceChange: momentumMetrics.priceChange,
          } : undefined,
        };
        
        closedTrades.push(closedTrade);
        logTradeToFile(closedTrade);
        positions.delete(ticker);
        positionMomentumMetrics.delete(ticker);
        
        // ALWAYS record cooldown to prevent rapid re-entry on same ticker
        // This prevents the same ticker from being opened multiple times in quick succession
        const wasWin = pnl > 0;
        tickerCooldowns.set(ticker, {
          timestamp: Date.now(),
          wasWin: wasWin,
        });
        
        console.log(`📉 CLOSED PAPER POSITION: ${ticker}`, {
          side: position.side.toUpperCase(),
          entryPrice: position.entryPrice,
          exitPrice: currentPrice,
          pnl: `$${(pnl / 100).toFixed(2)}`,
          pnlPercent: `${pnlPercent.toFixed(2)}%`,
          duration: `${duration.toFixed(1)}s`,
          reason: closeReason,
        });
      } else {
        // Real trading - execute sell order
        // For async trades, only close if order was filled
        if (position.executionMode === "async" && !position.isFilled) {
          console.log(`⏳ Waiting for order ${position.transactionSignature} to fill before closing ${ticker}...`);
          continue;
        }
        
        try {
          // Get market data to extract outcome token mints
          const market = await fetchMarket(ticker);
          if (!market) {
            console.error(`❌ Cannot close real position: failed to fetch market data for ${ticker}`);
            continue;
          }
          
          const outcomeMints = getOutcomeTokenMints(market);
          if (!outcomeMints) {
            console.error(`❌ Cannot close real position: failed to extract outcome token mints for ${ticker}`);
            continue;
          }
          
          // Determine outcome token mint based on position side
          const outcomeMint = position.side === "yes" ? outcomeMints.yesMint : outcomeMints.noMint;
          
          // Settlement token (USDC)
          const settlementMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
          
          // Get actual token balance from Solana
          const outcomeTokenBalance = await getTokenBalance(outcomeMint);
          
          if (outcomeTokenBalance === 0) {
            console.warn(`⚠️  No outcome tokens found for ${ticker} - position may have already been closed or never filled`);
            // Still close the position in our tracking
            const exitTime = Date.now();
            const duration = (exitTime - position.entryTime) / 1000;
            const momentumMetrics = positionMomentumMetrics.get(ticker);
            
            const closedTrade: ClosedTrade = {
              ticker,
              side: position.side,
              entryPrice: position.entryPrice,
              exitPrice: currentPrice,
              entryTime: position.entryTime,
              exitTime,
              duration,
              pnl: pnl / 100,
              pnlPercent,
              reason: `${closeReason} (no tokens found - may not have filled)`,
              momentumMetrics: momentumMetrics ? {
                volume: momentumMetrics.totalVolume,
                trades: momentumMetrics.tradeCount,
                bias: momentumMetrics.directionalBias,
                priceChange: momentumMetrics.priceChange,
              } : undefined,
            };
            
            closedTrades.push(closedTrade);
            logTradeToFile(closedTrade);
            positions.delete(ticker);
            positionMomentumMetrics.delete(ticker);
            continue;
          }
          
          console.log(`🔄 Closing REAL position: ${ticker} (balance: ${outcomeTokenBalance} tokens)...`);
          
          const sellResult = await executeSellOrder(outcomeMint, settlementMint, outcomeTokenBalance);
          
          const exitTime = Date.now();
          const duration = (exitTime - position.entryTime) / 1000;
          
          const momentumMetrics = positionMomentumMetrics.get(ticker);
          
          const closedTrade: ClosedTrade = {
            ticker,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice: currentPrice,
            entryTime: position.entryTime,
            exitTime,
            duration,
            pnl: pnl / 100, // Convert cents to dollars
            pnlPercent,
            reason: closeReason,
            momentumMetrics: momentumMetrics ? {
              volume: momentumMetrics.totalVolume,
              trades: momentumMetrics.tradeCount,
              bias: momentumMetrics.directionalBias,
              priceChange: momentumMetrics.priceChange,
            } : undefined,
          };
          
          closedTrades.push(closedTrade);
          logTradeToFile(closedTrade);
          positions.delete(ticker);
          positionMomentumMetrics.delete(ticker);
          
          // ALWAYS record cooldown to prevent rapid re-entry on same ticker
          const wasWin = pnl > 0;
          tickerCooldowns.set(ticker, {
            timestamp: Date.now(),
            wasWin: wasWin,
          });
          
          console.log(`✅ REAL POSITION CLOSED: ${ticker}`, {
            side: position.side.toUpperCase(),
            entryPrice: position.entryPrice,
            exitPrice: currentPrice,
            pnl: `$${(pnl / 100).toFixed(2)}`,
            pnlPercent: `${pnlPercent.toFixed(2)}%`,
            duration: `${duration.toFixed(1)}s`,
            reason: closeReason,
            transactionSignature: sellResult.signature,
            executionMode: sellResult.executionMode,
          });
        } catch (error) {
          console.error(`❌ Failed to close real position for ${ticker}:`, error);
          // Position remains open - will retry on next check
        }
      }
    } else {
      // Only log position updates if P&L changed significantly (more than 0.5% change)
      // Store last logged P&L to compare
      const lastLoggedPnL = position.lastLoggedPnLPercent ?? pnlPercent;
      const pnlChange = Math.abs(pnlPercent - lastLoggedPnL);
      
      if (pnlChange >= 0.5) {
        const sign = pnl >= 0 ? "+" : "";
        console.log(`💰 Position update: ${ticker} ${sign}${(pnl / 100).toFixed(2)} (${sign}${pnlPercent.toFixed(2)}%)`);
        position.lastLoggedPnLPercent = pnlPercent;
      }
    }
  }
}

// WebSocket connection management
let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let isIntentionallyClosing = false;
let priceCheckInterval: NodeJS.Timeout | null = null;
let metricsInterval: NodeJS.Timeout | null = null;

/**
 * Sets up WebSocket event handlers (onopen, onmessage, onerror, onclose)
 * Handles subscription to trades channel and starts periodic tasks
 * @param websocket The WebSocket instance to set up handlers for
 */
function setupWebSocketHandlers(websocket: WebSocket) {
  websocket.onopen = () => {
    console.log("✅ Connected to WebSocket");
    console.log(`Min volume threshold: $${MIN_VOLUME.toLocaleString()}`);
    console.log(`Momentum config: window=${MOMENTUM_WINDOW_SECONDS}s, minVolume=${MOMENTUM_MIN_VOLUME}, minTrades=${MOMENTUM_MIN_TRADES}, minBias=${MOMENTUM_MIN_DIRECTIONAL_BIAS}`);
    console.log(`Paper trading: positionSize=$${POSITION_SIZE_DOLLARS.toFixed(2)} (fixed dollar amount), maxPositions=${MAX_OPEN_POSITIONS}, profitTarget=${PROFIT_TARGET ? PROFIT_TARGET * 100 + "%" : "none"}, stopLoss=${STOP_LOSS ? STOP_LOSS * 100 + "%" : "none"}`);
    console.log(`Cooldown: loss=${LOSS_COOLDOWN_ENABLED ? "enabled" : "disabled"}, win=${WIN_COOLDOWN_ENABLED ? "enabled" : "disabled"}, time=${COOLDOWN_TIME_MS / 1000}s`);
    const logFilePath = join(process.cwd(), "trades.jsonl");
    console.log(`📝 Trades will be logged to: ${logFilePath}`);
    
    // Start periodic price checking for positions (only if not already started)
    if (!priceCheckInterval) {
      priceCheckInterval = setInterval(() => {
        checkPositions().catch((error) => {
          console.error("Error checking positions:", error);
        });
      }, PRICE_CHECK_INTERVAL_MS);
    }
    
    // Print metrics every 5 minutes (only if not already started)
    if (!metricsInterval) {
      metricsInterval = setInterval(() => {
        if (closedTrades.length > 0) {
          printMetrics();
        }
      }, 5 * 60 * 1000);
    }

    // Subscribe to all trade updates
    websocket.send(
      JSON.stringify({
        type: "subscribe",
        channel: "trades",
        all: true,
      })
    );
  };

  websocket.onmessage = async (event: { data: WebSocket.Data }) => {
    const message = JSON.parse(event.data.toString());

    if (message.channel === "trades") {
      const trade: TradeUpdate = message;
      
      // Check volume before processing
      const hasEnoughVolume = await checkVolume(trade.market_ticker);
      
      if (!hasEnoughVolume) {
        if (SHOW_SKIPPED_TRADES) {
          const market = marketCache.get(trade.market_ticker);
          console.log(`Skipping trade - insufficient volume: ${trade.market_ticker} (volume: $${market?.volume?.toLocaleString() || "unknown"}, min: $${MIN_VOLUME.toLocaleString()})`);
        }
        return;
      }

      // Add trade to momentum tracking
      addTradeToMomentum(trade);
      
      // Check momentum
      const hasMomentum = checkMomentum(trade.market_ticker);
      
      // Get momentum metrics for logging (even if not triggered)
      const metrics = calculateMomentumMetrics(trade.market_ticker);
      
      if (!hasMomentum) {
        if (SHOW_MOMENTUM_BUILDING) {
          console.log(`Momentum building: ${trade.market_ticker} (not yet triggered)`);
        }
        // Log momentum signal that didn't trigger
        if (metrics) {
          logMomentumSignal({
            timestamp: Date.now(),
            ticker: trade.market_ticker,
            tradeId: trade.trade_id,
            momentumMetrics: metrics,
            triggeredEntry: false,
            reason: "Below momentum thresholds",
          });
        }
        return;
      }

      // Momentum threshold met - this is a candidate for copy trading
      if (!metrics) {
        return;
      }
      
      // Check if we can open a position
      let entryReason: string | undefined;
      if (positions.has(trade.market_ticker)) {
        entryReason = "Already have position";
      } else if (positions.size >= MAX_OPEN_POSITIONS) {
        entryReason = `Max positions reached (${MAX_OPEN_POSITIONS})`;
      } else {
        // Check cooldown
        const cooldown = tickerCooldowns.get(trade.market_ticker);
        if (cooldown) {
          const cooldownAge = Date.now() - cooldown.timestamp;
          if (cooldownAge < COOLDOWN_TIME_MS) {
            entryReason = `In cooldown (${((COOLDOWN_TIME_MS - cooldownAge) / 1000).toFixed(0)}s remaining)`;
          }
        }
      }
      
      // Log momentum signal (whether it triggers entry or not)
      logMomentumSignal({
        timestamp: Date.now(),
        ticker: trade.market_ticker,
        tradeId: trade.trade_id,
        momentumMetrics: metrics,
        triggeredEntry: entryReason === undefined,
        reason: entryReason,
      });
      
      // Only open if we don't already have a position
      if (!positions.has(trade.market_ticker)) {
        // Open position (paper or real trading, will log internally if successful)
        await openPosition(trade, metrics);
      }
    }
  };

  websocket.onerror = (event: { error?: Error; message?: string; type?: string; target?: WebSocket }) => {
    console.error("❌ WebSocket error:", event);
  };

  websocket.on("close", (code: number, reason: Buffer) => {
    if (isIntentionallyClosing) {
      console.log("🔌 WebSocket connection closed intentionally");
      return;
    }
    
    const reasonStr = reason ? reason.toString() : "";
    console.log(`🔌 WebSocket connection closed (code: ${code || "unknown"})${reasonStr ? `: ${reasonStr}` : ""}`);
    console.log(`🔄 Reconnecting in ${RECONNECT_DELAY_MS / 1000} seconds...`);
    
    // Clear any existing reconnect timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    
    // Schedule reconnection
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, RECONNECT_DELAY_MS);
  });
}

/**
 * Creates a new WebSocket connection and sets up handlers
 * Called on startup and when reconnecting after a disconnect
 */
function connectWebSocket() {
  try {
    ws = new WebSocket(WEBSOCKET_URL);
    setupWebSocketHandlers(ws);
  } catch (error) {
    console.error("❌ Failed to create WebSocket connection:", error);
    // Retry after delay
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, RECONNECT_DELAY_MS);
  }
}

// Shutdown flag to prevent multiple shutdown attempts
let isShuttingDown = false;

// Handle graceful shutdown
function gracefulShutdown() {
  if (isShuttingDown) {
    return; // Already shutting down
  }
  isShuttingDown = true;
  
  console.log("\n🛑 Shutting down gracefully...");
  isIntentionallyClosing = true;
  
  // Stop all timers and connections
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
  if (priceCheckInterval) {
    clearInterval(priceCheckInterval);
    priceCheckInterval = null;
  }
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
  
  // Close HTTP server with timeout
  const shutdownTimeout = setTimeout(() => {
    console.log("⚠️  Shutdown timeout - forcing exit");
    process.exit(1);
  }, 5000); // 5 second timeout
  
  stopServer()
    .then(() => {
      clearTimeout(shutdownTimeout);
      process.exit(0);
    })
    .catch((error) => {
      console.error("Error during shutdown:", error);
      clearTimeout(shutdownTimeout);
      process.exit(1);
    });
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// Start HTTP server for UI
startServer(UI_PORT, { 
  positions,
  closedTrades,
  getCurrentPrice,
  fetchMarket,
  closePosition: closePositionManually,
}).catch((error) => {
  console.error("Failed to start UI server:", error);
});

// Initial WebSocket connection
connectWebSocket();


