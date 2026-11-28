# Ignored / Out-of-Scope Directories

The repository contains a `mobile/` directory for the Flutter mobile app.

This directory is owned by another teammate and is OUT OF SCOPE for this agent.
This project do not use docker to run (ignore docker files)
Agents must NOT:
- read files inside `mobile/` unless explicitly instructed
- modify files inside `mobile/`
- refactor, rename, move, delete, or format anything inside `mobile/`
- include `mobile/` in broad code changes, searches, lint fixes, or cleanup tasks

All current work should focus only on the web/backend MVP unless the user explicitly says otherwise.

# Rental P2P MVP - Repository Context

This repository is a web platform for peer-to-peer personal item rentals. Users can act as both renters and owners.

Use this file as persistent project context. The existing frontend UI and API integrations are mostly implemented and working. Do not rewrite large flows, introduce new architecture, or replace established patterns unless the user explicitly asks for that.

## Current Project Map

Backend and frontend are the main working areas. Keep `mobile/` out of searches and edits unless the user explicitly asks for mobile work.

### Backend

- Runtime: Node.js, Express, CommonJS, Mongoose, Socket.IO, RabbitMQ, Cloudinary, Swagger UI.
- Main entry point: `backend/server.js`. This file loads env, connects MongoDB, tries RabbitMQ, configures Socket.IO chat auth, mounts REST routes, and exposes `/api-docs`.
- `backend/app.js` is an older/exportable Express app shape. Check whether a task actually uses it before editing it; the npm entry currently points to `server.js`.
- `backend/routes/`: URL definitions and route-level middleware. Add or verify endpoints here first.
- `backend/controllers/`: REST business logic for auth, ekyc, items, rentals, disputes, admin, views, users, and reviews.
- `backend/models/`: Mongoose schemas for `User`, `IdentityProfile`, `VerificationSession`, `EkycTempAsset`, `Item`, `Rental`, `Contract`, `Dispute`, `Message`, `Review`, `ItemReport`, and `AuditLog`.
- `backend/enums/`: backend source of truth for item, rental/payment, dispute, and eKYC status constants.
- `backend/middleware/auth.middleware.js` & `ekycAuth.middleware.js`: shared auth/permission middleware (`protect`, `admin`, `checkVerified`, and scoped `protectEkycMobileSession`).
- `backend/middleware/rateLimit.middleware.js`: Express rate limiters (`apiLimiter`, `loginLimiter`, `forgotPasswordLimiter`, `uploadLimiter`, `aiLimiter`, `ekycSessionLimiter`, `ekycClaimLimiter`, `ekycSubmitLimiter`).
- `backend/services/`: shared domain logic (`chatAuthorization.service.js`, `trustScore.service.js`, `viettelAi.provider.js`, `ekyc.service.js`, `ekycRealtime.service.js`).
- `backend/config/`: MongoDB, RabbitMQ, and Cloudinary configuration.
- `backend/scripts/`: migration, backfill, seed, and media import scripts. Most require a valid `MONGO_URI`.
- `backend/constants/` and `backend/utils/`: reusable messages (`messages.constant.js`) and helpers (`codeGenerator.js`, `urlValidation.js`).

Mounted backend API groups in `server.js`:

- `/api/auth`: register, login, logout, current user, profile, forgot/reset password (`POST /api/auth/verify-ekyc` deprecated `410`).
- `/api/ekyc`: Viettel AI eKYC (`status`, QR/direct `sessions`, single-use `claim`, `consent`, 2-sided CCCD `documents`, read-only `confirm-document`, 5-pose `liveness`; `DOCUMENT_AND_LIVENESS`, see `docs/EKYC_VIETTEL_AI.md`).
- `/api/items`: item search/list, categories, bestsellers, create/update/delete, price suggestion, item report, owner blocked-dates management.
- `/api/rentals`: rental request, VNPay URL/return, confirm/reject, contract, signing, pickup (with checklist), approve-pickup, completion (with checklist), approve-return, rental messages.
- `/api/views`: BFF-style read endpoints for item detail (includes blockedDates + isFavorited), the current user's rentals, and user financial/revenue stats.
- `/api/admin`: dashboard, user moderation, item moderation, featured/status updates, item reports.
- `/api/upload`: Cloudinary image upload/delete.
- `/api/users`: public profile, favorites (wishlist) management.
- `/api/reviews`: create review, list user reviews, and list item reviews.
- `/api/disputes`: create, list for admin, withdraw, escalate, resolve.

### Frontend

