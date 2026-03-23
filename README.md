# test-datawrapper-mcp

Try out the [Datawrapper MCP](https://datawrapper-mcp.fly.dev/mcp) in GitHub Codespaces with GitHub Copilot.

## Getting Started

1. Click the **Code** button on this repository and select **Open with Codespaces** → **New codespace**.
2. Wait for the codespace to finish building and opening in VS Code.
3. Make sure you are signed in to **GitHub Copilot** (you'll need an active Copilot subscription).
4. Open the **GitHub Copilot Chat** panel and switch to **Agent mode** (the `@` menu or the mode selector).
5. The **datawrapper** MCP server will be available automatically — you can now ask Copilot to create and manage Datawrapper charts on your behalf.

## MCP Server

| Field | Value |
|-------|-------|
| URL   | `https://datawrapper-mcp.fly.dev/mcp` |
| Type  | HTTP (streamable) |

The MCP configuration lives in [`.vscode/mcp.json`](.vscode/mcp.json) and is picked up automatically by VS Code when the codespace starts.

## Requirements

- A [GitHub Copilot](https://github.com/features/copilot) subscription (Individual, Business, or Enterprise).
- A [Datawrapper](https://www.datawrapper.de/) account and API token if the MCP server requires authentication.
