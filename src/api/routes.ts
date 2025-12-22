/**
 * API Routes
 */

import { Express } from "express";
import { Position, Market } from "../types";
import { ServerState } from "../server";

// Helper functions to calculate P&L (same logic as in index.ts)
function calculatePnL(position: Position, currentPrice: number): number {
  if (position.side === "yes") {
    return (currentPrice - position.entryPrice) * position.contracts;
  } else {
    return (position.entryPrice - currentPrice) * position.contracts;
  }
}

function calculatePnLPercentage(position: Position, currentPrice: number): number {
  if (position.side === "yes") {
    return ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  } else {
    return ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
  }
}

/**
 * Constructs Kalshi URL from market data
 * Format: https://kalshi.com/markets/{category}/{subcategory}/{ticker}
 */
function getKalshiUrl(ticker: string, market: Market | null): string {
  if (!market) {
    // Fallback to search if no market data
    const baseTicker = ticker.toLowerCase();
    const lastDashIndex = baseTicker.lastIndexOf('-');
    const marketTicker = lastDashIndex > 0 ? baseTicker.substring(0, lastDashIndex) : baseTicker;
    return `https://kalshi.com/markets?q=${encodeURIComponent(marketTicker)}`;
  }
  
  // Extract category from ticker prefix (e.g., "kxnflgame" from "kxnflgame-25dec20phiwas")
  const baseTicker = ticker.toLowerCase();
  const lastDashIndex = baseTicker.lastIndexOf('-');
  const marketTicker = lastDashIndex > 0 ? baseTicker.substring(0, lastDashIndex) : baseTicker;
  const categoryMatch = marketTicker.match(/^([a-z]+)/);
  const category = categoryMatch ? categoryMatch[1] : 'markets';
  
  // Try to derive subcategory from market data
  // Check subtitle, marketType, or other fields that might contain category info
  let subcategory = '';
  
  // Try subtitle field (might contain category info)
  if (market.subtitle) {
    // Convert subtitle to URL-friendly format
    subcategory = market.subtitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  
  // If no subcategory from subtitle, try marketType
  if (!subcategory && market.marketType) {
    subcategory = market.marketType
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  
  // If still no subcategory, use a generic fallback based on category
  if (!subcategory) {
    // Map known categories to their subcategories
    const categoryMap: Record<string, string> = {
      'kxnflgame': 'professional-football-game',
      'kxboxing': 'boxing-match-champion',
      'kxncaafgame': 'college-football-game',
      // Add more as we discover them
    };
    subcategory = categoryMap[category] || 'market';
  }
  
  return `https://kalshi.com/markets/${category}/${subcategory}/${marketTicker}`;
}

export async function setupRoutes(app: Express, state: ServerState): Promise<void> {
  // API endpoint: Get current positions with P&L
  app.get("/api/positions", async (req, res) => {
    const positionsArray = await Promise.all(
      Array.from(state.positions.entries()).map(async ([ticker, position]) => {
        const prices = await state.getCurrentPrice(ticker);
        const market = await state.fetchMarket(ticker);
        let currentPrice: number | null = null;
        let pnl: number | null = null;
        let pnlPercent: number | null = null;
        
        if (prices) {
          currentPrice = position.side === "yes" ? prices.yesPrice : prices.noPrice;
          pnl = calculatePnL(position, currentPrice);
          pnlPercent = calculatePnLPercentage(position, currentPrice);
        }
        
        return {
          ticker,
          side: position.side,
          entryPrice: position.entryPrice,
          contracts: position.contracts,
          entryTime: position.entryTime,
          currentPrice,
          pnl,
          pnlPercent,
          kalshiUrl: getKalshiUrl(ticker, market),
          title: market?.title || null,
          subtitle: market?.subtitle || null,
          yesSubTitle: market?.yesSubTitle || null,
          noSubTitle: market?.noSubTitle || null,
        };
      })
    );

    res.json({ positions: positionsArray });
  });

  // API endpoint: Get closed trades
  app.get("/api/closed-trades", async (req, res) => {
    // Return most recent first, with Kalshi URLs
    const closedTradesArray = await Promise.all(
      [...state.closedTrades].reverse().map(async (trade) => {
        const market = await state.fetchMarket(trade.ticker);
        return {
          ...trade,
          kalshiUrl: getKalshiUrl(trade.ticker, market),
          title: market?.title || null,
          subtitle: market?.subtitle || null,
          yesSubTitle: market?.yesSubTitle || null,
          noSubTitle: market?.noSubTitle || null,
        };
      })
    );
    res.json({ closedTrades: closedTradesArray });
  });

  // API endpoint: Close a position manually
  app.post("/api/close-position/:ticker", async (req, res) => {
    const { ticker } = req.params;
    const result = await state.closePosition(ticker);
    
    if (result.success) {
      res.json({ success: true, message: `Position ${ticker} closed successfully` });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  });
}

