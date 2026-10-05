import type { Directory } from "./directory.ts";

// The retired Workspace model used "directory". Keep its storage untouched;
// the Namespace model has its own stable directory object, shared by all callers.
export function namespaceDirectory(env: { DIRECTORY: DurableObjectNamespace<Directory> }) {
	return env.DIRECTORY.getByName("namespace-directory");
}
