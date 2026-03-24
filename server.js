const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { createServer } = require("http");
const { Server } = require("socket.io");

// ─── VOLUME PERSISTENTE ───
// O Railway usa /app como mount point do volume
// Garante que o diretório existe
const DATA_DIR = process.env.DATA_DIR || "/app/data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const Database = require("better-sqlite3");
const db = new Database(path.join(DATA_DIR, "hjadv.db"));

// Schema principal
db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    id TEXT PRIMARY KEY,
    nome TEXT,
    email TEXT UNIQUE,
    codigo TEXT UNIQUE,
    senha_hash TEXT,
    ativo INTEGER DEFAULT 1,
    validade TEXT,
    criado_em TEXT DEFAULT (datetime('now')),
    ultimo_acesso TEXT
  );
  CREATE TABLE IF NOT EXISTS dados_cliente (
    cliente_id TEXT PRIMARY KEY,
    dados TEXT DEFAULT '{}',
    FOREIGN KEY(cliente_id) REFERENCES clientes(id)
  );
  CREATE TABLE IF NOT EXISTS wa_sessions (
    cliente_id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'desconectado',
    qr TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── CONFIG ───
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@hjadv.com.br";
const ADMIN_SENHA = process.env.ADMIN_SENHA || "HJAdv@Master2025";
const PORT = process.env.PORT || 3001;
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(express.static(__dirname));

// ─── UTILS ───
function hashSenha(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function gerarCodigo() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "HJADV-";
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  c += "-";
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ─── AUTH ───
function authCliente(req, res, next) {
  const { cliente_id, token, admin_email, admin_senha } = req.headers;
  // Modo master — dono do sistema
  if (cliente_id === "master" && token === "master") {
    const emailOk = (admin_email || "").trim().toLowerCase() === ADMIN_EMAIL.trim().toLowerCase();
    const senhaOk = (admin_senha || "").trim() === ADMIN_SENHA.trim();
    if (!emailOk || !senhaOk) {
      console.warn("Master auth falhou - email:", admin_email, "senhaOk:", senhaOk);
      return res.status(401).json({ error: "Acesso negado." });
    }
    req.cliente = { id: "master", nome: "Administrador", ativo: 1, validade: null };
    return next();
  }
  if (!cliente_id || !token) return res.status(401).json({ error: "Não autenticado." });
  const cli = db.prepare("SELECT * FROM clientes WHERE id=?").get(cliente_id);
  if (!cli || !cli.ativo) return res.status(401).json({ error: "Acesso negado." });
  if (hashSenha(cliente_id + cli.senha_hash) !== token) return res.status(401).json({ error: "Token inválido." });
  if (cli.validade && new Date(cli.validade) < new Date()) {
    return res.status(403).json({ error: "Licença vencida. Entre em contato para renovar.", vencida: true });
  }
  req.cliente = cli;
  next();
}
function authAdmin(req, res, next) {
  const { admin_email, admin_senha } = req.headers;
  const emailOk = (admin_email || "").trim().toLowerCase() === ADMIN_EMAIL.trim().toLowerCase();
  const senhaOk = (admin_senha || "").trim() === ADMIN_SENHA.trim();
  if (!emailOk || !senhaOk) {
    return res.status(401).json({ error: "Acesso admin negado." });
  }
  next();
}

// ═══════════════════════════════════════
// ROTAS PÚBLICAS
// ═══════════════════════════════════════
app.post("/api/auth/verificar-codigo", (req, res) => {
  const { codigo } = req.body;
  if (!codigo) return res.status(400).json({ error: "Código obrigatório." });
  const cli = db.prepare("SELECT id,nome,email,senha_hash,ativo,validade FROM clientes WHERE codigo=?").get(codigo.toUpperCase().trim());
  if (!cli) return res.status(404).json({ error: "Código inválido ou não encontrado." });
  if (!cli.ativo) return res.status(403).json({ error: "Licença inativa. Entre em contato." });
  if (cli.validade && new Date(cli.validade) < new Date()) return res.status(403).json({ error: "Licença vencida.", vencida: true });
  res.json({ ok: true, tem_senha: !!cli.senha_hash, nome: cli.nome, email: cli.email });
});

app.post("/api/auth/criar-senha", (req, res) => {
  const { codigo, senha } = req.body;
  if (!codigo || !senha || senha.length < 6) return res.status(400).json({ error: "Código e senha (mín. 6 chars) obrigatórios." });
  const cli = db.prepare("SELECT * FROM clientes WHERE codigo=?").get(codigo.toUpperCase().trim());
  if (!cli) return res.status(404).json({ error: "Código inválido." });
  if (cli.senha_hash) return res.status(400).json({ error: "Senha já criada. Use o login normal." });
  db.prepare("UPDATE clientes SET senha_hash=? WHERE id=?").run(hashSenha(senha), cli.id);
  res.json({ ok: true });
});

app.post("/api/auth/login", (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: "E-mail e senha obrigatórios." });
  const cli = db.prepare("SELECT * FROM clientes WHERE email=?").get(email.toLowerCase().trim());
  if (!cli || !cli.senha_hash) return res.status(401).json({ error: "E-mail ou senha incorretos." });
  if (hashSenha(senha) !== cli.senha_hash) return res.status(401).json({ error: "E-mail ou senha incorretos." });
  if (!cli.ativo) return res.status(403).json({ error: "Licença inativa." });
  if (cli.validade && new Date(cli.validade) < new Date()) return res.status(403).json({ error: "Licença vencida.", vencida: true });
  db.prepare("UPDATE clientes SET ultimo_acesso=datetime('now') WHERE id=?").run(cli.id);
  const token = hashSenha(cli.id + cli.senha_hash);
  res.json({ ok: true, cliente_id: cli.id, token, nome: cli.nome, email: cli.email, validade: cli.validade });
});