- Runtime: React 18, Vite 8 (ESM), React Router, axios, Socket.IO client, i18next, Leaflet, SweetAlert2, CKEditor.
- Main entry point: `frontend/src/index.jsx`. It wraps the app with `BrowserRouter`, `LoadingProvider`, and `AuthProvider`.
- Routes live in `frontend/src/App.jsx`. Public pages are direct routes; authenticated pages are nested under `<ProtectedRoute />`.
- `frontend/src/services/api.js`: central axios instance, auth token interceptor, global loading hooks, and exported API client functions. Prefer adding API wrappers here instead of calling axios directly from pages.
- `frontend/src/services/chatSocket.js`: rental chat Socket.IO client (reads the same stored token).
- `frontend/src/contexts/AuthContext.jsx` & `LoadingContext.jsx`: auth state (`/auth/me` bootstrap, login/logout/updateUser) and global spinner state.
- `frontend/src/pages/`: page-level `.jsx` screens for home/shop/item detail/auth/account/rentals/admin (dashboard, items, disputes, users, item reports)/VNPay return.
- `frontend/src/components/`: reusable UI grouped by domain:
  - `Layout`: header/footer.
  - `Auth`: protected route.
  - `Common`: spinner, location picker, and shared `CustomSelect` dropdown component (use `CustomSelect` instead of native `<select>` across web UI).
  - `Items`: item card/list/report modal.
  - `Rentals`: contract, signature, handover (`HandoverModal.jsx` — bidirectional review/edit/approve), chat panels, dispute (`DisputeModal.jsx` — image upload, reason dropdown).
  - `Admin`: admin nav/hero/dispute resolution form.
  - `Trust`: trust badge.
- `frontend/src/constants/`: frontend enum/status UI mapping (`enums.js`, `rentalUi.js`). Keep aligned with backend enums when statuses change.
- `frontend/src/styles/`, `App.css`, and `index.css`: page/component CSS. Prefer extending the nearest existing style file.
- `frontend/src/locales/vi.json` and `frontend/src/config/i18n.js`: Vietnamese localization setup.
- `frontend/public/`: static assets, Bootstrap files, legacy JS/CSS libs, and demo images. Avoid broad cleanup here unless targeting static assets.

### Local Scripts

- Usual local startup on Windows: run `.\start-all.ps1` from repo root to launch backend, frontend, and notification worker. Production runs on Docker via `docker-compose.prod.yml` + `nginx/nginx.tunnel.conf` (see `docs/INFRASTRUCTURE.md`).
- Backend and worker load root `.env` (`MONGO_URI`, `JWT_SECRET`; connects RabbitMQ when `RABBITMQ_ENABLED=true`).
- Backend only (`backend/`): `npm run dev` (nodemon) or `npm start` (`node server.js`).
- Frontend only (`frontend/`): `npm start` or `npm run dev` runs Vite (`FRONTEND_PORT || 3000`); `npm run build` outputs to `build/`.
- Automated tests: `backend/` runs `npm test` (`node --test tests/*.test.js`); `frontend/` has no active test script after Vite migration.
- Demo data (`backend/`): `node scripts/seed-items.js` creates missing items; `node scripts/import-seed-item-images.js --prepare | --apply` manages local demo photos and Cloudinary upload.

## Working Principles

- Preserve the current UI and behavior as much as possible.
- Make the smallest focused change that satisfies the request.
- Reuse existing components, modals, toasts, auth helpers, API client utilities, and styling patterns.
- Inspect existing frontend patterns before adding new code.
- Inspect backend routes, controllers, services, models, and middleware before changing API integration.
- Treat the backend as the source of truth for rental status, authorization, required fields, and payload shape.
- Do not guess API payloads, response fields, status names, or role permissions.
- Avoid creating new architectural layers unless an existing pattern clearly requires it.
- Keep unrelated refactors out of task-specific changes.

## Core Rental Flow

The rental lifecycle is:

1. Renter creates a rental request.
2. Renter pays the rental fee and deposit through VNPay. The backend builds the signed payment URL from `VNP_*` configuration and verifies the signature on the return before updating `paymentStatus` and the rental status.
3. Owner confirms the rental.
4. Backend automatically creates an electronic contract.
5. Renter and owner both sign the contract. When fully signed, the `notification-worker` generates a PDF (excluding the handover annex) and emails it to both parties.
6. One party records pickup with `PATCH /api/rentals/{id}/pickup` (stores `pickupReport`, does NOT advance status).
7. The other party reviews the pickup report in `HandoverModal` and confirms with `PATCH /api/rentals/{id}/approve-pickup` — status advances to `in_progress`.
8. One party records return with `PATCH /api/rentals/{id}/complete` (stores `returnReport`, does NOT advance status).
9. The other party reviews and confirms with `PATCH /api/rentals/{id}/approve-return` — status advances to `completed`.
10. Upon successful completion confirmation, the `notification-worker` generates and emails both parties the finalized contract PDF featuring the completed **Phụ lục Bàn giao & Hoàn trả** (Handover & Return Annex).

