import React, { useState, useEffect, useCallback, useRef } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { EventEmitter } from "node:events";

export const tuiEvents = new EventEmitter();

const h = React.createElement;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const THINKING_WORDS = [
  "Poking around", "Checking my notes", "Asking the palm tree",
  "Surfing the waves", "On it", "Digging in", "Cooking up a reply",
  "Reaching out to the universe", "Looking into it", "Brewing thoughts",
  "Catching a vibe", "Consulting the coconuts", "Adventuring",
  "Figuring it out", "Putting it together", "Almost there",
  "Exploring options", "Connecting the dots", "Reading the vibes",
  "One sec", "Hang tight", "Working on it", "Crunching it",
  "Fetching an answer", "Assembling words", "Crafting a reply",
  "Poking the clouds", "Channeling island energy", "Sipping and thinking",
  "Vibing with it", "Letting it marinate", "Piecing it together",
];

function pickWord() {
  return THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
}

function Banner({ userName }) {
  return h(Box, { flexDirection: "column", paddingX: 1, marginBottom: 1 },
    h(Text, null),
    h(Text, { bold: true, color: "#7B68EE" }, "  🌴 Poke"),
    h(Text, { dimColor: true }, "  your AI assistant in the terminal"),
    h(Text, { dimColor: true }, "  by Interaction Company of California"),
    h(Text, null),
    userName
      ? h(Text, null, `  Welcome back, ${userName}!`)
      : null,
    h(Text, { dimColor: true }, "  Type a message to chat · /help for commands"),
  );
}

function ThinkingIndicator() {
  const [frame, setFrame] = useState(0);
  const [word, setWord] = useState(pickWord);

  useEffect(() => {
    const spin = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    const swap = setInterval(() => setWord(pickWord()), 3000);
    return () => { clearInterval(spin); clearInterval(swap); };
  }, []);

  return h(Box, { paddingX: 1 },
    h(Text, { color: "#7B68EE" }, `${SPINNER[frame]} `),
    h(Text, { dimColor: true }, `${word}…`),
  );
}

