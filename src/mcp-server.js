import http from "node:http";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const mcpEvents = new EventEmitter();

const SERVER_INFO = {
  name: "poke-tui",
  version: "1.0.1",
};

const LOG_DIR = join(process.env.APPDATA || process.env.HOME || ".", "Poke");
const LOG_PATH = join(LOG_DIR, "mcp-access.log");

function logLine(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

const TOOLS = [
  {
    name: "reply_to_terminal",
    description:
      "Send your full response to the user's terminal. The user is in a terminal-only session. Put your COMPLETE answer here. DO NOT write anything in your chat reply — leave it completely empty. No iMessage, no SMS, no Telegram. This tool is the ONLY way to respond.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The response text to display in the terminal" },
        message: { type: "string", description: "Alias for text" },
        content: { type: "string", description: "Alias for text" },
      },
    },
  },
  {
    name: "notify_terminal",
    description: "Send a short notification to the user's terminal status bar.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "A brief notification message" },
        text: { type: "string", description: "Alias for message" },
      },
    },
  },
];

function toolText(args = {}) {
  const value = args.text ?? args.message ?? args.content ?? args.reply ?? args.body;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return value.text ?? value.message ?? JSON.stringify(value);
  }
  return "";
}

function handleToolCall(name, args) {
  logLine(`tools/call name=${name} keys=${Object.keys(args || {}).join(",")}`);
  if (name === "reply_to_terminal") {
    const text = toolText(args);
    mcpEvents.emit("reply", text || "(empty reply_to_terminal payload)");
    return { content: [{ type: "text", text: "Delivered to terminal." }] };
  }
  if (name === "notify_terminal") {
    const message = toolText(args);
    mcpEvents.emit("notification", message);
    return { content: [{ type: "text", text: "Notification sent." }] };
  }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

function handleJsonRpc(msg) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "This server is the user's terminal. Always use reply_to_terminal to send your responses.",
        },
      };

    case "notifications/initialized":
    case "notifications/cancelled":
    case "initialized":
      return isNotification ? null : { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call":
      try {
        const result = handleToolCall(params?.name, params?.arguments || params?.input || {});
        return { jsonrpc: "2.0", id, result };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: err.message },
        };
      }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      if (isNotification) return null;
      if (!method) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function stripTunnelPrefix(pathname) {
  const raw = decodeURIComponent(pathname || "/") || "/";
  return raw.replace(
    /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/i,
    ""
  ) || "/";
}

function isMcpPath(pathname) {
  const p = stripTunnelPrefix(pathname).replace(/\/+$/, "") || "/";
  return (
    p === "/mcp" ||
    p === "/sse" ||
    p === "/message" ||
    p === "/messages" ||
    p === "/" ||
    p.endsWith("/mcp") ||
    p.endsWith("/sse")
  );
}

function writeSseHeaders(res, sessionId) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Mcp-Session-Id": sessionId,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  });
}

export function createMcpServer() {}

export function startMcpHttpServer(port = 0) {
  return new Promise((resolve, reject) => {
    const sessionId = randomUUID();

    const httpServer = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Mcp-Session-Id, Accept, Last-Event-ID"
      );
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      res.setHeader("Mcp-Session-Id", sessionId);

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, "http://127.0.0.1");
      const logicalPath = stripTunnelPrefix(url.pathname);
      logLine(`${req.method} ${url.pathname} logical=${logicalPath}${url.search} accept=${req.headers.accept || ""}`);

      if (logicalPath === "/health" || url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", sessionId }));
        return;
      }

      if (logicalPath.startsWith("/.well-known/oauth-protected-resource") ||
          url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          resource: "http://127.0.0.1/mcp",
          authorization_servers: [],
          scopes_supported: [],
          bearer_methods_supported: ["header"],
        }));
        return;
      }

      if (req.method === "DELETE" && isMcpPath(url.pathname)) {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === "GET" && isMcpPath(url.pathname)) {
        writeSseHeaders(res, sessionId);
        if (logicalPath === "/sse" || logicalPath === "/") {
          res.write(`event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`);
        }
        res.write(`: poke-tui mcp ready\n\n`);
        const keepAlive = setInterval(() => {
          try { res.write(`: keepalive\n\n`); } catch {}
        }, 15000);
        req.on("close", () => clearInterval(keepAlive));
        return;
      }

      if (req.method === "POST" && isMcpPath(url.pathname)) {
        try {
          const body = await readBody(req);
          logLine(`body ${body.slice(0, 500)}`);
          const parsed = body ? JSON.parse(body) : {};
          const messages = Array.isArray(parsed) ? parsed : [parsed];
          const hasRequest = messages.some((m) => m && m.id !== undefined && m.id !== null && m.method);
          const results = messages.map(handleJsonRpc).filter(Boolean);

          if (!hasRequest) {
            res.writeHead(202);
            res.end();
            return;
          }

          const payload = Array.isArray(parsed) ? results : results[0] ?? { jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" }, id: null };
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": sessionId,
          });
          res.end(JSON.stringify(payload));
        } catch (err) {
          logLine(`error ${err.message}`);
          mcpEvents.emit("error", `MCP request error: ${err.message}`);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
        }
        return;
      }

      logLine(`404 ${req.method} ${url.pathname}`);
      if (req.method === "POST") {
        try {
          const body = await readBody(req);
          logLine(`404-body ${body.slice(0, 500)}`);
          const parsed = body ? JSON.parse(body) : null;
          if (parsed && (parsed.method || Array.isArray(parsed))) {
            const messages = Array.isArray(parsed) ? parsed : [parsed];
            const hasRequest = messages.some((m) => m && m.id !== undefined && m.id !== null && m.method);
            const results = messages.map(handleJsonRpc).filter(Boolean);
            if (!hasRequest) {
              res.writeHead(202);
              res.end();
              return;
            }
            const payload = Array.isArray(parsed) ? results : results[0];
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Mcp-Session-Id": sessionId,
            });
            res.end(JSON.stringify(payload));
            return;
          }
        } catch (err) {
          logLine(`404-post-error ${err.message}`);
        }
      }
      res.writeHead(404);
      res.end("Not found");
    });

    httpServer.on("error", reject);

    // IPv4 only. poke-client advertises 127.0.0.1 so the tunnel does not hit ::1.
    httpServer.listen(port, "127.0.0.1", () => {
      const addr = httpServer.address();
      logLine(`listening 127.0.0.1:${addr.port}`);
      resolve({ httpServer, port: addr.port });
    });
  });
}
