import type { Plugin, PluginContext } from "../types/plugin.js";
import { registerTool } from "./toolRegistry.js";
import { registerScanProfile } from "./scannerRegistry.js";
import { registerRetrievalSource } from "./retrievalRegistry.js";

const plugins = new Map<string, Plugin>();

const context: PluginContext = {
  registerTool,
  registerScanProfile,
  registerRetrievalSource,
};

export function loadPlugin(plugin: Plugin): void {
  plugin.register(context);
  plugins.set(plugin.id, plugin);
}

export function listPlugins(): Pick<Plugin, "id" | "name" | "version">[] {
  return [...plugins.values()].map(({ id, name, version }) => ({ id, name, version }));
}
