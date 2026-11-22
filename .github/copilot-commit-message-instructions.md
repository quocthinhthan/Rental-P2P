# Git Commit Message Instructions (VS Code Copilot)

Generate a Git commit message strictly grounded in the staged diff (or working tree diff if nothing is staged).

## Output Rules

- Return **plain text only**: no Markdown code fences, no headings, no explanations, and no commentary.
- Emit **exactly ONE subject line** using Conventional Commits:
  `<type>(<scope>): <description>` (or `<type>: <description>` when no single scope fits).
- **Never** concatenate multiple `type(scope): ...` summaries onto the same line or emit multiple commit headers.
- Write in **English**, using the **imperative mood** (e.g., `migrate`, `add`, `fix`, `remove`, `update`), lowercase after the colon, no trailing period.
- Keep the entire subject line **72 characters or fewer** (ideal: <= 65 characters).

## Allowed Types

- `feat`: new user-facing capability or endpoint
- `fix`: bug fix or corrected behavior
- `build`: build system, bundler, or external dependency changes (e.g., CRA -> Vite, npm packages)
- `refactor`: internal code restructuring with no behavior change
- `perf`: performance improvement
- `docs`: documentation only
- `style`: formatting/whitespace/linting only (no logic change)
- `test`: adding or updating tests
- `chore`: tooling, config, scripts, or repo maintenance
- `ci`: CI/CD workflow changes
- `revert`: reverting a previous commit

## Recommended Scopes (Rental-P2P-MVP)

- Layer scopes (broad changes within one layer): `frontend`, `backend`, `worker`, `startup`, `deps`, `docs`
- Feature scopes (focused feature changes): `auth`, `items`, `rentals`, `disputes`, `admin`, `maps`, `chat`, `contract`, `reviews`, `views`

## Body & Footer (Optional)

- Omit the body for small, self-explanatory changes.
- When the commit contains multiple related sub-changes, a migration, or a non-obvious reason, add a **blank line** after the subject followed by **2–5 concise bullet points** (`- ...`), wrapping lines at ~72 characters.
- For breaking changes, append `!` before `:` in the subject and include a `BREAKING CHANGE: <impact and action>` footer.
- Never include secrets, tokens, `.env` values, personal data, or unverified test claims.

## Good Examples

Single-line commit:
fix(maps): use standard OpenStreetMap tile endpoint

Multi-part migration commit:
build(frontend): migrate React 18 app from CRA to Vite

- Replace react-scripts with Vite and @vitejs/plugin-react
- Move index.html to frontend root and update env references
- Rename JSX source files from .js to .jsx for Vite compatibility

## Bad Examples (Never Generate)

- `feat(auth): add reset flow fix(maps): update tiles` (multiple headers on one line)
- `Updated frontend files.` (not Conventional Commits, past tense, trailing period)
- ```` ```text\nfeat(items): add filter\n``` ```` (wrapped in Markdown code fences)
