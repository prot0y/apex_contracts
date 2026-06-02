# Apex Contracts — Self-Hosted Setup Guide

## Prerequisites
- Docker + Docker Compose installed on your home server
- Ollama running on 13.0.2.47 with the following models pulled:
  ```
  ollama pull qwen3.5:9b
  ollama pull nomic-embed-text
  ```
- Port 3000 open on your server (for Cosmos Cloud to proxy)

## AI provider (local by default, cloud optional)
The AI agent is provider-configurable via env vars in `docker-compose.yml`:
- `AI_PROVIDER=ollama` (default) — fully local/private. Uses `OLLAMA_MODEL=qwen3.5:9b`
  with **schema-enforced structured output** so the model reliably emits executable
  commands. `OLLAMA_NUM_CTX=8192` keeps the KV cache within the Tesla P4's 8 GB.
- `AI_PROVIDER=anthropic` — set `ANTHROPIC_API_KEY` (model `claude-haiku-4-5`).
- `AI_PROVIDER=openai` — set `OPENAI_API_KEY` (model `gpt-5.4-mini`).

The agent can create/update/delete contracts, expenses (materials & labor), change
orders, retainage, employees, and **invoices** — just ask it in plain English.

---

## Directory Structure
```
apex-contracts/
├── docker-compose.yml
├── README.md
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js       ← Express API
│   ├── db.js           ← SQLite schema + queries
│   ├── ai.js           ← Ollama chat + RAG prompting
│   └── rag.js          ← PDF ingestion + ChromaDB retrieval
└── frontend/
    └── index.html      ← Full React UI (served by Express)
```

---

## First-Time Setup

### 1. Create data directories
```bash
sudo mkdir -p /opt/apex-contracts/data
sudo mkdir -p /opt/apex-contracts/chroma
sudo chown -R $USER:$USER /opt/apex-contracts
```

### 2. Clone / copy files to your server
```bash
# Copy the apex-contracts folder to your server, then:
cd apex-contracts
```

### 3. Start the stack
```bash
docker compose up -d --build
```

This starts:
- **apex-chromadb** on port 8000 (internal, not exposed publicly)
- **apex-contracts** on port 3000

### 4. Check logs
```bash
docker compose logs -f apex-contracts
```

You should see:
```
🏗  Apex Contracts running on http://localhost:3000
✓ Embed model ready: nomic-embed-text
✓ Chat model ready: qwen2.5:7b
```

### 5. Open the app
Navigate to `http://<your-server-ip>:3000`

---

## Cosmos Cloud Setup
In Cosmos Cloud, add a new container proxy pointing to port 3000.
Set the hostname/route you want (e.g. `contracts.local` or similar).
No special headers needed — it's a standard HTTP app.

---

## Changing Ollama IP or Model
Edit `docker-compose.yml` environment section:
```yaml
- OLLAMA_HOST=http://YOUR_IP:11434
- OLLAMA_MODEL=qwen2.5:7b
- EMBED_MODEL=nomic-embed-text
```
Then restart:
```bash
docker compose down && docker compose up -d
```

---

## Backup
Your data lives in two places:

| What | Location | How to backup |
|---|---|---|
| Contracts, employees, costs | `/opt/apex-contracts/data/apex.db` | Copy the file — it's a single SQLite DB |
| PDF embeddings | `/opt/apex-contracts/chroma/` | Copy the folder |
| Uploaded PDFs | `/opt/apex-contracts/data/uploads/` | Copy the folder |

Simple cron backup example:
```bash
# Add to crontab: runs daily at 2am
0 2 * * * tar -czf /backup/apex-$(date +\%Y\%m\%d).tar.gz /opt/apex-contracts/data /opt/apex-contracts/chroma
```

---

## RAG — How Document Search Works

1. Open any project → click the **Documents** tab
2. Upload a PDF (contract, invoice, inspection report, etc.)
3. The backend:
   - Extracts text with `pdf-parse`
   - Splits into 512-word chunks with 64-word overlap
   - Embeds each chunk via `nomic-embed-text` on your Ollama VM
   - Stores vectors in ChromaDB tagged to the project
4. Every AI chat message automatically searches all indexed docs
5. Relevant chunks are injected into the prompt — the AI cites the document in its answer
6. A blue indicator appears in the chat when document context was used

**Note:** PDFs must contain selectable text. Scanned/image PDFs are not yet supported (OCR support planned).

---

## Updating the App
```bash
cd apex-contracts
git pull  # or copy new files
docker compose up -d --build
```
Your data is in the mounted volume — it is never touched by rebuilds.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| AI not responding | Check `OLLAMA_HOST` in docker-compose.yml. Verify Ollama is running on 13.0.2.47 |
| RAG not finding docs | Verify `nomic-embed-text` is pulled: `ollama list` on the Ollama VM |
| ChromaDB errors | Check `docker compose logs apex-chromadb` |
| PDF upload fails | Check file is text-based (not scanned). Max size is 50MB |
| Port 3000 conflict | Change `"3000:3000"` to `"YOUR_PORT:3000"` in docker-compose.yml |