Rentals can be cancelled before pickup proof is recorded, subject to role and status checks. Cancellation or rejection of an escrowed rental sets `paymentStatus` to `refunded` in MongoDB. This status records the application outcome. The current backend has no VNPay refund or bank transfer call for these flows.


## Business Rules

- Pickup is allowed only after the contract is fully signed.
- Pickup requires `pickupImages`. Both pickup and complete optionally accept `condition`, `accessories`, `notes` (and `damages` for complete) to populate `pickupReport`/`returnReport`. Saving pickup/complete does NOT advance rental status — it waits for the counterpart to call `approve-pickup`/`approve-return`.
- `approve-pickup` and `approve-return` can optionally accept edited report fields (`condition`, `accessories`, `notes`, `damages`, `pickupImages`/`returnImages`) to let the reviewer override the original entry before confirming. Advancing rental status only happens on these approve calls.
- Completion requires `returnImages`.
- Booking availability is date-range based. `Item.status = rented` is not a global lock for all future rentals; new rental/payment/confirmation checks must reject only overlapping active bookings.
- Rental creation, payment, and confirmation check for overlapping `pending_confirmation`, `confirmed`, `in_progress`, or `disputed` rentals through `findOverlappingBooking` in `backend/controllers/rentals.controller.js`.
- Owner `blockedDates` are stored on the item and are separate from rental status. Search and the item detail calendar use them.
- When the owner adds a blocked date, `items.controller.js` checks for overlapping active rentals and existing owner blocks. Its rental status set currently differs from the booking check below.
- Backend authorization rules decide which user can perform each action.
- Frontend should display and submit data according to backend state, not local assumptions.
- Rental statuses must be verified from backend implementation before conditional UI or API changes.
- Item violation reporting: A user can only report a specific item once (enforced in backend `reportItem`). The 10-character minimum description and up to 3 evidence images (<= 5MB, .jpg/.jpeg/.png/.webp/.gif) are currently validated on the frontend (`ReportItemModal.jsx`), while backend `reportItem` checks non-empty `reason`.
- Admin report adjustments: Once a report is resolved, the original owner penalties/actions (e.g. warnings, trust score deductions) are preserved to keep penalty history consistent. Subsequent adjustments from the admin reports page toggle `Item.status` (AVAILABLE vs DELISTED) via `updateAdminItemStatus`.
- Favorites (wishlist): `User.favorites` is an array of Item ObjectIds, capped at 100, managed via `$addToSet`/`$pull`. `getItemDetailView` returns `isFavorited: Boolean` when the caller is authenticated (decoded from Bearer token without requiring `protect`, so unauthenticated calls work).
- Bank account: `User.bankAccount` stores `{ bankName, accountNumber, accountHolder }`. The web frontend requires all three fields before booking (`ItemDetailPage.jsx`) or creating/editing a listing (`PostItemPage.jsx`). Backend handlers do not enforce that requirement or transfer funds.
- Disputes start with a 48-hour mediation window before parties can escalate. The backend records `previousRentalStatus` and `previousItemStatus` so withdrawal or resolution with `winner = 'none'` can restore them.
- After a rental ends (`cancelled`, `rejected`, `completed`) the renter sees a **"Thuê lại sản phẩm"** button that navigates directly to the item detail page.


## Current differences between checks

- **Dispute eligibility:** `backend/controllers/disputes.controller.js` accepts disputes from rental parties for `confirmed` (including before pickup), `in_progress`, and `completed` for up to seven days from `updatedAt`, with `endDate` as a fallback. `frontend/src/pages/RentalDetailPage.jsx` exposes the action only for `confirmed` and `in_progress`, and hides it when there is a dispute record or the current user has already reviewed the rental. Keep this distinction when describing or changing the flow.
- **Calendar availability:** Listing date filters and owner blocked-date creation in `backend/controllers/items.controller.js`, and `bookedDates` in `backend/controllers/views.controller.js`, currently check `pending_confirmation`, `confirmed`, and `in_progress`. Rental booking checks also include `disputed`. An item can therefore appear free in search or on its calendar but fail the booking overlap check. Conversely, search and the web calendar respect owner `blockedDates`, while current rental booking handlers check overlapping rentals without enforcing owner `blockedDates`.

