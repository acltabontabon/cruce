#!/usr/bin/env node
// Node's built-in type stripping cannot run the shared controller's parameter properties.
// Keep the loader scoped to the bridge and independent of the agent project's dependencies.
import { tsImport } from "tsx/esm/api";

await tsImport("./cruce.ts", { parentURL: import.meta.url, tsconfig: false });
