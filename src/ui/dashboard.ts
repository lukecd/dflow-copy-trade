/**
 * Dashboard HTML Template with DaisyUI
 */

import { colors } from "./colors";

export function getDashboardHTML(): string {
  return `
<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DFlow Copy Trade - Dashboard</title>
  <link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.10/dist/full.min.css" rel="stylesheet" type="text/css" />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root {
      --p: ${colors.primary};
      --s: ${colors.primaryLight};
      --a: ${colors.dark};
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
    }
    .pnl-positive {
      color: #10b981;
      font-weight: 600;
    }
    .pnl-negative {
      color: #ef4444;
      font-weight: 600;
    }
    .badge-yes {
      background-color: ${colors.primaryLight};
      color: ${colors.dark};
      border: none;
    }
    .badge-no {
      background-color: ${colors.neutralLight};
      color: ${colors.dark};
      border: none;
    }
  </style>
</head>
<body class="bg-base-200">
  <div class="container mx-auto px-4 py-8 max-w-7xl">
    <div class="mb-6 flex justify-between items-center">
      <div>
        <h1 class="text-3xl font-bold" style="color: ${colors.dark}">DFlow Copy Trade Dashboard</h1>
        <p class="text-sm mt-2" style="color: ${colors.darkMuted}">Real-time position monitoring</p>
      </div>
      <label class="label cursor-pointer gap-2">
        <span class="label-text" style="color: ${colors.darkMuted}">Show closed trades</span>
        <input type="checkbox" id="showClosedTrades" class="toggle toggle-primary" />
      </label>
    </div>
    
    <div id="positions-container">
      <div class="flex justify-center items-center py-20">
        <span class="loading loading-spinner loading-lg" style="color: ${colors.primary}"></span>
        <span class="ml-4" style="color: ${colors.darkMuted}">Loading positions...</span>
      </div>
    </div>
  </div>
  
  <script>
    let showClosedTrades = false;
    
    // Toggle handler
    document.addEventListener('DOMContentLoaded', () => {
      const toggle = document.getElementById('showClosedTrades');
      if (toggle) {
        toggle.addEventListener('change', (e) => {
          showClosedTrades = e.target.checked;
          loadPositions();
        });
      }
    });
    
    async function loadPositions() {
      try {
        const [positionsResponse, closedTradesResponse] = await Promise.all([
          fetch('/api/positions'),
          fetch('/api/closed-trades')
        ]);
        
        const positionsData = await positionsResponse.json();
        const closedTradesData = await closedTradesResponse.json();
        const container = document.getElementById('positions-container');
        
        const allPositions = positionsData.positions || [];
        const closedTrades = showClosedTrades ? (closedTradesData.closedTrades || []) : [];
        
        if (allPositions.length === 0 && closedTrades.length === 0) {
          container.innerHTML = \`
            <div class="card bg-base-100 shadow-xl">
              <div class="card-body text-center py-20">
                <p style="color: ${colors.darkMuted}">No positions</p>
              </div>
            </div>
          \`;
          return;
        }
        
        // Calculate total P&L (only for open positions)
        let totalPnl = 0;
        let totalEntryValue = 0; // Total invested (entry price * contracts for all positions)
        let totalCurrentValue = 0; // Total current value (current price * contracts for all positions)
        let hasValidPnl = false;
        
        // Build table rows for open positions
        const openRows = allPositions.map(pos => {
          const entryDate = new Date(pos.entryTime).toLocaleString();
          const entryPriceDollars = (pos.entryPrice / 100).toFixed(4);
          const currentPriceDollars = pos.currentPrice ? (pos.currentPrice / 100).toFixed(4) : 'N/A';
          const pnlDollars = pos.pnl !== null ? (pos.pnl / 100).toFixed(2) : 'N/A';
          const pnlPercent = pos.pnlPercent !== null ? pos.pnlPercent.toFixed(2) : 'N/A';
          
          // Accumulate total P&L and values for percentage calculation
          if (pos.pnl !== null && pos.currentPrice !== null) {
            totalPnl += pos.pnl;
            // Entry value = entry price (cents) * contracts
            totalEntryValue += pos.entryPrice * pos.contracts;
            // Current value = current price (cents) * contracts
            totalCurrentValue += pos.currentPrice * pos.contracts;
            hasValidPnl = true;
          }
          
          // P&L styling
          const pnlClass = pos.pnl !== null 
            ? (pos.pnl >= 0 ? 'pnl-positive' : 'pnl-negative')
            : '';
          const pnlSign = pos.pnl !== null && pos.pnl >= 0 ? '+' : '';
          
          // Side badge
          const sideBadgeClass = pos.side === 'yes' ? 'badge-yes' : 'badge-no';
          
          // Kalshi link - use URL from API (constructed from market data)
          const kalshiUrl = pos.kalshiUrl || \`https://kalshi.com/markets?q=\${encodeURIComponent(pos.ticker.toLowerCase())}\`;
          
          return \`
            <tr class="hover">
              <td>
                \${pos.title ? \`<div class="font-semibold">\${pos.title}</div>\` : ''}
                \${pos.side === 'yes' && pos.yesSubTitle 
                  ? \`<div class="text-sm opacity-70">YES: \${pos.yesSubTitle}</div>\` 
                  : pos.side === 'no' && pos.noSubTitle 
                    ? \`<div class="text-sm opacity-70">NO: \${pos.noSubTitle}</div>\`
                    : pos.subtitle 
                      ? \`<div class="text-sm opacity-70">\${pos.subtitle}</div>\`
                      : ''}
                <a href="\${kalshiUrl}" target="_blank" rel="noopener noreferrer" class="link link-primary text-xs hover:underline">
                  \${pos.ticker}
                </a>
                <div class="text-sm opacity-50">\${entryDate}</div>
              </td>
              <td>
                <span class="badge \${sideBadgeClass}">\${pos.side.toUpperCase()}</span>
              </td>
              <td>\$\${entryPriceDollars}</td>
              <td>\${pos.currentPrice !== null ? \`\$\${currentPriceDollars}\` : '<span class="text-gray-400">N/A</span>'}</td>
              <td>\${pos.contracts}</td>
              <td class="\${pnlClass}">
                \${pos.pnl !== null ? \`\${pnlSign}\$\${pnlDollars}\` : 'N/A'}
              </td>
              <td class="\${pnlClass}">
                \${pos.pnlPercent !== null ? \`\${pnlSign}\${pnlPercent}%\` : 'N/A'}
              </td>
              <td>
                <span class="badge badge-ghost">OPEN</span>
                <button 
                  onclick="closePosition('\${pos.ticker}')" 
                  class="btn btn-sm btn-error mt-2"
                  style="background-color: ${colors.primary}; border: none;"
                >
                  Close
                </button>
              </td>
            </tr>
          \`;
        }).join('');
        
        // Build table rows for closed trades
        const closedRows = closedTrades.map(trade => {
          const entryDate = new Date(trade.entryTime).toLocaleString();
          const exitDate = new Date(trade.exitTime).toLocaleString();
          const entryPriceDollars = (trade.entryPrice / 100).toFixed(4);
          const exitPriceDollars = (trade.exitPrice / 100).toFixed(4);
          const pnlDollars = trade.pnl.toFixed(2);
          const pnlPercent = trade.pnlPercent.toFixed(2);
          const durationMinutes = (trade.duration / 60).toFixed(1);
          
          // P&L styling
          const pnlClass = trade.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
          const pnlSign = trade.pnl >= 0 ? '+' : '';
          
          // Side badge
          const sideBadgeClass = trade.side === 'yes' ? 'badge-yes' : 'badge-no';
          
          // Kalshi link - use URL from API (constructed from market data)
          const kalshiUrl = trade.kalshiUrl || \`https://kalshi.com/markets?q=\${encodeURIComponent(trade.ticker.toLowerCase())}\`;
          
          // Calculate contracts from P&L and price difference
          // pnl (dollars) = (price_diff_cents) * contracts / 100
          // So: contracts = (pnl * 100) / price_diff_cents
          let priceDiff = 0;
          if (trade.side === 'yes') {
            priceDiff = trade.exitPrice - trade.entryPrice;
          } else {
            priceDiff = trade.entryPrice - trade.exitPrice;
          }
          const estimatedContracts = priceDiff !== 0 ? Math.round((trade.pnl * 100) / priceDiff) : 0;
          
          return \`
            <tr class="hover opacity-70">
              <td>
                \${trade.title ? \`<div class="font-semibold">\${trade.title}</div>\` : ''}
                \${trade.side === 'yes' && trade.yesSubTitle 
                  ? \`<div class="text-sm opacity-70">YES: \${trade.yesSubTitle}</div>\` 
                  : trade.side === 'no' && trade.noSubTitle 
                    ? \`<div class="text-sm opacity-70">NO: \${trade.noSubTitle}</div>\`
                    : trade.subtitle 
                      ? \`<div class="text-sm opacity-70">\${trade.subtitle}</div>\`
                      : ''}
                <a href="\${kalshiUrl}" target="_blank" rel="noopener noreferrer" class="link link-primary text-xs hover:underline">
                  \${trade.ticker}
                </a>
                <div class="text-sm opacity-50">Closed: \${exitDate}</div>
              </td>
              <td>
                <span class="badge \${sideBadgeClass}">\${trade.side.toUpperCase()}</span>
              </td>
              <td>\$\${entryPriceDollars}</td>
              <td>\$\${exitPriceDollars}</td>
              <td>~\${Math.abs(estimatedContracts)}</td>
              <td class="\${pnlClass}">
                \${pnlSign}\$\${pnlDollars}
              </td>
              <td class="\${pnlClass}">
                \${pnlSign}\${pnlPercent}%
              </td>
              <td>
                <span class="badge badge-ghost">CLOSED</span>
                <div class="text-xs opacity-50 mt-1">\${durationMinutes}m</div>
              </td>
            </tr>
          \`;
        }).join('');
        
        const tableRows = openRows + closedRows;
        
        // Total P&L row - calculate percentage
        const totalPnlDollars = (totalPnl / 100).toFixed(2);
        const totalPnlPercent = hasValidPnl && totalEntryValue > 0 
          ? (((totalCurrentValue - totalEntryValue) / totalEntryValue) * 100).toFixed(2)
          : null;
        const totalPnlClass = hasValidPnl ? (totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative') : '';
        const totalPnlSign = hasValidPnl && totalPnl >= 0 ? '+' : '';
        const totalRow = \`
          <tr class="bg-base-300 font-bold">
            <td colspan="6" class="text-right">Total P&L (Open Positions):</td>
            <td class="\${totalPnlClass}">
              \${hasValidPnl ? \`\${totalPnlSign}\$\${totalPnlDollars}\` : 'N/A'}
            </td>
            <td class="\${totalPnlClass}">
              \${totalPnlPercent !== null ? \`\${totalPnlSign}\${totalPnlPercent}%\` : 'N/A'}
            </td>
            <td></td>
          </tr>
        \`;
        
        container.innerHTML = \`
          <div class="card bg-base-100 shadow-xl">
            <div class="card-body p-0">
              <div class="overflow-x-auto">
                <table class="table table-zebra">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Side</th>
                      <th>Entry Price</th>
                      <th>Current Price</th>
                      <th>Contracts</th>
                      <th>P&L</th>
                      <th>P&L %</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    \${tableRows}
                    \${totalRow}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        \`;
      } catch (error) {
        document.getElementById('positions-container').innerHTML = \`
          <div class="alert alert-error">
            <span>Error loading positions. Please refresh the page.</span>
          </div>
        \`;
      }
    }
    
    async function closePosition(ticker) {
      if (!confirm(\`Are you sure you want to close position \${ticker}?\`)) {
        return;
      }
      
      try {
        const response = await fetch(\`/api/close-position/\${encodeURIComponent(ticker)}\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        
        if (result.success) {
          // Reload positions to reflect the change
          loadPositions();
        } else {
          alert(\`Failed to close position: \${result.error || 'Unknown error'}\`);
        }
      } catch (error) {
        alert(\`Error closing position: \${error.message}\`);
      }
    }
    
    // Load positions on page load
    loadPositions();
    
    // Refresh every 5 seconds
    setInterval(loadPositions, 5000);
  </script>
</body>
</html>
  `;
}
