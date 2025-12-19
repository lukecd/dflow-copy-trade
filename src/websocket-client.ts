import WebSocket from "ws";
import { TradeUpdate, SubscribeMessage, UnsubscribeMessage } from "./types";

export class DFlowWebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private headers: Record<string, string> | undefined;
  private reconnectInterval: number = 5000; // 5 seconds
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isIntentionallyClosed: boolean = false;

  constructor(
    url: string,
    headers?: Record<string, string>
  ) {
    this.url = url;
    this.headers = headers;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this.isIntentionallyClosed = false;
      
      // Create WebSocket with optional headers
      const options: WebSocket.ClientOptions = {};
      if (this.headers) {
        options.headers = this.headers;
      }
      
      this.ws = new WebSocket(this.url, options);

      this.ws.on("open", () => {
        console.log("✅ Connected to DFlow WebSocket");
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        resolve();
      });

      this.ws.on("error", (error: Error & { code?: string; statusCode?: number }) => {
        const statusCode = (error as any).statusCode || (error as any).code;
        if (statusCode === 403 || (error.message && error.message.includes("403"))) {
          console.error("❌ WebSocket error: 403 Forbidden");
          console.error("   This usually means authentication is required.");
          console.error("   Check if you need an API key or authentication token.");
          console.error("   Set DFLOW_API_KEY environment variable or use --api-key flag.");
        } else {
          console.error("❌ WebSocket error:", error.message || error);
        }
        if (!this.isIntentionallyClosed) {
          // Don't auto-reconnect on 403 errors
          if (statusCode !== 403 && !error.message?.includes("403")) {
            this.scheduleReconnect();
          }
        }
        reject(error);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        if (code === 1008 || code === 1003) {
          console.log(`🔌 WebSocket connection closed (code: ${code}): ${reasonStr || "Policy violation or authentication required"}`);
        } else {
          console.log(`🔌 WebSocket connection closed (code: ${code})`);
        }
        if (!this.isIntentionallyClosed && code !== 1008 && code !== 1003) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    console.log(`🔄 Reconnecting in ${this.reconnectInterval / 1000} seconds...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        console.error("Failed to reconnect:", error);
      });
    }, this.reconnectInterval);
  }

  subscribeAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    const message: SubscribeMessage = {
      type: "subscribe",
      channel: "trades",
      all: true,
    };

    this.ws.send(JSON.stringify(message));
    console.log("📡 Subscribed to all trades");
  }

  subscribeTickers(tickers: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    const message: SubscribeMessage = {
      type: "subscribe",
      channel: "trades",
      tickers,
    };

    this.ws.send(JSON.stringify(message));
    console.log(`📡 Subscribed to ${tickers.length} ticker(s):`, tickers.join(", "));
  }

  unsubscribeAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const message: UnsubscribeMessage = {
      type: "unsubscribe",
      channel: "trades",
      all: true,
    };

    this.ws.send(JSON.stringify(message));
    console.log("📡 Unsubscribed from all trades");
  }

  unsubscribeTickers(tickers: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const message: UnsubscribeMessage = {
      type: "unsubscribe",
      channel: "trades",
      tickers,
    };

    this.ws.send(JSON.stringify(message));
    console.log(`📡 Unsubscribed from ${tickers.length} ticker(s)`);
  }

  onTrade(callback: (trade: TradeUpdate) => void): void {
    if (!this.ws) {
      throw new Error("WebSocket is not connected");
    }

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.channel === "trades" && message.type === "trade") {
          callback(message as TradeUpdate);
        }
      } catch (error) {
        console.error("Error parsing WebSocket message:", error);
      }
    });
  }

  disconnect(): void {
    this.isIntentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

