# DFlow Copy Trading Bot

A TypeScript CLI tool for automated copy trading on DFlow's Kalshi prediction markets using real-time momentum detection and paper trading.

## Overview

This bot monitors live trade execution data from DFlow's WebSocket API, identifies markets with strong momentum signals, and simulates trading positions to track profitability. It's designed for paper trading (simulated trading) to test strategies before risking real capital.

## ⚠️ Caveat Emptor (Buyer Beware)

**This is experimental software. Use at your own risk.**

This bot is a work in progress. It's been tested in paper trading mode, but:

- The algorithm is still being tuned
- Market conditions change
- Past performance ≠ future results
- Bugs happen (we're human, the code might have issues)
- Prediction markets are volatile and unpredictable

**You are free to use, modify, and adapt this code however you like.** However, if you decide to use this for real trading and lose your Christmas money, your life savings, or your firstborn's college fund, please don't come complaining to me. I warned you. 🤷

This is provided as-is, for educational and experimental purposes. Paper trade first. Test thoroughly. Understand the risks. And maybe don't bet the farm on a TypeScript script that detects "momentum" in prediction markets.

_TL;DR: This is WIP experimental code. Use it, break it, improve it, but if you lose money, that's on you, not me._

## How It Works

### Architecture

The bot operates in three main phases:

1. **Market Filtering** - Filters markets by minimum liquidity threshold
2. **Momentum Detection** - Analyzes recent trade activity to identify strong directional momentum
3. **Position Management** - Opens paper positions, monitors P&L, and closes based on profit targets or stop losses

### Algorithm Details

#### 1. Market Liquidity Filter

Before considering any trade, the bot checks if the market meets a minimum volume threshold:

- Fetches market data via REST API (`GET /market/{ticker}`)
- Checks if `market.volume >= MIN_VOLUME`
- Only processes trades from markets that meet this threshold
- Markets below threshold are skipped (can be logged with `SHOW_SKIPPED_TRADES=1`)

**Purpose**: Ensures we only trade in liquid markets where positions can be entered/exited easily.

#### 2. Momentum Detection

The core algorithm analyzes trade activity within a rolling time window:

**Time Window**: Configurable window (default 60 seconds) that slides forward with each new trade.

**Metrics Calculated**:

- **Total Volume**: Sum of all contract counts in the window
- **Trade Count**: Number of individual trades in the window
- **Directional Bias**: Percentage of trades that are YES vs NO (0.0 = all NO, 1.0 = all YES)
- **Price Change**: Net price movement within the window

**Momentum Thresholds** (all must be met):

- `MOMENTUM_MIN_VOLUME`: Minimum total contracts traded
- `MOMENTUM_MIN_TRADES`: Minimum number of separate trades
- `MOMENTUM_MIN_DIRECTIONAL_BIAS`: Minimum directional strength (e.g., 0.75 = 75%+ in one direction)

**Momentum Trigger Logic**:

```typescript
// Momentum is triggered when ALL of these are true:
volume >= MOMENTUM_MIN_VOLUME
trades >= MOMENTUM_MIN_TRADES
(directionalBias >= MOMENTUM_MIN_DIRECTIONAL_BIAS) OR
(directionalBias <= 1 - MOMENTUM_MIN_DIRECTIONAL_BIAS)
```

**Entry Direction**:

- If `directionalBias >= 0.5`: Enter YES position
- If `directionalBias < 0.5`: Enter NO position

**Purpose**: Identifies markets where there's strong, consistent buying/selling pressure that's likely to move prices in a predictable direction.

#### 3. Position Management

**Opening Positions**:

- Only opens if no existing position for that ticker
- Respects `MAX_OPEN_POSITIONS` limit
- Entry price: Uses the trade execution price from the momentum trigger
- Position size: Fixed dollar amount (`POSITION_SIZE` in dollars)
  - Number of contracts is calculated automatically: `contracts = (POSITION_SIZE * 100) / entry_price_in_cents`
  - Example: $1.00 position at 50 cents entry = 2 contracts

**Monitoring**:

- Periodically checks current market prices (configurable interval)
- Uses mid-price (average of bid/ask) to avoid spread issues
- Calculates real-time P&L and P&L percentage

**Exit Conditions**:

- **Profit Target**: Closes when `pnlPercent >= PROFIT_TARGET * 100`
- **Stop Loss**: Closes when `pnlPercent <= -STOP_LOSS * 100`
- Both are optional (set to empty/null to disable)

**Purpose**: Manages risk and locks in profits while limiting losses.

## Installation

### Prerequisites

- Node.js 18+
- npm or yarn

### Setup

1. Clone the repository:

```bash
git clone <repository-url>
cd dflow-copy-trade
```

2. Install dependencies:

```bash
npm install
```

3. Create your `.env` file:

```bash
cp .env.example .env
```

4. Edit `.env` and set `DFLOW_ENDPOINT`:

   - For development: `dev-prediction-markets-api.dflow.net`
   - For production: `prediction-markets-api.dflow.net`

5. Build the project:

```bash
npm run build
```

## Configuration

The project includes a `.env.example` file with all available configuration options. Copy it to `.env` and customize as needed:

```bash
cp .env.example .env
```

**Required Configuration:**

- `DFLOW_ENDPOINT` - Must be set to your desired endpoint (see below)

All other variables have sensible defaults. Here are the available options:

### DFlow API Configuration

```env
# DFlow API endpoint
# Use dev-prediction-markets-api.dflow.net for dev
# Use prediction-markets-api.dflow.net for production
DFLOW_ENDPOINT=dev-prediction-markets-api.dflow.net
```

### Market Filtering

```env
# Minimum market volume (in dollars) to consider
# Example: 1000000 = $1,000,000 minimum volume
MIN_VOLUME=1000000
```

### Momentum Detection

```env
# Time window in seconds to analyze for momentum
MOMENTUM_WINDOW_SECONDS=60

# Minimum total volume (contract count) within window
MOMENTUM_MIN_VOLUME=750

# Minimum number of trades within window
MOMENTUM_MIN_TRADES=6

# Minimum directional bias (0.0-1.0)
# 0.75 = at least 75% of trades in one direction
MOMENTUM_MIN_DIRECTIONAL_BIAS=0.75
```

### Paper Trading

```env
# Fixed dollar amount per position (contracts calculated automatically)
# Example: 1 = $1.00 per position, 5 = $5.00 per position
POSITION_SIZE=1

# Maximum open positions at once
MAX_OPEN_POSITIONS=10

# Profit target as decimal (0.025 = 2.5%, 0.1 = 10%)
# Leave empty to disable
PROFIT_TARGET=0.025

# Stop loss as decimal (0.12 = 12%, 0.1 = 10%)
# Leave empty to disable
STOP_LOSS=0.12

# Price check interval in milliseconds
PRICE_CHECK_INTERVAL_MS=2000

# Maximum position age in milliseconds (force close if can't get price data)
# Default: 300000 (5 minutes)
MAX_POSITION_AGE_MS=300000
```

### Output Verbosity

```env
# Set to 0 to hide, any other value to show
SHOW_SKIPPED_TRADES=0
SHOW_MOMENTUM_BUILDING=0
```

### Cooldown Configuration

```env
# Set to 0 to disable, any other value to enable
# Prevents re-entering positions on the same ticker after closing
LOSS_COOLDOWN=1
WIN_COOLDOWN=0

# Cooldown duration in milliseconds
COOLDOWN_TIME=60000
```

### WebSocket Reconnection

```env
# Delay between reconnection attempts in milliseconds
RECONNECT_DELAY_MS=5000
```

## Usage

### Development Mode

Run with TypeScript directly (no build required):

```bash
npm run dev
```

### Production Mode

Build and run:

```bash
npm run build
npm start
```

### What You'll See

**On Startup**:

```
✅ Connected to WebSocket
Min volume threshold: $1,000,000
Momentum config: window=60s, minVolume=750, minTrades=6, minBias=0.75
Paper trading: positionSize=$1.00 (fixed dollar amount), maxPositions=10, profitTarget=2.5%, stopLoss=12%
Cooldown: loss=enabled, win=disabled, time=60s
📝 Trades will be logged to: /path/to/trades.jsonl
```

**During Operation**:

- `🚀 MOMENTUM TRIGGERED` - When a trade candidate is identified
- `📈 OPENED POSITION` - When a position is opened
- `💰 Position update` - Periodic P&L updates for open positions
- `📉 CLOSED POSITION` - When a position is closed (with reason)

**Every 5 Minutes**:

- Performance metrics summary (if trades have occurred)

## Performance Metrics

The bot tracks and reports the following metrics:

- **Total Trades**: Number of completed trades
- **Win Rate**: Percentage of profitable trades
- **Total P&L**: Cumulative profit/loss in dollars
- **Average Win/Loss**: Mean profit per winning/losing trade
- **Profit Factor**: Total wins / Total losses (higher is better, >1.0 is profitable)
- **Largest Win/Loss**: Best and worst individual trades
- **Trades/Hour**: Trading frequency

### Metrics Output Example

```
============================================================
📊 PERFORMANCE METRICS
============================================================
Total Trades: 25
Win Rate: 60.0% (15W / 10L)
Total P&L: $2.45
Avg Win: $0.35
Avg Loss: $-0.18
Profit Factor: 2.92
Largest Win: $0.75
Largest Loss: $-0.25
Session Duration: 30.5 minutes
Trades/Hour: 49.2
============================================================
```

## Trade Logging

All closed trades are automatically logged to `trades.jsonl` in JSON Lines format. Each entry contains:

```json
{
  "ticker": "KXBOXING-25DEC19JPAUAJOS-JPAU",
  "side": "yes",
  "entryPrice": 14,
  "exitPrice": 15,
  "entryTime": "2024-12-19T10:35:58.311Z",
  "exitTime": "2024-12-19T10:36:05.423Z",
  "duration": 7.112,
  "pnl": 0.01,
  "pnlPercent": 7.14,
  "reason": "Profit target reached (7.14%)",
  "momentumMetrics": {
    "volume": 1324,
    "trades": 5,
    "bias": 1.0,
    "priceChange": 0
  }
}
```

### Analyzing Trade Data

You can analyze the `trades.jsonl` file to:

- Identify which momentum patterns lead to profitable trades
- Find optimal parameter settings
- Discover market characteristics that correlate with success
- Calculate custom metrics

Example analysis with `jq`:

```bash
# Total P&L
cat trades.jsonl | jq -s 'map(.pnl) | add'

# Win rate
cat trades.jsonl | jq -s '(map(select(.pnl > 0)) | length) / length * 100'

# Average hold time
cat trades.jsonl | jq -s 'map(.duration) | add / length'
```

## Algorithm Tuning Guide

### Understanding Momentum Metrics

**Volume**: Higher volume suggests stronger conviction, but very high volume might mean you're late to the move.

**Trade Count**: More trades = more participants = potentially more sustainable momentum.

**Directional Bias**:

- 1.0 (100% YES) = Very strong bullish momentum
- 0.0 (0% YES) = Very strong bearish momentum
- 0.5 = Balanced/unclear direction

**Price Change**: Positive = price moving up, Negative = price moving down. Large changes might indicate you're entering late.

### Optimization Strategies

1. **Start Conservative**: Begin with higher thresholds and gradually lower them

   - Higher `MOMENTUM_MIN_VOLUME` = fewer but potentially higher quality signals
   - Higher `MOMENTUM_MIN_DIRECTIONAL_BIAS` = stronger directional conviction required

2. **Analyze Your Data**: After collecting trades, look for patterns:

   - Do trades with higher volume perform better?
   - Are certain price ranges more profitable?
   - What's the optimal hold time?

3. **Risk Management**:

   - Use stop losses to limit downside
   - Set realistic profit targets (5-10% is common)
   - Limit position size and max positions

4. **Market Conditions**:
   - High volatility markets may need wider stop losses
   - Low liquidity markets may have wider spreads (affecting P&L)

### Common Adjustments

**Too Many Trades**:

- Increase `MIN_VOLUME`
- Increase `MOMENTUM_MIN_VOLUME` or `MOMENTUM_MIN_TRADES`
- Increase `MOMENTUM_MIN_DIRECTIONAL_BIAS`

**Too Few Trades**:

- Decrease the above thresholds
- Decrease `MOMENTUM_WINDOW_SECONDS` (faster detection)

**High Win Rate but Low Profit**:

- Increase `PROFIT_TARGET` to let winners run
- Check if you're closing profitable trades too early

**Low Win Rate**:

- Increase momentum thresholds (better signal quality)
- Consider adding minimum price filter (avoid very low-priced, volatile markets)
- Review if stop loss is too tight

## Technical Details

### Data Flow

1. **WebSocket Connection**: Connects to `wss://{endpoint}/api/v1/ws`
2. **Trade Stream**: Subscribes to all trade updates
3. **Market Cache**: Caches market data to reduce API calls
4. **Momentum Window**: Maintains rolling window of recent trades per ticker
5. **Position Tracking**: In-memory Map of open positions
6. **Price Monitoring**: Periodic REST API calls to check current prices

### Price Calculation

- **Entry Price**: Uses the actual trade execution price from the WebSocket
- **Exit Price**: Uses mid-price (average of bid and ask) from REST API to avoid spread issues

### Error Handling

- Failed market fetches are logged but don't crash the bot
- 404 errors (market not found) are not cached, allowing retries if markets become available
- WebSocket errors are caught and logged
- **Automatic reconnection**: WebSocket automatically reconnects on disconnect with configurable delay
- Missing price data skips that position check (retries next interval)
- Positions that can't get price data for longer than `MAX_POSITION_AGE_MS` are force-closed to prevent stuck positions

## Limitations

- **Paper Trading Only**: This is simulation - real trading requires additional considerations
- **No Historical Data**: Algorithm is tuned based on live data collection
- **Market Data Availability**: Depends on DFlow API availability and rate limits
- **Spread Impact**: Real trading would have bid/ask spread costs not fully captured
- **Slippage**: Real execution may differ from paper trading prices

## Future Enhancements

Potential improvements:

- Historical backtesting capability
- Multiple strategy variants running in parallel
- Machine learning for momentum pattern recognition
- Real-time dashboard/visualization
- Integration with actual trading APIs
- Advanced risk management (position sizing, correlation limits)

## Troubleshooting

**No trades triggering**:

- Check if `MIN_VOLUME` is too high
- Verify momentum thresholds aren't too strict
- Enable `SHOW_SKIPPED_TRADES=1` to see what's being filtered

**Positions not closing**:

- Verify `PROFIT_TARGET` and `STOP_LOSS` are set correctly
- Check if price checks are running (look for position updates)
- Ensure market data is available for those tickers

**High number of stop losses**:

- Consider wider stop loss or disabling it
- Review if momentum thresholds need adjustment
- Check if entering at bad prices (late to the move)

## License

[Your License Here]

## Contributing

[Contributing Guidelines]

## Support

[Support Information]