## Important APIs

Verify the exact implementation before using or modifying these endpoints:

- `POST /api/auth/forgot-password` — `202` queued, `503` queue unavailable, `404` unknown email; both backend and worker log a shared `requestId`. `PUT /api/auth/reset-password/{token}` validates the hashed token (10-minute expiry).
- `GET /api/items` — location picker requests `lat`, `lng`, `radius`, `includeMapLocation=true`; nearby listings include `mapLocation: { lat, lng }` (MongoDB stores GeoJSON `[lng, lat]`). Map pickers use Leaflet + OpenStreetMap tiles with error retry.
- `GET /api/rentals/{id}` — participant/admin detail endpoint (exists alongside `GET /api/views/my-rentals`, which web `RentalDetailPage.jsx` currently uses).
- `PATCH /api/rentals/{id}/confirm` | `cancel` | `POST /api/upload` | `POST /api/rentals/{id}/sign-contract`
- `PATCH /api/rentals/{id}/pickup` — body: `{ pickupImages, condition?, accessories?, notes? }` — saves `pickupReport`, status stays `confirmed`
- `PATCH /api/rentals/{id}/approve-pickup` — counterpart only; optional override body `{ pickupImages?, condition?, accessories?, notes? }` — advances status to `in_progress`
- `PATCH /api/rentals/{id}/complete` — body: `{ returnImages, condition?, accessories?, notes?, damages? }` — saves `returnReport`, status stays `in_progress`
- `PATCH /api/rentals/{id}/approve-return` — counterpart only; optional override body `{ returnImages?, condition?, accessories?, notes?, damages? }` — advances status to `completed`
- `POST /api/items/{id}/report`, `GET /api/admin/item-reports`, `PATCH /api/admin/item-reports/{reportId}/resolve`
- `GET /api/admin/users`, `GET /api/admin/users/{id}`, `PATCH /api/admin/users/{id}/status`, `GET /api/admin/audit-logs`
- `POST /api/items/{id}/blocked-dates` (`{ startDate, endDate, reason? }`), `DELETE /api/items/{id}/blocked-dates/{blockId}` (owner only)
- `GET/POST/DELETE /api/users/me/favorites[/{itemId}]` — authenticated; idempotent, max 100
- `GET /api/views/financial-stats` — authenticated; returns owner stats, renter stats, and recent transactions
- `GET /api/reviews/items/{itemId}` — public; returns product-specific `averageRating`, `totalReviews`, and `reviews` list

When touching these APIs from the frontend:

- Read the matching backend route first.
- Trace from route to controller and service.
- Confirm request body names, response shape, validation, status transitions, and role checks.
- Check existing frontend API client conventions before adding calls.
- Keep the integration consistent with the current auth/token handling and error/toast behavior.

## Frontend Expectations

- Keep the current screens and layout intact unless the user requests UI redesign.
- Reuse existing components and modal patterns.
- Reuse existing toast and error handling patterns.
- Reuse the current authenticated API client.
- Prefer editing the narrowest existing file over creating new files.
- Do not duplicate rental state logic if an existing helper or page already handles it.
- Do not hardcode status transitions without verifying backend behavior.

## Backend Expectations

- Backend is authoritative for rental status transitions.
- Backend is authoritative for user permissions and ownership checks.
- Backend is authoritative for required proof images.
- Backend contract generation after owner confirmation is expected behavior.
- Before frontend changes, inspect backend implementation for the relevant action.
- TrustScore is a 0-100 reliability/risk score, not review stars. Keep review aggregates in `averageRating` and `totalReviews`, derive `trustLevel` from `trustScore`, and use `backend/services/trustScore.service.js` for recalculation.
- Do not directly add/subtract `trustScore` in controllers. Persist source events such as public reviews, completed rentals, resolved disputes, item report actions, eKYC changes, or admin account status changes, then call `recalculateUserTrustScore`.
- Public user summaries should avoid sensitive fields. `GET /api/users/:id/profile` returns safe profile, trust/rating fields, public reviews, and public owner items.

## Description Formatting & Security

