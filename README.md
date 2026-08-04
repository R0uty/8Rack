# 8Rack

A lightweight, modular wrapper around [Ollama](https://ollama.com), built as the foundation for a local multi-agent bug bounty platform.

## Structure

```
8Rack/
├── backend/    # Express + TypeScript API server wrapping the Ollama REST API
└── frontend/   # React + TypeScript + Vite UI
```

## Requirements

- Node.js 20+
- [Ollama](https://ollama.com) running locally (`ollama serve`), default at `http://localhost:11434`

## Getting started

First-time setup:

```bash
cd backend && cp .env.example .env && npm install && cd ..
cd frontend && npm install && cd ..
```

Then, either run both dev servers with one command:

```bash
./start.sh
```

or start them separately:

```bash
# Terminal 1 — backend
cd backend
npm run dev   # http://localhost:3001

# Terminal 2 — frontend
cd frontend
npm run dev   # http://localhost:5173
```

The frontend dev server proxies `/api/*` requests to the backend.
