# NetNavr workspace rules

- This repository contains NetNavr source code only. Canonical planning, product,
  handoff, deployment, release, and validation documents belong in the
  maintainer's external NetNavr documentation workspace.
- Repository-facing community files are allowed at the root and under
  `.github/`: `README.md`, `LICENSE`, `NOTICE`, `CONTRIBUTING.md`,
  `SECURITY.md`, `GOVERNANCE.md`, `CODE_OF_CONDUCT.md`, issue templates, pull
  request templates, and CI configuration.
- Do not add other user-facing project documents to this source repository.
- Documentation inside `shell/sources/openai-codex` belongs to the upstream
  reference repository and is not a NetNavr document output.
- Keep implementation ownership separated: `core/` for shared runtime/backend
  and data capabilities, `shell/` for human interaction, and `pay/` for
  payment-specific behavior.
- Generated artifacts and caches such as `.DS_Store`, `dist/`, `release/`,
  `build/`, and app-local Vite caches must not be treated as source.
