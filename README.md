# test-datawrapper-mcp

Try out the [Datawrapper MCP](https://datawrapper-mcp.fly.dev/mcp) through a **self-hosted web chat interface** powered by [OpenRouter](https://openrouter.ai), or directly inside GitHub Codespaces with GitHub Copilot.

![Datawrapper MCP Chat UI](https://github.com/user-attachments/assets/77406407-3849-48d5-aba1-21337ea190c3)

## Option A — Web Interface (recommended for teams)

A lightweight Node.js web server lets **any browser user** chat with an AI that drives the Datawrapper MCP — no VS Code or Copilot subscription required. It supports many simultaneous users and uses [OpenRouter](https://openrouter.ai) to route requests to the model of your choice.

### Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy the environment template and add your OpenRouter key
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY=sk-or-…

# 3. Start the server
npm start
# → Datawrapper MCP Web → http://localhost:3000
```

Open <http://localhost:3000> in your browser. Users can chat with the AI, and it will call Datawrapper tools automatically.

### Configuration

All settings are optional environment variables (see [`.env.example`](.env.example)):

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | _(none)_ | Pre-shared OpenRouter key. If blank, each user must enter their own in the Settings panel. |
| `MODEL` | `anthropic/claude-3.5-sonnet` | Any [OpenRouter model](https://openrouter.ai/models) that supports tool use. |
| `MCP_URL` | `https://datawrapper-mcp.fly.dev/mcp` | Datawrapper MCP server URL. |
| `PORT` | `3000` | Port the web server listens on. |

### Settings panel

Click **Settings** in the top-right corner to configure per-session values without restarting the server:

- **OpenRouter API Key** — individual users can supply their own key (stored only in browser session storage).
- **Datawrapper API Token** — pass your Datawrapper token so the MCP server can authenticate on your behalf.
- **Model** — choose from Claude, GPT-4o, Gemini, Mistral and more.

![Settings panel](https://github.com/user-attachments/assets/2860177b-8874-45c6-9795-23477db169d0)

### Scaling to 50+ users

The server creates one short-lived MCP client connection per chat turn, so it handles dozens of simultaneous users without any extra infrastructure. For production deployments you can:

- Run behind a reverse proxy (nginx, Caddy) for HTTPS and load balancing.
- Deploy to any Node.js host (Railway, Fly.io, Render, etc.) and set `OPENROUTER_API_KEY` as a secret environment variable so users don't need their own key.
- Use [OpenRouter's rate-limit and credit controls](https://openrouter.ai/docs) to cap spend per key.

---

## Option B — GitHub Codespaces + Copilot (VS Code)

1. Click the **Code** button on this repository and select **Open with Codespaces** → **New codespace**.
2. Wait for the codespace to finish building and opening in VS Code.
3. Make sure you are signed in to **GitHub Copilot** (you'll need an active Copilot subscription).
4. Open the **GitHub Copilot Chat** panel and switch to **Agent mode** (the `@` menu or the mode selector).
5. The **datawrapper** MCP server will be available automatically — you can now ask Copilot to create and manage Datawrapper charts on your behalf.

The MCP configuration lives in [`.vscode/mcp.json`](.vscode/mcp.json) and is picked up automatically by VS Code when the codespace starts.

**Requirements:** A [GitHub Copilot](https://github.com/features/copilot) subscription (Individual, Business, or Enterprise).

---

## MCP Server

| Field | Value |
|-------|-------|
| URL   | `https://datawrapper-mcp.fly.dev/mcp` |
| Type  | HTTP (streamable) |

A [Datawrapper](https://www.datawrapper.de/) account and API token may be required for authenticated operations.
