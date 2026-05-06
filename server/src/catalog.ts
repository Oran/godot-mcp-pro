import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v3";

const COMMAND_FILE_SUFFIX = "_commands.gd";
const LITE_CATEGORIES = new Set([
  "project",
  "scene",
  "node",
  "script",
  "editor",
  "input",
  "runtime",
  "input_map",
]);
const THREE_D_CATEGORIES = new Set([...LITE_CATEGORIES, "physics", "animation_tree", "navigation"]);
const MINIMAL_TOOLS = new Set([
  "get_project_info",
  "get_filesystem_tree",
  "search_files",
  "search_in_files",
  "get_scene_tree",
  "create_scene",
  "open_scene",
  "play_scene",
  "stop_scene",
  "save_scene",
  "add_node",
  "delete_node",
  "duplicate_node",
  "move_node",
  "rename_node",
  "update_property",
  "get_node_properties",
  "list_scripts",
  "read_script",
  "create_script",
  "edit_script",
  "validate_script",
  "get_editor_errors",
  "get_output_log",
  "get_editor_screenshot",
  "simulate_key",
  "simulate_mouse_click",
  "simulate_mouse_move",
  "simulate_action",
  "simulate_sequence",
  "get_game_scene_tree",
  "get_game_node_properties",
  "get_game_screenshot",
  "find_ui_elements",
  "wait_for_node",
]);

export type ToolMode = "full" | "lite" | "minimal" | "3d";
type ParamKind = "string" | "boolean" | "integer" | "number" | "array" | "object" | "any";

interface ToolParam {
  name: string;
  kind: ParamKind;
  required: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  category: string;
  params: ToolParam[];
  inputSchema: z.ZodObject<z.ZodRawShape>;
}

export interface ToolCatalog {
  repoRoot: string;
  pluginVersion: string;
  mode: ToolMode;
  tools: ToolDefinition[];
}

export interface LoadToolCatalogOptions {
  mode: ToolMode;
  repoRoot?: string;
}

export function loadToolCatalog(options: LoadToolCatalogOptions): ToolCatalog {
  const repoRoot = resolveRepoRoot(options.repoRoot);
  const readmeDescriptions = parseReadmeDescriptions(path.join(repoRoot, "README.md"));
  const commandsDir = path.join(repoRoot, "addons", "godot_mcp", "commands");
  const pluginCfgPath = path.join(repoRoot, "addons", "godot_mcp", "plugin.cfg");

  const tools = fs
    .readdirSync(commandsDir)
    .filter((entry) => entry.endsWith(COMMAND_FILE_SUFFIX))
    .sort()
    .flatMap((entry) => parseCommandFile(path.join(commandsDir, entry), readmeDescriptions));

  return {
    repoRoot,
    pluginVersion: readPluginVersion(pluginCfgPath),
    mode: options.mode,
    tools: filterToolsForMode(tools, options.mode),
  };
}