// ═══════════════════════════════════════
// ROTAS AUTENTICADAS (cliente)
// ═══════════════════════════════════════
app.get("/api/dados", authCliente, (req, res) => {
  let row = db.prepare("SELECT dados FROM dados_cliente WHERE cliente_id=?").get(req.cliente.id);
  if (!row) {
    db.prepare("INSERT INTO dados_cliente(cliente_id,dados) VALUES(?,?)").run(req.cliente.id, "{}");
    row = { dados: "{}" };
  }
  res.json({ ok: true, dados: JSON.parse(row.dados) });
});

app.post("/api/dados", authCliente, (req, res) => {
  const { dados } = req.body;
  if (!dados) return res.status(400).json({ error: "Dados obrigatórios." });
  db.prepare("INSERT OR REPLACE INTO dados_cliente(cliente_id,dados) VALUES(?,?)").run(req.cliente.id, JSON.stringify(dados));
  res.json({ ok: true });
});

app.post("/api/auth/trocar-senha", authCliente, (req, res) => {
  const { senha_atual, nova_senha } = req.body;
  if (!senha_atual || !nova_senha || nova_senha.length < 6) return res.status(400).json({ error: "Senhas inválidas." });
  if (hashSenha(senha_atual) !== req.cliente.senha_hash) return res.status(401).json({ error: "Senha atual incorreta." });
  db.prepare("UPDATE clientes SET senha_hash=? WHERE id=?").run(hashSenha(nova_senha), req.cliente.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
// IA — GEMINI + GROQ FALLBACK
// ═══════════════════════════════════════
const GROQ_KEY = process.env.GROQ_API_KEY || "";

async function chamarGemini(system, messages, max_tokens) {
  const contents = messages.map(m => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.content }] }));
  if (system) contents.unshift({ role: "user", parts: [{ text: system }] }, { role: "model", parts: [{ text: "Entendido." }] });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: max_tokens, temperature: 0.7 } })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function chamarGroq(system, messages, max_tokens) {
  const msgs = [];
  if (system) msgs.push({ role: "system", content: system });
  messages.forEach(m => msgs.push({ role: m.role, content: m.content }));
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: msgs, max_tokens, temperature: 0.7 })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.choices?.[0]?.message?.content || "";
}

app.post("/api/ia", authCliente, async (req, res) => {
  const { system, messages, max_tokens = 2000 } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "Requisição inválida." });
  if (!GEMINI_KEY && !GROQ_KEY) return res.status(500).json({ error: "IA não configurada no servidor." });

  // Tentar Gemini primeiro
  if (GEMINI_KEY) {
    try {
      const text = await chamarGemini(system, messages, max_tokens);
      return res.json({ text, provider: "gemini" });
    } catch (e) {
      console.warn("Gemini falhou, tentando Groq:", e.message);
      // Se não tem Groq, retorna o erro do Gemini
      if (!GROQ_KEY) return res.status(500).json({ error: e.message });
    }
  }

  // Fallback para Groq
  try {
    const text = await chamarGroq(system, messages, max_tokens);
    return res.json({ text, provider: "groq" });
  } catch (e) {
    return res.status(500).json({ error: "Ambas as IAs falharam: " + e.message });
  }
});