function formatStamp(at) {
  try {
    return new Intl.DateTimeFormat("th-TH", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(at));
  } catch {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

function Stamp({ at }) {
  if (!at) return null;
  return h(Text, { dimColor: true }, `  ${formatStamp(at)}`);
}

function renderBlocks(text) {
  const nodes = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let key = 0;
  let match;
  while ((match = re.exec(text))) {
    if (match.index > last) {
      nodes.push(h(Text, { key: `t${key++}` }, text.slice(last, match.index)));
    }
    const lang = match[1] || "code";
    const code = match[2].replace(/\n$/, "");
    nodes.push(
      h(Box, { key: `c${key++}`, flexDirection: "column", paddingLeft: 1 },
        h(Text, { dimColor: true }, lang),
        h(Text, { color: "cyan" }, code),
      )
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    nodes.push(h(Text, { key: `t${key++}` }, text.slice(last)));
  }
  return nodes.length ? nodes : [h(Text, { key: "empty" }, text)];
}

function PokeBody({ text }) {
  const [shown, setShown] = useState("");
  useEffect(() => {
    let i = 0;
    let timer;
    const tick = () => {
      i = Math.min(text.length, i + Math.max(3, Math.ceil(text.length / 45)));
      setShown(text.slice(0, i));
      if (i < text.length) timer = setTimeout(tick, 20);
    };
    tick();
    return () => clearTimeout(timer);
  }, [text]);
  return h(Box, { flexDirection: "column", paddingLeft: 2 }, ...renderBlocks(shown));
}

function Message({ role, text, at }) {
  if (role === "you") {
    return h(Box, { paddingX: 1, marginTop: 1 },
      h(Text, { bold: true }, "❯ "),
      h(Text, null, text),
      h(Stamp, { at }),
    );
  }
  if (role === "poke") {
    return h(Box, { paddingX: 1, flexDirection: "column" },
      h(Box, null,
        h(Text, { color: "#7B68EE", bold: true }, "poke"),
        h(Stamp, { at }),
      ),
      h(PokeBody, { text }),
    );
  }
  if (role === "error") {
    return h(Box, { paddingX: 1 },
      h(Text, { color: "red" }, `✗ ${text}`),
      h(Stamp, { at }),
    );
  }
  return h(Box, { paddingX: 1 },
    h(Text, { dimColor: true }, text),
    h(Stamp, { at }),
  );
}

function App() {
  const { exit } = useApp();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [userName, setUserName] = useState(null);
  const [scroll, setScroll] = useState(0);
  const idRef = useRef(0);
  const lastPokeRef = useRef({ text: "", at: 0 });
  const messagesRef = useRef([]);

  const nextId = useCallback(() => `msg-${++idRef.current}`, []);

  const push = useCallback((role, text) => {
    setMessages((prev) => {
      const next = [...prev.slice(-200), { role, text, id: nextId(), at: Date.now() }];
      messagesRef.current = next;
      return next;
    });
    setScroll(0);
  }, [nextId]);

  useEffect(() => {
    const onMsg = (role, text) => {
      if (role === "poke") {
        const now = Date.now();
        if (text === lastPokeRef.current.text && now - lastPokeRef.current.at < 15000) {
          setThinking(false);
          return;
        }
        lastPokeRef.current = { text, at: now };
      }
      push(role, text);
      if (role === "you") setThinking(true);
      if (role === "poke" || role === "error") setThinking(false);
    };
    const onSys = (text) => push("system", text);
    const onErr = (text) => { push("error", text); setThinking(false); };
    const onConn = (v) => setConnected(v);
    const onThink = (v) => setThinking(v);
    const onQuit = () => exit();
    const onUser = (name) => setUserName(name);
    const onClear = () => {
      messagesRef.current = [];
      setMessages([]);
    };
    const onDump = (kind) => {
      tuiEvents.emit("transcript", { kind, messages: messagesRef.current.slice() });
    };

    tuiEvents.on("message", onMsg);
    tuiEvents.on("system", onSys);
    tuiEvents.on("error", onErr);
    tuiEvents.on("connected", onConn);
    tuiEvents.on("thinking", onThink);
    tuiEvents.on("quit", onQuit);
    tuiEvents.on("user-name", onUser);
    tuiEvents.on("clear", onClear);
    tuiEvents.on("dump-transcript", onDump);

    return () => {
      tuiEvents.off("message", onMsg);
      tuiEvents.off("system", onSys);
      tuiEvents.off("error", onErr);
      tuiEvents.off("connected", onConn);
      tuiEvents.off("thinking", onThink);
      tuiEvents.off("quit", onQuit);
      tuiEvents.off("user-name", onUser);
      tuiEvents.off("clear", onClear);
      tuiEvents.off("dump-transcript", onDump);
    };
  }, [push, exit]);

  useEffect(() => {
    if (!thinking) return undefined;
    const timer = setTimeout(() => {
      setThinking(false);
      push(
        "system",
        "No terminal reply after 45s. Poke may have answered on iMessage. Keep this window open and send again."
      );
    }, 45_000);
    return () => clearTimeout(timer);
  }, [thinking, push]);

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      tuiEvents.emit("user-quit");
      exit();
    }
    if (key.escape && thinking) {
      setThinking(false);
      push("system", "Wait cancelled. Type another message or /status.");
    }
    if (key.pageUp) setScroll((s) => s + 8);
    if (key.pageDown) setScroll((s) => Math.max(0, s - 8));
  });

  const handleSubmit = (value) => {
    if (!value.trim()) return;
    setInput("");
    tuiEvents.emit("user-input", value.trim());
  };

  const windowSize = 50;
  const maxScroll = Math.max(0, messages.length - windowSize);
  const offset = Math.min(scroll, maxScroll);
  const visible = offset
    ? messages.slice(Math.max(0, messages.length - windowSize - offset), messages.length - offset)
    : messages.slice(-windowSize);
  const cols = process.stdout.columns || 80;

  return h(Box, { flexDirection: "column", width: "100%" },

    h(Banner, { userName }),

    h(Box, { flexDirection: "column", flexGrow: 1 },
      ...visible.map((msg) =>
        h(Message, { key: msg.id, role: msg.role, text: msg.text, at: msg.at })
      ),
      thinking && h(ThinkingIndicator, { key: "thinking" }),
    ),

    h(Box, { paddingX: 1 },
      h(Text, { dimColor: true }, "─".repeat(cols - 2)),
    ),
    h(Box, { paddingX: 1 },
      h(Text, { color: "#7B68EE", bold: true }, "❯ "),
      h(TextInput, { value: input, onChange: setInput, onSubmit: handleSubmit, placeholder: "Ask Poke anything…" }),
    ),
    h(Box, { paddingX: 1, justifyContent: "space-between" },
      h(Text, { dimColor: true },
        h(Text, { color: connected ? "green" : "yellow" }, connected ? "● " : "○ "),
        connected ? "connected" : "connecting",
      ),
      h(Text, { dimColor: true }, offset ? `pgup/pgdn · +${offset} older · /help` : "esc · pgup history · /help · ctrl-c"),
    ),
  );
}

export function startTUI() {
  process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
  return render(h(App));
}
