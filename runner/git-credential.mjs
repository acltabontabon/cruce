#!/usr/bin/env node
import { tsImport } from "tsx/esm/api";

await tsImport("./git-credential.ts", { parentURL: import.meta.url, tsconfig: false });