// ═══════════════════════════════════════
// WHATSAPP BOT (por cliente)
// ═══════════════════════════════════════
const waSessions = {}; // { cliente_id: { sock, status, qr } }

async function iniciarWA(cliente_id) {
  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import("@whiskeysockets/baileys");
    const authDir = path.join(DATA_DIR, "wa_auth", cliente_id);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });
    waSessions[cliente_id] = { sock, status: "aguardando_qr", qr: null };

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        waSessions[cliente_id].qr = qr;
        waSessions[cliente_id].status = "aguardando_qr";
        db.prepare("INSERT OR REPLACE INTO wa_sessions(cliente_id,status,qr,updated_at) VALUES(?,?,?,datetime('now'))").run(cliente_id, "aguardando_qr", qr);
        io.to(`wa_${cliente_id}`).emit("wa_status", { status: "aguardando_qr", qr });
      }
      if (connection === "open") {
        waSessions[cliente_id].status = "conectado";
        waSessions[cliente_id].qr = null;
        db.prepare("UPDATE wa_sessions SET status='conectado',qr=NULL,updated_at=datetime('now') WHERE cliente_id=?").run(cliente_id);
        io.to(`wa_${cliente_id}`).emit("wa_status", { status: "conectado", qr: null });
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        waSessions[cliente_id].status = "desconectado";
        db.prepare("UPDATE wa_sessions SET status='desconectado',updated_at=datetime('now') WHERE cliente_id=?").run(cliente_id);
        io.to(`wa_${cliente_id}`).emit("wa_status", { status: "desconectado", qr: null });
        if (code !== DisconnectReason.loggedOut) setTimeout(() => iniciarWA(cliente_id), 5000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages: msgs }) => {
      for (const msg of msgs) {
        if (!msg.message || msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
        if (!text.trim()) continue;
        const trigger = text.toLowerCase();
        if (!trigger.startsWith("/juridico") && !trigger.startsWith("/adv") && !trigger.startsWith("oi hjadv") && !trigger.startsWith("olá hjadv")) continue;
        const consulta = text.replace(/^\/(juridico|adv)\s*/i, "").replace(/^(oi|olá) hjadv\s*/i, "").trim();
        if (!consulta) {
          await sock.sendMessage(from, { text: "⚖️ *HJ ADV — Assistente Jurídico*\n\nOlá! Sou o assistente jurídico do escritório.\n\nEnvie sua consulta:\n• /juridico [sua dúvida]\n• /adv [sua dúvida]\n\nExemplo: _/juridico meu vizinho invadiu minha propriedade, o que fazer?_" });
          continue;
        }
        await sock.sendMessage(from, { text: "⚙️ Consultando base jurídica..." });
        try {
          const r = await fetch(`http://localhost:${PORT}/api/ia`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "cliente_id": cliente_id, "token": waSessions[cliente_id]?.token || "" },
            body: JSON.stringify({ system: "Você é assistente jurídico especializado em direito brasileiro. Responda de forma objetiva, clara e profissional. Oriente sobre direitos e próximos passos. Sempre indique que para casos específicos é necessário consultar um advogado.", messages: [{ role: "user", content: consulta }] })
          });
          const d = await r.json();
          await sock.sendMessage(from, { text: `⚖️ *HJ ADV — Consultoria Jurídica*\n\n${d.text || "Não foi possível processar."}\n\n_Para atendimento personalizado, entre em contato com o escritório._` });
        } catch (e) {
          await sock.sendMessage(from, { text: "❌ Erro ao consultar. Tente novamente em instantes." });
        }
      }
    });
  } catch (e) {
    console.error("Erro WA:", e.message);
    if (waSessions[cliente_id]) waSessions[cliente_id].status = "erro";
  }
}

