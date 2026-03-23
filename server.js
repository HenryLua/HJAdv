const express = require("express");
const cors = require("cors");
const path = require("path");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3001;
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";

app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(express.static(__dirname));

// ═══ GEMINI — proxy seguro ═══
app.post("/api/ia", async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY não configurada." });
  const { system, messages, max_tokens = 2000 } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "Requisição inválida." });

  // Converte formato Anthropic → Gemini
  const contents = messages.map(m => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.content }]
  }));

  // Injeta o system prompt como primeira mensagem user/model
  if (system) {
    contents.unshift(
      { role: "user", parts: [{ text: system }] },
      { role: "model", parts: [{ text: "Entendido. Estou pronto para ajudar." }] }
    );
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: { maxOutputTokens: max_tokens, temperature: 0.7 }
        })
      }
    );
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ WHATSAPP BOT via Baileys ═══
let waBaileys = null;
let waStatus = "desconectado";
let waQR = null;

app.get("/api/whatsapp/status", (_req, res) => {
  res.json({ status: waStatus, qr: waQR });
});

app.post("/api/whatsapp/iniciar", async (_req, res) => {
  if (waStatus === "conectado") return res.json({ ok: true, msg: "Já conectado." });
  try {
    await iniciarWhatsApp();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/whatsapp/parar", (_req, res) => {
  if (waBaileys) { try { waBaileys.end(); } catch(e){} waBaileys=null; }
  waStatus = "desconectado"; waQR = null;
  io.emit("wa_status", { status: waStatus, qr: null });
  res.json({ ok: true });
});

async function iniciarWhatsApp() {
  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import("@whiskeysockets/baileys");
    const { state, saveCreds } = await useMultiFileAuthState("wa_auth");

    waBaileys = makeWASocket({ auth: state, printQRInTerminal: false });
    waStatus = "aguardando_qr";

    waBaileys.ev.on("creds.update", saveCreds);

    waBaileys.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        waQR = qr;
        waStatus = "aguardando_qr";
        io.emit("wa_status", { status: waStatus, qr });
      }
      if (connection === "open") {
        waStatus = "conectado"; waQR = null;
        io.emit("wa_status", { status: "conectado", qr: null });
        console.log("WhatsApp conectado.");
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        waStatus = "desconectado"; waQR = null;
        io.emit("wa_status", { status: "desconectado", qr: null });
        if (code !== DisconnectReason.loggedOut) setTimeout(iniciarWhatsApp, 5000);
      }
    });

    waBaileys.ev.on("messages.upsert", async ({ messages: msgs }) => {
      for (const msg of msgs) {
        if (!msg.message || msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
        if (!text.trim()) continue;

        // Responde apenas mensagens que começam com /juridico ou /adv
        const trigger = text.toLowerCase();
        if (!trigger.startsWith("/juridico") && !trigger.startsWith("/adv") && !trigger.startsWith("oi hjadv") && !trigger.startsWith("olá hjadv")) continue;

        const consulta = text.replace(/^\/(juridico|adv)\s*/i, "").replace(/^(oi|olá) hjadv\s*/i, "").trim();
        if (!consulta) {
          await waBaileys.sendMessage(from, { text: "Olá! Sou o assistente jurídico do HJ ADV.\n\nEnvie sua consulta assim:\n*/juridico [sua dúvida]*\n\nExemplo:\n*/juridico Qual o prazo para contestar em ação cível?*" });
          continue;
        }

        await waBaileys.sendMessage(from, { text: "⚙️ Consultando base jurídica..." });

        try {
          const resp = await fetch(`http://localhost:${PORT}/api/ia`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              system: "Você é assistente jurídico especializado em direito brasileiro. Responda de forma objetiva e cite o artigo de lei quando relevante. Mantenha a resposta curta para WhatsApp (máximo 3 parágrafos).",
              messages: [{ role: "user", content: consulta }]
            })
          });
          const { text: answer } = await resp.json();
          await waBaileys.sendMessage(from, { text: `⚖️ *HJ ADV — Consultoria Jurídica*\n\n${answer}\n\n_Para mais detalhes, acesse o sistema completo._` });
        } catch (e) {
          await waBaileys.sendMessage(from, { text: "❌ Erro ao consultar. Tente novamente em instantes." });
        }
      }
    });
  } catch (e) {
    console.error("Erro ao iniciar WhatsApp:", e.message);
    waStatus = "erro";
    io.emit("wa_status", { status: "erro", qr: null });
  }
}

// ═══ FRONTEND ═══
app.get("*", (_req, res) => {
  res.sendFile("index.html", { root: __dirname });
});

httpServer.listen(PORT, () => {
  console.log(`✅ HJ ADV rodando na porta ${PORT}`);
  if (!GEMINI_KEY) console.warn("⚠️  GEMINI_API_KEY não definida — IA desativada.");
});
