# Godot MCP Server

This package exposes the local `addons/godot_mcp` plugin to AI agents over MCP stdio.

## Architecture

```text
AI Assistant <- stdio/MCP -> Node.js Server <- WebSocket:6505 -> Godot Editor Plugin
```

The server binds to `127.0.0.1:6505` by default. If that port is busy and no fixed port is configured, it falls back to the next free port in `6506-6509`. The Godot plugin already scans that range.

## Install

```bash
cd server
npm install
npm run build
```

## Run

```bash
node build/index.js
```

Useful flags:

```bash
node build/index.js --lite
node build/index.js --minimal
node build/index.js --3d
node build/index.js --port 6505
node build/index.js --repo-root /path/to/repo
```

## MCP Client Config

```json
{
  "mcpServers": {
    "godot-mcp-pro": {
      "command": "node",
      "args": ["/absolute/path/to/server/build/index.js"]
    }
  }
}
```

If you want to force a fixed bridge port:

```json
{
  "mcpServers": {
    "godot-mcp-pro": {
      "command": "node",
      "args": ["/absolute/path/to/server/build/index.js"],
      "env": {
        "GODOT_MCP_PORT": "6505"
      }
    }
  }
}
```

## Notes

- Tool definitions are generated from the GDScript command files in `addons/godot_mcp/commands`.
- Tool descriptions are pulled from the repo `README.md` when available, with source comments used as fallback.
- Input schemas are intentionally permissive: inferred parameters are documented, but extra plugin-supported keys are still passed through.