// Socket.io — cliente entra na sala do seu WA
io.on("connection", (socket) => {
  socket.on("wa_join", ({ cliente_id }) => {
    socket.join(`wa_${cliente_id}`);
    const sess = waSessions[cliente_id];
    if (sess) socket.emit("wa_status", { status: sess.status, qr: sess.qr });
    else {
      const row = db.prepare("SELECT status, qr FROM wa_sessions WHERE cliente_id=?").get(cliente_id);
      socket.emit("wa_status", { status: row?.status || "desconectado", qr: row?.qr || null });
    }
  });
});

app.get("/api/whatsapp/status", authCliente, (req, res) => {
  const sess = waSessions[req.cliente.id];
  const row = db.prepare("SELECT status,qr FROM wa_sessions WHERE cliente_id=?").get(req.cliente.id);
  res.json({ status: sess?.status || row?.status || "desconectado", qr: sess?.qr || row?.qr || null });
});

app.post("/api/whatsapp/iniciar", authCliente, async (req, res) => {
  const id = req.cliente.id;
  if (waSessions[id]?.status === "conectado") return res.json({ ok: true, msg: "Já conectado." });
  // Salvar token na sessão WA para uso interno
  if (!waSessions[id]) waSessions[id] = { status: "iniciando", qr: null };
  waSessions[id].token = req.headers.token;
  await iniciarWA(id);
  res.json({ ok: true });
});

app.post("/api/whatsapp/parar", authCliente, async (req, res) => {
  const id = req.cliente.id;
  if (waSessions[id]?.sock) {
    try { waSessions[id].sock.end(); } catch(e){}
    delete waSessions[id];
  }
  db.prepare("UPDATE wa_sessions SET status='desconectado',qr=NULL WHERE cliente_id=?").run(id);
  io.to(`wa_${id}`).emit("wa_status", { status: "desconectado", qr: null });
  res.json({ ok: true });
});

// ═══════════════════════════════════════
// ROTAS ADMIN
// ═══════════════════════════════════════
app.get("/api/admin/clientes", authAdmin, (req, res) => {
  const clientes = db.prepare("SELECT id,nome,email,codigo,ativo,validade,criado_em,ultimo_acesso FROM clientes ORDER BY criado_em DESC").all();
  res.json({ ok: true, clientes });
});

app.post("/api/admin/clientes", authAdmin, (req, res) => {
  const { nome, email, validade } = req.body;
  if (!nome || !email) return res.status(400).json({ error: "Nome e e-mail obrigatórios." });
  const id = uid();
  const codigo = gerarCodigo();
  try {
    db.prepare("INSERT INTO clientes(id,nome,email,codigo,validade) VALUES(?,?,?,?,?)").run(id, nome, email.toLowerCase().trim(), codigo, validade || null);
    res.json({ ok: true, id, codigo, email });
  } catch(e) {
    res.status(400).json({ error: "E-mail já cadastrado." });
  }
});

app.patch("/api/admin/clientes/:id", authAdmin, (req, res) => {
  const { ativo, validade, nome } = req.body;
  const updates = [], values = [];
  if (ativo !== undefined) { updates.push("ativo=?"); values.push(ativo ? 1 : 0); }
  if (validade !== undefined) { updates.push("validade=?"); values.push(validade); }
  if (nome) { updates.push("nome=?"); values.push(nome); }
  if (!updates.length) return res.status(400).json({ error: "Nada para atualizar." });
  values.push(req.params.id);
  db.prepare(`UPDATE clientes SET ${updates.join(",")} WHERE id=?`).run(...values);
  res.json({ ok: true });
});

app.delete("/api/admin/clientes/:id", authAdmin, (req, res) => {
  db.prepare("DELETE FROM dados_cliente WHERE cliente_id=?").run(req.params.id);
  db.prepare("DELETE FROM wa_sessions WHERE cliente_id=?").run(req.params.id);
  db.prepare("DELETE FROM clientes WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/clientes/:id/novo-codigo", authAdmin, (req, res) => {
  const codigo = gerarCodigo();
  db.prepare("UPDATE clientes SET codigo=?,senha_hash=NULL WHERE id=?").run(codigo, req.params.id);
  res.json({ ok: true, codigo });
});

// ─── FRONTEND ───
app.get("*", (_req, res) => res.sendFile("index.html", { root: __dirname }));

httpServer.listen(PORT, () => {
  console.log(`✅ HJ ADV v3 rodando na porta ${PORT}`);
  console.log(`📁 Dados em: ${DATA_DIR}`);
  if (!GEMINI_KEY) console.warn("⚠️  GEMINI_API_KEY não definida.");
});
