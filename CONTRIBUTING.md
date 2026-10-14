# Contributing

Thanks for helping. Bcontext is maintained by one person, so the process is
small:

1. **Open an issue first** for anything bigger than a bug fix, so we can agree
   on the shape before you write it.
2. Fork, branch from `main`, and keep the PR to one change.
3. `npm install` at the root (Node 24), then `npm run verify`. It must pass —
   CI runs the same thing.
4. If the change touches the database, add a new migration (never edit an
   existing one) and check a fresh `docker compose up -d --build` applies it.
5. Describe what changed and why in the PR, and how you tested it.

`AGENTS.md` lists the repository's rules (they apply to humans too).

By contributing you agree that your contribution is licensed under the
AGPL-3.0-only, the license of this project.

Security issues: please do not open a public issue; use GitHub's private
vulnerability reporting on this repository.
