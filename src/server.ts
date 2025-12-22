/**
 * HTTP Server for UI Dashboard
 */

import express, { Express } from "express";
import { Position } from "./types";
import { setupRoutes } from "./api/routes";
import { getDashboardHTML } from "./ui/dashboard";

export interface ClosedTrade {
  ticker: string;
  side: "yes" | "no";
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  duration: number;
  pnl: number;
  pnlPercent: number;
  reason: string;
}

import { Market } from "./types";

export interface ServerState {
  positions: Map<string, Position>;
  closedTrades: ClosedTrade[];
  getCurrentPrice: (ticker: string) => Promise<{ yesPrice: number; noPrice: number } | null>;
  fetchMarket: (ticker: string) => Promise<Market | null>;
  closePosition: (ticker: string) => Promise<{ success: boolean; error?: string }>;
}

let httpServer: ReturnType<Express["listen"]> | null = null;

export async function startServer(port: number, state: ServerState): Promise<void> {
  const app = express();
  app.use(express.json());

  // Serve dashboard HTML
  app.get("/", (req, res) => {
    res.send(getDashboardHTML());
  });

  // Setup API routes
  await setupRoutes(app, state);

  httpServer = app.listen(port, () => {
    console.log(`🌐 UI server running on http://localhost:${port}`);
  });
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (httpServer) {
      // Remove all listeners to prevent memory leak warnings
      httpServer.removeAllListeners();
      
      // Force close all connections if available (Node 18.2.0+)
      if (typeof (httpServer as any).closeAllConnections === "function") {
        (httpServer as any).closeAllConnections();
      }
      
      httpServer.close(() => {
        console.log("HTTP server closed");
        httpServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

