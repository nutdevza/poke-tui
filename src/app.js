import { createMcpServer, startMcpHttpServer, mcpEvents } from "./mcp-server.js";
import { PokeClient } from "./poke-client.js";
import { startTUI, tuiEvents } from "./tui.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";

function acquireLock() {
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "poke-tui");
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, "poke-tui.lock");
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        console.error(`poke-tui already running (pid ${pid}). Ctrl-C that window first.`);
        process.exit(1);
      } catch {}
    }
  }
  writeFileSync(lockPath, String(process.pid));
  const release = () => { try { unlinkSync(lockPath); } catch {} };
  process.on("exit", release);
}

function resolveToken() {
  if (process.env.POKE_API_KEY) return process.env.POKE_API_KEY;

  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

  try {
    const cfg = JSON.parse(readFileSync(join(configDir, "poke-tui", "config.json"), "utf-8"));
    if (cfg.apiKey) return cfg.apiKey;
  } catch {}

  try {
    const creds = JSON.parse(readFileSync(join(configDir, "poke", "credentials.json"), "utf-8"));
    if (creds.token) return creds.token;
  } catch {}

  return null;
}

const POKE_API_KEY = resolveToken();

if (!POKE_API_KEY) {
  console.error("No credentials found. Run: npx poke-tui");
  process.exit(1);
}

acquireLock();
const inkInstance = startTUI();

