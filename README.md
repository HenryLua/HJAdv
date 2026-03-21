# HJ ADV v2 — Pronto para Venda

## Funcionalidades
- ✅ Gestão completa de processos, prazos, financeiro, jurisprudências
- ✅ IA Jurídica com Gemini (GRATUITO)
- ✅ Degravação e organização de textos com IA
- ✅ Modelos de peças processuais (Cível, Penal, Trabalhista, Família, Trânsito, Administrativo)
- ✅ Videochamada integrada (Jitsi — gratuito, sem instalação)
- ✅ Bot WhatsApp jurídico automático
- ✅ Login por perfil (admin, advogado, estagiário)
- ✅ Dados salvos no navegador (offline para tudo exceto IA)

---

## Deploy no Railway (link único em 10 minutos)

### 1. Subir no GitHub
- Crie conta em github.com
- New repository → nome `hjadv`
- Upload files → sobe TODOS os arquivos desta pasta

### 2. Chave Gemini (GRATUITA, sem cartão)
- Acesse: aistudio.google.com
- Clique em "Get API Key" → "Create API key"
- Copie a chave (começa com `AIza...`)

### 3. Deploy no Railway
- Acesse: railway.app → New Project → Deploy from GitHub
- Selecione o repositório `hjadv`
- Em **Variables**, adicione:
  ```
  GEMINI_API_KEY = AIzaSy...sua-chave-aqui
  ```
- Aguarde 2 minutos
- Railway gera o link: `https://hjadv.up.railway.app`

### 4. Domínio personalizado (opcional, R$ 40/ano)
- Compre em registro.br
- No Railway: Settings → Domains → Add Custom Domain

---

## Custo total

| Item             | Custo         |
|------------------|---------------|
| GitHub           | Gratuito      |
| Railway          | Gratuito*     |
| Gemini API (IA)  | Gratuito**    |
| Jitsi (vídeo)    | Gratuito      |
| Bot WhatsApp     | Gratuito      |
| Domínio          | R$ 40/ano     |

*Railway: $5 crédito/mês, cobre uso leve de 1-3 escritórios
**Gemini: 15 req/min, 1M tokens/dia — suficiente para uso normal

---

## Logins padrão

| Login    | Senha     | Perfil        |
|----------|-----------|---------------|
| admin    | hjadv2025 | Administrador |
| henrique | 1234      | Advogado      |
| ana      | 1234      | Estagiária    |

---

## Bot WhatsApp
Após fazer login no sistema como admin, acesse **Bot WhatsApp** no menu.
Clique em Conectar, escaneie o QR Code com seu celular.

Comandos que o bot responde:
- `/juridico [pergunta]`
- `/adv [pergunta]`
- `Oi HJADV [pergunta]`
