# Agent instructions for auth-service

This repository is coordinated by Cruce. Before you change code:

1. Investigate (read-only) and file a Flight Plan with the files and symbols you intend to modify.
2. Only modify what your clearance allows. If you need more, request a Flight Plan amendment.
3. Keep changes small and covered by tests (`npm test`).
4. Do not add dependencies. TypeScript here must run with Node's type stripping:
   no enums, no namespaces, no constructor parameter properties.