function resolveRepoRoot(explicitRoot?: string): string {
  const envRoot = process.env.GODOT_MCP_ROOT;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [explicitRoot, envRoot, process.cwd(), moduleDir].filter(
    (value): value is string => Boolean(value),
  );

  for (const candidate of candidates) {
    const resolved = findRepoRoot(candidate);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error(
    "Could not find the Godot MCP repo root. Pass --repo-root or set GODOT_MCP_ROOT to a directory containing addons/godot_mcp/plugin.gd.",
  );
}

function findRepoRoot(start: string): string | undefined {
  let current = path.resolve(start);

  while (true) {
    const pluginPath = path.join(current, "addons", "godot_mcp", "plugin.gd");
    if (fs.existsSync(pluginPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

function readPluginVersion(pluginCfgPath: string): string {
  const content = fs.readFileSync(pluginCfgPath, "utf8");
  const match = content.match(/^version="([^"]+)"$/m);
  return match?.[1] ?? "0.0.0";
}

function parseReadmeDescriptions(readmePath: string): Map<string, string> {
  const descriptions = new Map<string, string>();

  if (!fs.existsSync(readmePath)) {
    return descriptions;
  }

  const content = fs.readFileSync(readmePath, "utf8");
  const toolLinePattern = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/gm;

  for (const match of content.matchAll(toolLinePattern)) {
    const name = match[1];
    const description = match[2];
    if (!name || !description) {
      continue;
    }
    descriptions.set(name, description.trim());
  }

  return descriptions;
}

function parseCommandFile(filePath: string, readmeDescriptions: Map<string, string>): ToolDefinition[] {
  const source = fs.readFileSync(filePath, "utf8");
  const category = path.basename(filePath, COMMAND_FILE_SUFFIX);
  const commandsBlock = extractCommandsBlock(source);
  const commandMappings = [...commandsBlock.matchAll(/"([^"]+)"\s*:\s*(_[A-Za-z0-9_]+)/g)]
    .map((match) => ({
      toolName: match[1],
      handlerName: match[2],
    }))
    .filter((entry): entry is { toolName: string; handlerName: string } => Boolean(entry.toolName && entry.handlerName));

  return commandMappings.map(({ toolName, handlerName }) => {
    const body = extractFunctionBody(source, handlerName);
    const comment = extractFunctionComment(source, handlerName);
    const params = inferParameters(body);

    return {
      name: toolName,
      title: humanizeToolName(toolName),
      description:
        readmeDescriptions.get(toolName) ??
        comment ??
        `${humanizeToolName(toolName)} in the Godot editor plugin.`,
      category,
      params,
      inputSchema: buildInputSchema(params),
    };
  });
}

function extractCommandsBlock(source: string): string {
  const match = source.match(/func\s+get_commands\(\)\s*->\s*Dictionary\s*:\s*\n\s*return\s*\{([\s\S]*?)\n\s*\}/m);
  return match?.[1] ?? "";
}

function extractFunctionBody(source: string, handlerName: string): string {
  const escapedName = escapeRegExp(handlerName);
  const pattern = new RegExp(
    `(?:^|\\n)func\\s+${escapedName}\\([^\\n]*?\\)\\s*(?:->\\s*[^:\\n]+)?\\s*:\\n([\\s\\S]*?)(?=\\nfunc\\s+[A-Za-z0-9_]+\\(|$)`,
    "m",
  );

  return pattern.exec(source)?.[1] ?? "";
}

function extractFunctionComment(source: string, handlerName: string): string | undefined {
  const escapedName = escapeRegExp(handlerName);
  const pattern = new RegExp(`((?:^|\\n)(?:##[^\\n]*\\n)+)func\\s+${escapedName}\\(`, "m");
  const commentBlock = pattern.exec(source)?.[1];

  if (!commentBlock) {
    return undefined;
  }

  const lines = commentBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("##"))
    .map((line) => line.replace(/^##\s*/, "").trim())
    .filter(Boolean);

  return lines.length > 0 ? lines.join(" ") : undefined;
}

function inferParameters(body: string): ToolParam[] {
  const params = new Map<string, ToolParam>();

  const merge = (name: string, kind: ParamKind, required: boolean): void => {
    const existing = params.get(name);
    if (!existing) {
      params.set(name, { name, kind, required });
      return;
    }

    existing.kind = mergeKinds(existing.kind, kind);
    existing.required = existing.required || required;
  };

  collect(body, /require_string\(params,\s*"([^"]+)"\)/g, (name) => merge(name, "string", true));
  collect(body, /optional_string\(params,\s*"([^"]+)"/g, (name) => merge(name, "string", false));
  collect(body, /optional_bool\(params,\s*"([^"]+)"/g, (name) => merge(name, "boolean", false));
  collect(body, /optional_int\(params,\s*"([^"]+)"/g, (name) => merge(name, "integer", false));

  collect(body, /float\(params\["([^"]+)"\]\)/g, (name) => merge(name, "number", false));
  collect(body, /int\(params\["([^"]+)"\]\)/g, (name) => merge(name, "integer", false));
  collect(body, /bool\(params\["([^"]+)"\]\)/g, (name) => merge(name, "boolean", false));
  collect(body, /str\(params\["([^"]+)"\]\)/g, (name) => merge(name, "string", false));

  collect(
    body,
    /if\s+not\s+params\.has\("([^"]+)"\)\s+or\s+not\s+params\["\1"\]\s+is\s+Array\s*:\s*\n\s*return\s+error_invalid_params/g,
    (name) => merge(name, "array", true),
  );
  collect(
    body,
    /if\s+not\s+params\.has\("([^"]+)"\)\s+or\s+not\s+params\["\1"\]\s+is\s+Dictionary\s*:\s*\n\s*return\s+error_invalid_params/g,
    (name) => merge(name, "object", true),
  );
  collect(
    body,
    /if\s+not\s+params\.has\("([^"]+)"\)\s+or\s+not\s+params\["\1"\]\s+is\s+String\s*:\s*\n\s*return\s+error_invalid_params/g,
    (name) => merge(name, "string", true),
  );
  collect(
    body,
    /if\s+not\s+params\.has\("([^"]+)"\)\s*:\s*\n\s*return\s+error_invalid_params/g,
    (name) => merge(name, "any", true),
  );

  collect(body, /params\.get\("([^"]+)"/g, (name) => merge(name, "any", false));
  collect(body, /params\.has\("([^"]+)"\)/g, (name) => merge(name, "any", false));

  return [...params.values()].sort((left, right) => {
    if (left.required !== right.required) {
      return left.required ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

function collect(body: string, pattern: RegExp, add: (name: string) => void): void {
  for (const match of body.matchAll(pattern)) {
    const name = match[1];
    if (name) {
      add(name);
    }
  }
}

function mergeKinds(existing: ParamKind, incoming: ParamKind): ParamKind {
  if (existing === incoming) {
    return existing;
  }

  if (existing === "any") {
    return incoming;
  }

  if (incoming === "any") {
    return existing;
  }

  if ((existing === "integer" && incoming === "number") || (existing === "number" && incoming === "integer")) {
    return "number";
  }

  return "any";
}

function buildInputSchema(params: ToolParam[]): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};

  for (const param of params) {
    const baseSchema = schemaForKind(param.kind).describe(
      `Inferred ${param.required ? "required" : "optional"} ${param.kind} parameter from the Godot plugin source.`,
    );
    shape[param.name] = param.required ? baseSchema : baseSchema.optional();
  }

  return z.object(shape).passthrough();
}

function schemaForKind(kind: ParamKind): z.ZodTypeAny {
  switch (kind) {
    case "string":
      return z.string();
    case "boolean":
      return z.boolean();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "array":
      return z.array(z.any());
    case "object":
      return z.record(z.any());
    case "any":
      return z.any();
  }
}

function filterToolsForMode(tools: ToolDefinition[], mode: ToolMode): ToolDefinition[] {
  switch (mode) {
    case "full":
      return tools;
    case "lite":
      return tools.filter((tool) => LITE_CATEGORIES.has(tool.category));
    case "3d":
      return tools.filter((tool) => THREE_D_CATEGORIES.has(tool.category));
    case "minimal":
      return tools.filter((tool) => MINIMAL_TOOLS.has(tool.name));
  }
}

function humanizeToolName(name: string): string {
  return name
    .split("_")
    .map((part) => {
      const upper = part.toUpperCase();
      if (upper === "2D" || upper === "3D" || upper === "UI") {
        return upper;
      }

      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
