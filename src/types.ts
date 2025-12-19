export interface TradeUpdate {
  channel: "trades";
  type: "trade";
  market_ticker: string;
  trade_id: string;
  price: number;
  count: number;
  yes_price: number;
  no_price: number;
  yes_price_dollars: string;
  no_price_dollars: string;
  taker_side: "yes" | "no";
  created_time: number;
}

export interface PriceUpdate {
  channel: "prices";
  type: string;
  market_ticker: string;
  yes_bid: string | null;
  yes_ask: string | null;
  no_bid: string | null;
  no_ask: string | null;
}

export interface SubscribeMessage {
  type: "subscribe";
  channel: "trades" | "prices";
  all?: boolean;
  tickers?: string[];
}

export interface UnsubscribeMessage {
  type: "unsubscribe";
  channel: "trades" | "prices";
  all?: boolean;
  tickers?: string[];
}

export interface Market {
  accounts: Record<string, unknown>;
  canCloseEarly: boolean;
  closeTime: number;
  eventTicker: string;
  expirationTime: number;
  marketType: string;
  noSubTitle: string;
  openInterest: number;
  openTime: number;
  result: string;
  rulesPrimary: string;
  status: string;
  subtitle: string;
  ticker: string;
  title: string;
  volume: number;
  yesSubTitle: string;
  earlyCloseCondition?: string | null;
  noAsk?: string | null;
  noBid?: string | null;
  rulesSecondary?: string | null;
  yesAsk?: string | null;
  yesBid?: string | null;
}

export interface MomentumMetrics {
  totalVolume: number;
  tradeCount: number;
  yesCount: number;
  noCount: number;
  directionalBias: number; // 0-1, where 1 = all YES, 0 = all NO, 0.5 = balanced
  priceChange: number; // Price change in the window
}

export interface Position {
  ticker: string;
  side: "yes" | "no";
  entryPrice: number; // Price in cents (0-100)
  contracts: number;
  entryTime: number;
  entryTradeId: string;
  lastLoggedPnLPercent?: number; // Track last logged P&L to avoid spam
}