- **WYSIWYG Formatting:** Item descriptions use **CKEditor 5** (Classic Build) inside `PostItemPage.jsx` with a Live Preview mode.
- **Description rendering:** `frontend/src/utils/sanitize.js` escapes input HTML and restores selected formatting tags, links, and images. Check that helper and its rendering call sites before changing accepted tags, URLs, or attributes.
- **Review Breakdown Dashboards:** Details page reviews tab computes 1-to-5 star breakdowns from transaction reviews using standard typography tokens.
- **Smart Availability & Busy Schedule:** `ItemDetailPage.jsx` computes Today's availability from timezone-safe `item.bookedDates` (`AVAILABLE`, `AVAILABLE_TODAY`, or `RENTED`) and shows "Lịch bận sắp tới" (first 3 entries for renters; full entries for owners).
- **Bidirectional Handover Flow:** `HandoverModal.jsx` serves both recorder and reviewer (read-only prefill + optional edit override) via `approvePickup`/`approveReturn`.
- **PDF Contract Email:** `notification-worker` handles `contract_fully_signed` (without annex) and `contract_completed` (with pickup + return annex) via `pdfkit` + `transporter`.

## Senior BA & Requirements Governance

- For product discovery, requirements analysis, business rule review, or BA audits, follow `.agents/skills/senior-ba/SKILL.md` and its references (`references/product-context.md`, `references/decision-log.md`), plus `docs/INFRASTRUCTURE.md` (infra/NFR baseline) and `docs/design/RENTALHUB_*.md` (web UI/UX exploration baseline).
- **Four-Tier Source of Truth:** Distinguish (1) Founder Decisions, (2) Approved Requirements, (3) Current Implementation, and (4) Proposals. Never decide unresolved business rules for the Founder or silently rewrite approved requirements to hide implementation mismatches.
- **No Unrequested Code Edits in BA Work:** Do not modify application source code, migrations, or DB state during BA analysis unless explicitly asked.
- **Sync After Confirmation:** Only after the Founder explicitly confirms a decision, update `decision-log.md`, `product-context.md`, affected domain skills, and `.agents/AGENTS.md` (if architecture/APIs/rules changed).

## Infrastructure & Security — Mandatory Instructions

> Note: The "do not use docker" note at the top of this file applies to local development (`.\start-all.ps1`). Production runs on Docker behind Cloudflare Tunnel; see `docs/INFRASTRUCTURE.md` as the single documented baseline.

- All agents MUST read `docs/INFRASTRUCTURE.md` before performing any infrastructure-related task.
- This requirement applies to server configuration, deployment, Docker, Docker Compose, Nginx, networking, DNS, Cloudflare, Cloudflare Tunnel, firewall, SSH, Google Cloud, CI/CD, environment variables, secrets, and production troubleshooting.
- Treat `docs/INFRASTRUCTURE.md` as the documented baseline, not as a substitute for verifying the actual system state.
- Never assume that an unverified or recommended configuration has already been deployed.
- Always preserve the existing security architecture unless an explicitly approved change requires otherwise.
- Never perform production infrastructure changes without explicit user approval.
- Every proposed infrastructure change must include its purpose, impact, risks, verification steps, and rollback strategy.
- Prefer read-only inspection before proposing or executing changes.
- Follow the 10-step maintenance workflow in `docs/INFRASTRUCTURE.md` and update the document and changelog after every approved and verified infrastructure change.
- Never expose credentials, tokens, private keys, database connection strings, or other sensitive information.

### Security Architecture Invariants (Must Preserve)

- Public application traffic must pass through Cloudflare Tunnel; never create paths that bypass Cloudflare.
- Never publish Nginx, Backend, RabbitMQ, or internal service ports directly to the Internet.
- Never open public SSH to replace Google Cloud IAP (`35.235.240.0/20`).
- Never disable UFW, Cloudflare WAF, or Rate Limiting as a temporary troubleshooting workaround.
- Never re-enable `rental-test` or create new public hostnames without explicit approval.
- Never enable Cache Everything for the whole site or cache authentication/personal data.
- Never delete Docker volumes, databases, persistent storage, or message queue data without approval.
- Never change production secrets, credentials, or tunnel tokens without approval.
- Never restart, redeploy, or run potentially disruptive production actions outside the requested scope.

## Safe Change Checklist

Before changing rental-related frontend behavior: inspect the backend route, controller/service logic, allowed roles/statuses, payload/upload schema, and existing frontend API/UI patterns; make the smallest compatible change; run relevant checks.

## Agent Self-Update Rule

Keep this file concise, accurate, and strictly under 24 KB:
- Update only for durable changes (new APIs, routes, models, enums, permissions, major screens, business rules, or constraints); skip small fixes, copy tweaks, or changelogs.
- Prefer updating existing sections over duplicating notes, exclude speculation or unfinished work, and never alter `mobile/` scope notes unless instructed.

Keep test account credentials in a private local source outside the repository.
