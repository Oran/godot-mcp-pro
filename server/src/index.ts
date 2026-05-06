import net from "node:net";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { GodotBridge, type GodotRpcError } from "./bridge.js";
import { loadToolCatalog, type ToolDefinition, type ToolMode } from "./catalog.js";

const DEFAULT_HOST = process.env.GODOT_MCP_HOST ?? "127.0.0.1";
const DEFAULT_PORT = 6505;
const MAX_FALLBACK_PORT = 6509;
const DEFAULT_TIMEOUT_MS = parseNumber(process.env.GODOT_MCP_REQUEST_TIMEOUT_MS, 180_000);

type JsonRecord = Record<string, unknown>;

interface ParsedArgs {
  help: boolean;
  mode: ToolMode;
  host: string;
  port?: number;
  timeoutMs: number;
  repoRoot?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(helpText());
    return;
  }

  const catalog = loadToolCatalog({ mode: args.mode, repoRoot: args.repoRoot });
  const port = await resolvePort(args.host, args.port);
  const bridge = new GodotBridge({
    host: args.host,
    port,
    timeoutMs: args.timeoutMs,
    logger: (message) => {
      console.error(`[godot-mcp] ${message}`);
    },
  });

  await bridge.start();

  const server = new McpServer(
    {
      name: "godot-mcp-pro",
      version: catalog.pluginVersion,
    },
    {
      capabilities: { logging: {} },
      instructions: buildInstructions(catalog.mode, catalog.tools.length, bridge.address),
    },
  );

  for (const tool of catalog.tools) {
    registerTool(server, bridge, tool);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[godot-mcp] MCP bridge ready. Mode=${catalog.mode}, tools=${catalog.tools.length}, websocket=${bridge.address}`,
  );
  console.error("[godot-mcp] Open the project in Godot and enable the godot_mcp plugin if it is not already connected.");

  const shutdown = async (): Promise<void> => {
    await Promise.allSettled([server.close(), bridge.close()]);
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

function registerTool(server: McpServer, bridge: GodotBridge, tool: ToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        title: tool.title,
        readOnlyHint: isReadOnlyTool(tool.name),
        destructiveHint: isDestructiveTool(tool.name),
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const response = await bridge.request(tool.name, toRecord(args));

        if (response.error) {
          return formatToolError(tool.name, response.error);
        }

        return formatToolResult(response.result ?? {});
      } catch (error) {
        return formatRuntimeError(tool.name, error);
      }
    },
  );
}

function buildInstructions(mode: ToolMode, toolCount: number, address: string): string {
  return [
    `This MCP server forwards tool calls to the local Godot editor plugin over ${address}.`,
    "Open the Godot project with the godot_mcp addon enabled before calling tools.",
    `The active tool mode is '${mode}' with ${toolCount} tools registered from the local plugin source.`,
    "Input schemas are inferred from the GDScript command files and intentionally allow extra keys, so plugin-supported parameters not listed in the schema are still passed through.",
  ].join(" ");
}

function formatToolResult(result: JsonRecord) {
  const images: Array<{ data: string; mimeType: string }> = [];
  const structuredContent = sanitizeResult(result, images) as JsonRecord;
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
    {
      type: "text",
      text: JSON.stringify(structuredContent, null, 2),
    },
  ];

  for (const image of images) {
    content.push({
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
    });
  }

  return {
    content,
    structuredContent,
  };
}

function formatToolError(toolName: string, error: GodotRpcError) {
  const structuredContent: JsonRecord = {
    tool: toolName,
    code: error.code,
    message: error.message,
  };

  if (error.data !== undefined) {
    structuredContent.data = error.data;
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
    isError: true,
  };
}

function formatRuntimeError(toolName: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const structuredContent = {
    tool: toolName,
    message,
  };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
    isError: true,
  };
}

function sanitizeResult(value: unknown, images: Array<{ data: string; mimeType: string }>, key?: string): unknown {
  if (Array.isArray(value)) {
    if (key === "frames" && value.every((item) => typeof item === "string" && looksLikeBase64(item))) {
      for (const frame of value) {
        images.push({ data: frame, mimeType: "image/png" });
      }

      return {
        frame_count: value.length,
        frames_omitted: true,
      };
    }

    return value.map((item) => sanitizeResult(item, images));
  }

  if (value && typeof value === "object") {
    const output: JsonRecord = {};

    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (typeof entryValue === "string" && entryKey.endsWith("_base64") && looksLikeBase64(entryValue)) {
        if (entryKey.includes("image") || entryKey.includes("diff")) {
          images.push({ data: entryValue, mimeType: "image/png" });
          output[entryKey] = "[image data omitted from structuredContent]";
          continue;
        }
      }

      output[entryKey] = sanitizeResult(entryValue, images, entryKey);
    }

    return output;
  }

  return value;
}

function looksLikeBase64(value: string): boolean {
  return value.length > 64 && /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

function toRecord(value: unknown): JsonRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord;
  }

  return {};
}

function isReadOnlyTool(name: string): boolean {
  return (
    name.startsWith("get_") ||
    name.startsWith("list_") ||
    name.startsWith("read_") ||
    name.startsWith("search_") ||
    name.startsWith("find_") ||
    name.startsWith("analyze_") ||
    name.startsWith("detect_") ||
    name.startsWith("compare_") ||
    name.startsWith("uid_to_") ||
    name.startsWith("project_path_to_") ||
    name.startsWith("wait_for_") ||
    name.startsWith("monitor_") ||
    name.startsWith("capture_") ||
    name === "validate_script" ||
    name === "watch_signals"
  );
}

function isDestructiveTool(name: string): boolean {
  return (
    name.startsWith("delete_") ||
    name.startsWith("remove_") ||
    name.startsWith("clear_") ||
    name.startsWith("execute_") ||
    name === "export_project" ||
    name === "deploy_to_android"
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  let help = false;
  let mode: ToolMode = "full";
  let host = DEFAULT_HOST;
  let port = parseOptionalNumber(process.env.GODOT_MCP_PORT);
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let repoRoot: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--lite") {
      mode = "lite";
      continue;
    }

    if (arg === "--minimal") {
      mode = "minimal";
      continue;
    }

    if (arg === "--3d") {
      mode = "3d";
      continue;
    }

    if (arg === "--full") {
      mode = "full";
      continue;
    }

    if (arg === "--host") {
      host = requireValue(argv, ++index, "--host");
      continue;
    }

    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }

    if (arg === "--port") {
      port = parseNumber(requireValue(argv, ++index, "--port"));
      continue;
    }

    if (arg.startsWith("--port=")) {
      port = parseNumber(arg.slice("--port=".length));
      continue;
    }

    if (arg === "--timeout-ms") {
      timeoutMs = parseNumber(requireValue(argv, ++index, "--timeout-ms"));
      continue;
    }

    if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = parseNumber(arg.slice("--timeout-ms=".length));
      continue;
    }

    if (arg === "--repo-root") {
      repoRoot = requireValue(argv, ++index, "--repo-root");
      continue;
    }

    if (arg.startsWith("--repo-root=")) {
      repoRoot = arg.slice("--repo-root=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    help,
    mode,
    host,
    port,
    timeoutMs,
    repoRoot,
  };
}

function helpText(): string {
  return [
    "godot-mcp-pro server",
    "",
    "Usage:",
    "  node build/index.js [--full|--lite|--minimal|--3d] [options]",
    "",
    "Options:",
    "  --host <host>         WebSocket bind host (default: 127.0.0.1)",
    "  --port <port>         Fixed WebSocket port. Defaults to 6505, then falls back to 6506-6509 if free.",
    "  --timeout-ms <ms>     Tool call timeout in milliseconds (default: 180000)",
    "  --repo-root <path>    Repo root containing addons/godot_mcp",
    "  --help                Show this help text",
  ].join("\n");
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

async function resolvePort(host: string, requestedPort?: number): Promise<number> {
  if (requestedPort !== undefined) {
    const available = await canListen(host, requestedPort);
    if (!available) {
      throw new Error(`Port ${requestedPort} is already in use on ${host}.`);
    }

    return requestedPort;
  }

  for (let port = DEFAULT_PORT; port <= MAX_FALLBACK_PORT; port += 1) {
    if (await canListen(host, port)) {
      return port;
    }
  }

  throw new Error(`No free port available in ${DEFAULT_PORT}-${MAX_FALLBACK_PORT}.`);
}

async function canListen(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      server.close();

      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }

      reject(error);
    });

    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

function parseNumber(value: string | undefined, fallback?: number): number {
  if (value === undefined || value === "") {
    if (fallback !== undefined) {
      return fallback;
    }

    throw new Error("Expected a numeric value.");
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value: ${value}`);
  }

  return parsed;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  return parseNumber(value);
}

main().catch((error) => {
  console.error(`[godot-mcp] Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
