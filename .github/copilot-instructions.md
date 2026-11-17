# Commit messages for Rental-P2P-MVP

Apply these rules when asked to draft a Git commit message or prepare a commit.

- Base the message on the actual diff. In Agent mode, check `git status --short` and `git diff --cached`. Describe the staged changes when present. For a draft with nothing staged, use the changes the user selected or specified.
- Keep each commit focused on one purpose. If several unrelated changes are in scope, suggest separate commits in chat. Only stage, commit, or push when the user asks for that action.
- Use Conventional Commits with the format `type(scope): description`. Omit the scope when no single scope accurately describes the change.
- Choose the type by intent: `feat` for a new capability, `fix` for correcting behavior, `refactor` for internal restructuring without a behavior change, `docs` for documentation, `test` for tests, `perf` for measured or intended performance improvements, and `chore`, `build`, or `ci` for maintenance, build, or CI changes. Use `style` for formatting-only changes.
- Use a short lowercase scope that identifies the affected area, such as `auth`, `items`, `rentals`, `maps`, `worker`, or `startup`. Use the feature scope for a single change spanning backend and frontend, and `backend` or `frontend` when a broad change is limited to that layer.
- Write the subject in English. Start the description with an imperative verb, describe the concrete change, and aim for 72 characters or fewer for the entire subject. Omit a trailing period.
- Add a body after a blank line only when it helps explain the reason, behavior change, or migration. Use `!` and a `BREAKING CHANGE:` footer for an incompatible change and explain what callers need to do. Include an issue reference only when the user or repository context supplies it.
- Keep the message grounded in the diff. Leave out credentials, tokens, personal data, and unverified test claims. For commit message generation, return plain text with no Markdown or explanation.

Examples:

```text
fix(startup): skip the local MongoDB service for remote databases
feat(items): add bulk image import for seed items
fix(maps): use the standard OpenStreetMap tile endpoint
docs: document how to start the local stack
```