tuiEvents.on("transcript", ({ kind, messages }) => {
  if (kind === "history") {
    const last = messages.slice(-20);
    if (last.length === 0) {
      tuiEvents.emit("system", "No messages yet.");
      return;
    }
    for (const m of last) {
      const t = m.at
        ? new Date(m.at).toLocaleTimeString("th-TH", {
            timeZone: "Asia/Bangkok",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        : "";
      tuiEvents.emit("system", `${t} ${m.role}: ${String(m.text).replace(/\s+/g, " ").slice(0, 140)}`);
    }
    return;
  }
  if (kind === "export") {
    const dir = join(homedir(), "Downloads");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filePath = join(dir, `poke-tui-${stamp}.md`);
    const md = messages.map((m) => {
      const t = m.at ? new Date(m.at).toISOString() : "";
      return `### ${m.role} (${t})\n\n${m.text}\n`;
    }).join("\n");
    writeFileSync(filePath, md, "utf8");
    tuiEvents.emit("system", `Exported ${messages.length} messages to ${filePath}`);
  }
});

const client = new PokeClient({
  apiKey: POKE_API_KEY,
  onEvent: (type, data) => {
    switch (type) {
      case "tunnel-connected":
        tuiEvents.emit("connected", true);
        break;
      case "tunnel-disconnected":
        tuiEvents.emit("connected", false);
        tuiEvents.emit("thinking", false);
        tuiEvents.emit("system", "Connection lost. Reconnecting…");
        break;
      case "tunnel-error":
        tuiEvents.emit("error", `Connection error: ${data}`);
        break;
      case "status":
        tuiEvents.emit("system", data);
        break;
      case "error":
        tuiEvents.emit("error", data);
        break;
    }
  },
});

mcpEvents.on("reply", (text) => {
  tuiEvents.emit("message", "poke", text);
});

mcpEvents.on("notification", (message) => {
  tuiEvents.emit("system", message);
});

tuiEvents.on("user-input", async (text) => {
  if (text.startsWith("/")) {
    await handleCommand(text);
    return;
  }

  tuiEvents.emit("message", "you", text);

  try {
    const res = await client.sendMessage(text);
    if (res.success === false) {
      tuiEvents.emit("error", res.message || "Failed to send message.");
    }
  } catch (err) {
    tuiEvents.emit("error", err.message);
  }
});

tuiEvents.on("user-quit", async () => {
  try { await client.stop(); } catch {}
  process.exit(0);
});

async function handleCommand(text) {
  const parts = text.slice(1).split(" ");
  const cmd = parts[0]?.toLowerCase();

  if (cmd === "help") {
    tuiEvents.emit("system", "Commands:");
    tuiEvents.emit("system", "  /webhook create <when> | <do what>");
    tuiEvents.emit("system", '  /webhook fire <#> {"data":"here"}');
    tuiEvents.emit("system", "  /webhooks");
    tuiEvents.emit("system", "  /status");
    tuiEvents.emit("system", "  /clear");
    tuiEvents.emit("system", "  /history");
    tuiEvents.emit("system", "  /export");
    tuiEvents.emit("system", "  /attach <path>   (also /sendfile)");
    tuiEvents.emit("system", "  Esc cancels wait · PgUp/PgDn scroll · 45s timeout");
    return;
  }

  if (cmd === "history") {
    tuiEvents.emit("dump-transcript", "history");
    return;
  }

  if (cmd === "export") {
    tuiEvents.emit("dump-transcript", "export");
    return;
  }

  if (cmd === "attach" || cmd === "sendfile") {
    const raw = parts.slice(1).join(" ").trim().replace(/^["']|["']$/g, "");
    if (!raw) {
      tuiEvents.emit("error", "Usage: /attach <path>");
      return;
    }
    try {
      const filePath = resolve(raw);
      const buf = readFileSync(filePath);
      if (buf.length > 24_000) {
        tuiEvents.emit("error", `File too large (${buf.length} bytes). Max 24KB.`);
        return;
      }
      const name = basename(filePath);
      const body = buf.toString("utf8");
      const wrapped = `Attached file ${name}:\n\`\`\`\n${body}\n\`\`\`\nPlease use this as context.`;
      tuiEvents.emit("message", "you", `/attach ${name}`);
      const res = await client.sendMessage(wrapped);
      if (res.success === false) tuiEvents.emit("error", res.message || "Failed to send file.");
      else tuiEvents.emit("system", `Attached ${name} (${buf.length} bytes).`);
    } catch (err) {
      tuiEvents.emit("error", err.message);
    }
    return;
  }

  if (cmd === "clear") {
    tuiEvents.emit("clear");
    tuiEvents.emit("thinking", false);
    tuiEvents.emit("system", "Chat cleared.");
    return;
  }

  if (cmd === "status") {
    tuiEvents.emit("system", client.tunnelInfo ? "Connected and ready." : "Connecting…");
    if (client.tunnelInfo?.tunnelUrl) {
      tuiEvents.emit("system", `Tunnel: ${client.tunnelInfo.tunnelUrl}`);
    }
    if (client.tunnelInfo?.connectionId) {
      tuiEvents.emit("system", `Connection: ${client.tunnelInfo.connectionId}`);
    }
    tuiEvents.emit("system", `Webhooks: ${client.webhooks.length}${client.terminalWebhook ? " + terminal webhook" : ""}`);
    return;
  }

  if (cmd === "webhooks") {
    if (client.webhooks.length === 0) {
      tuiEvents.emit("system", "No webhooks yet. Create one with /webhook create");
      return;
    }
    client.webhooks.forEach((wh, i) => {
      tuiEvents.emit("system", `  #${i}  ${wh.triggerId}`);
    });
    return;
  }

  if (cmd === "webhook") {
    const sub = parts[1]?.toLowerCase();

    if (sub === "create") {
      const rest = parts.slice(2).join(" ");
      const pipeIdx = rest.indexOf("|");
      if (pipeIdx === -1) {
        tuiEvents.emit("error", "Usage: /webhook create <when> | <do what>");
        return;
      }
      const condition = rest.slice(0, pipeIdx).trim();
      const action = rest.slice(pipeIdx + 1).trim();
      try {
        await client.createWebhook({ condition, action });
        tuiEvents.emit("system", `Webhook #${client.webhooks.length - 1} created.`);
      } catch (err) {
        tuiEvents.emit("error", err.message);
      }
      return;
    }

    if (sub === "fire") {
      const index = parseInt(parts[2], 10);
      const jsonStr = parts.slice(3).join(" ");
      if (isNaN(index) || !jsonStr) {
        tuiEvents.emit("error", 'Usage: /webhook fire <#> {"data":"here"}');
        return;
      }
      let data;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        tuiEvents.emit("error", "Invalid JSON.");
        return;
      }
      try {
        await client.fireWebhook(index, data);
        tuiEvents.emit("system", "Webhook fired.");
      } catch (err) {
        tuiEvents.emit(
          "error",
          `${err.message} — stale webhook from an old session. Create a new one with /webhook create <when> | <do what>, then /webhook fire 0 {"status":"test"}. Plain chat does not use webhooks.`
        );
      }
      return;
    }

    tuiEvents.emit("error", "Try: /webhook create or /webhook fire");
    return;
  }

  tuiEvents.emit("error", "Unknown command. Type /help");
}

async function fetchUserName() {
  const base = process.env.POKE_API ?? "https://poke.com/api/v1";

  // Try login token first (from `poke login`), then API key
  const { getToken } = await import("poke");
  const tokens = [getToken(), POKE_API_KEY].filter(Boolean);

  for (const token of tokens) {
    try {
      const res = await fetch(`${base}/user/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const full = data.name || data.email || data.id || null;
        if (!full) return null;
        return full.split(/[\s@]/)[0];
      }
    } catch {}
  }
  return null;
}

async function main() {
  fetchUserName().then((name) => {
    if (name) tuiEvents.emit("user-name", name);
  });

  try {
    createMcpServer();
    const { port } = await startMcpHttpServer();
    await client.init(port);
    await client.startTunnel(port);
  } catch (err) {
    tuiEvents.emit("error", err.message);
    tuiEvents.emit("system", "Replies will arrive on your phone instead.");
  }
}

main();
