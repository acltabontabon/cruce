# Cruce Flight sandbox: one container per Flight, driven by the FlightSandbox Durable Object.
# Everything the agent needs is installed at build time; at run time the container has no direct
# Internet access — every request goes through Cruce's Outbound handler (credentials stay in the Worker).
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates git ripgrep jq \
	&& rm -rf /var/lib/apt/lists/*

# Pinned: Claude Code's flags and event format change between releases.
RUN npm install --global @anthropic-ai/claude-code@2.1.288

# Use the shim from the same release line as @cloudflare/sandbox.
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# The Cruce agent protocol, as a CLI the coding agent can call from its shell.
COPY cruce-cli.mjs /usr/local/bin/cruce
RUN chmod +x /usr/local/bin/cruce

WORKDIR /workspace
CMD ["sleep", "infinity"]
