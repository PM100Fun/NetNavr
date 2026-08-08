# Contributing to NetNavr

NetNavr is a pre-alpha research project. Small, testable changes are easier to
review than broad rewrites, and evidence is more valuable than confident
claims.

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Before opening a change

1. Search existing issues and discussions.
2. Open an issue before substantial architecture, protocol, security, payment,
   or dependency changes.
3. Keep ownership boundaries intact: shared runtime and data in `core/`, human
   interaction in `shell/`, and payment-specific behavior in `pay/`.
4. Do not commit secrets, personal data, generated builds, local databases, or
   the local upstream reference checkout under `shell/sources/openai-codex/`.

## Development

Use Node.js 24 or newer. Install Shell dependencies and run the repository
checks:

```bash
npm --prefix shell ci
npm run verify
```

Add focused tests for behavior you change. A pull request should explain the
problem, the chosen boundary, how it was verified, and any unresolved risk.

## Project expectations

- Never claim an aspirational feature is implemented without a reproducible
  demonstration.
- Default local services to loopback and least privilege.
- Treat memory, identity, credentials, payments, and external side effects as
  high-risk surfaces.
- Preserve provider replaceability and user-controlled data as design
  constraints.

By contributing, you agree that your contribution is licensed under the
Apache License 2.0.
