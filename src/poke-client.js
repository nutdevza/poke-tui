import { Poke, PokeTunnel, login, isLoggedIn, getToken } from "poke";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TUNNEL_NAME = "poke-tui-terminal";

const REPLY_INSTRUCTION =
  "[TERMINAL SESSION — MANDATORY]\n" +
  "The user is typing in poke-tui. MCP connection name: poke-tui-terminal.\n" +
  "You are the MAIN ORCHESTRATOR. You do not have reply_to_terminal on yourself.\n" +
  "MCP tools live on the poke-tui-terminal SUB-AGENT only.\n" +
  "You MUST immediately dispatch that MCP sub-agent.\n" +
  "The sub-agent MUST call tool reply_to_terminal with argument text = your COMPLETE answer.\n" +
  "DO NOT reply via iMessage, SMS, or Telegram. Leave the chat body empty.\n" +
  "If you answer in iMessage, the terminal stays blank — that is a failure.\n" +
  "[END TERMINAL SESSION]\n\n";

const CONFIG_DIR = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const STATE_PATH = join(CONFIG_DIR, "poke-tui", "state.json");

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")); } catch { return {}; }
}

function saveState(state) {
  mkdirSync(join(CONFIG_DIR, "poke-tui"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export class PokeClient {
  constructor({ apiKey, onEvent }) {
    this.apiKey = apiKey;
    this.onEvent = onEvent || (() => {});
    this.poke = null;
    this.tunnel = null;
    this.tunnelInfo = null;
    this.webhooks = [];
    this.terminalWebhook = loadState().terminalWebhook || null;
  }

  async init(mcpPort) {
    this.poke = new Poke({ apiKey: this.apiKey });
    this.mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
    this.onEvent("status", "SDK initialized");
  }

  async cleanupOldConnection() {
    const state = loadState();
    if (!state.connectionId) return;
    const token = getToken() || this.apiKey;
    const base = process.env.POKE_API ?? "https://poke.com/api/v1";
    try {
      await fetch(`${base}/mcp/connections/${state.connectionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
  }

  async startTunnel(mcpPort) {
    const token = getToken();
    if (!token && !this.apiKey) {
      this.onEvent("error", "Not logged in. Run `poke login` first or set POKE_API_KEY.");
      return;
    }

    // Keep the previous cloud tunnel URL alive. Poke integrations often still
    // call /{old-uuid}/mcp on the new local server after a restart.

    this.tunnel = new PokeTunnel({
      url: this.mcpUrl,
      name: TUNNEL_NAME,
      token: token || this.apiKey,
      cleanupOnStop: false,
    });

    this.tunnel.on("connected", (info) => {
      this.tunnelInfo = info;
      const prev = loadState();
      saveState({
        ...prev,
        connectionId: info.connectionId,
        tunnelUrl: info.tunnelUrl || null,
        name: TUNNEL_NAME,
      });
      this.onEvent("tunnel-connected", info);
    });

    this.tunnel.on("disconnected", () => {
      this.tunnelInfo = null;
      this.onEvent("tunnel-disconnected");
    });

    this.tunnel.on("error", (err) => {
      this.onEvent("tunnel-error", err.message);
    });

    this.tunnel.on("toolsSynced", ({ toolCount }) => {
      this.onEvent("tools-synced", toolCount);
    });

    this.tunnel.on("oauthRequired", ({ authUrl }) => {
      this.onEvent("oauth-required", authUrl);
    });

    try {
      const info = await this.tunnel.start();
      // Explicitly sync tools right after tunnel connects —
      // activateTunnel() syncs server-side but doesn't emit the event
      setTimeout(() => this.syncTools(), 2000);
      return info;
    } catch (err) {
      this.onEvent("tunnel-error", err.message);
      throw err;
    }
  }

  async ensureTerminalWebhook() {
    const state = loadState();
    if (state.terminalWebhook?.webhookUrl && state.terminalWebhook?.webhookToken) {
      this.terminalWebhook = state.terminalWebhook;
      return this.terminalWebhook;
    }
    try {
      const webhook = await this.poke.createWebhook({
        condition: "When poke-tui fires a terminal chat payload with source poke-tui-terminal",
        action:
          "Dispatch the poke-tui-terminal MCP sub-agent. " +
          "Call reply_to_terminal with argument text set to your complete answer. " +
          "Do not send iMessage, SMS, or Telegram. Leave the chat body empty.",
      });
      this.terminalWebhook = webhook;
      saveState({ ...loadState(), terminalWebhook: webhook });
      this.onEvent("status", "Terminal webhook ready");
      return webhook;
    } catch (err) {
      this.onEvent("error", `Webhook setup skipped: ${err.message}`);
      return null;
    }
  }

  async sendMessage(text) {
    if (!this.poke) throw new Error("SDK not initialized");
    // Plain chat must use inbound sendMessage. Routing it through a stored
    // webhook 502s when the trigger/token is from a previous session.
    return this.poke.sendMessage(REPLY_INSTRUCTION + text);
  }

  async createWebhook({ condition, action }) {
    if (!this.poke) throw new Error("SDK not initialized");
    const webhook = await this.poke.createWebhook({
      condition,
      action:
        action +
        " [TERMINAL SESSION: Call reply_to_terminal with your full answer. DO NOT write any chat message. Leave chat reply empty. ONLY use the tool.]",
    });
    this.webhooks.push(webhook);
    return webhook;
  }

  async fireWebhook(index, data) {
    const webhook = this.webhooks[index];
    if (!webhook) throw new Error(`No webhook at index ${index}`);
    return this.poke.sendWebhook({
      webhookUrl: webhook.webhookUrl,
      webhookToken: webhook.webhookToken,
      data,
    });
  }

  async syncTools() {
    if (!this.tunnel) return;
    try {
      // Access the tunnel's internal syncTools via the same API call
      const { PokeTunnel } = await import("poke");
      const fetchWithAuth = (await import("poke")).PokeAuthError; // just to trigger import
      const token = (await import("poke")).getToken();
      const baseUrl = process.env.POKE_API ?? "https://poke.com/api/v1";
      const connId = this.tunnel.info?.connectionId;
      if (!connId) return;

      const res = await fetch(`${baseUrl}/mcp/connections/${connId}/sync-tools`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token || this.apiKey}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        const toolCount = Array.isArray(data.tools) ? data.tools.length : 0;
        this.onEvent("tools-synced", toolCount);
      } else {
        this.onEvent("error", `Sync tools failed: HTTP ${res.status}`);
      }
    } catch (err) {
      this.onEvent("error", `Sync tools error: ${err.message}`);
    }
  }

  async stop() {
    if (this.tunnel) {
      try {
        await this.tunnel.stop();
      } catch {}
    }
  }
}
