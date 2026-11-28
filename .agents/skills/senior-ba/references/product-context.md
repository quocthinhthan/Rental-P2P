# Rental P2P MVP — Product & Business Context (BA Knowledge Base)

> Last audited: 2026-11-27 (read-only audit synced with commit `205cde3`: `docs/INFRASTRUCTURE.md`, `nginx/nginx.tunnel.conf`, `docker-compose.prod.yml`, `docs/design/RENTALHUB_*.md`)  
> Scope: Web, Backend, Worker, and Production Infrastructure baseline (`backend/`, `frontend/`, `notification-worker/`, `nginx/`, `docker-compose.prod.yml`, `docs/`). `mobile/` remains OUT OF SCOPE per `.agents/AGENTS.md`. Local Windows dev runs without Docker (`.\start-all.ps1`); production runs on Docker behind Cloudflare Tunnel per `docs/INFRASTRUCTURE.md`.

---

## 1. Product Vision & Problem Statement

- **Vision:** A peer-to-peer (P2P) sharing-economy marketplace enabling individuals to safely rent personal items (electronics, cameras, camping gear, household tools, vehicles, etc.) from nearby owners with transparent escrow, digital contracts, condition handover logs, and community trust signals. *(Working brand ambiguity: existing code/UI uses `RentalP2P` / `Rental P2P`, while `docs/design/` uses `RentHub` as a working name; final production brand awaits Founder confirmation.)*
- **Core Problems Addressed:**
  1. **Idle asset monetization & affordable short-term access:** Owners earn passive income on underutilized personal belongings; renters access equipment temporarily without buying.
  2. **Peer trust deficit:** Strangers hesitate to hand over valuable items or deposits. Mitigated via eKYC (CCCD OCR), 0–100 `trustScore`, double-blind reviews, VNPay escrow simulation, electronic signatures, photo-backed pickup/return reports, and admin-mediated disputes.
  3. **Scheduling & location friction:** Geo-radius map search + date-range booking + owner-managed `blockedDates` prevent double-booking and help renters find nearby items.

---

## 2. User Roles & Permissions Matrix

| Role | Description | Key Capabilities (Observed in Code) |
|---|---|---|
| **Guest** (Unauthenticated) | Public visitor | Browse home/shop, search items (text/category/dates/location radius), view item detail + availability calendar + owner trust summary + reviews, view public user profile, trigger forgot/reset password. *(Note: API `GET /api/views/item-details/:id` currently returns `owner.phoneNumber` to Guests even though UI hides it.)* |
| **Registered Member** (`role: 'user'`, unverified eKYC) | Authenticated user without eKYC | Update profile & bank account, submit eKYC (`POST /api/auth/verify-ekyc`), manage favorites (max 100), report items (`POST /api/items/:id/report`), use AI price suggestion, view financial stats, view/chat on own rentals, raise/withdraw/escalate disputes, submit reviews, pay/cancel own `pending_payment` rental. |
| **Verified Member** (`ekycStatus === 'verified'`) | Identity-verified Renter &/or Owner | All Member actions **plus** gated by `checkVerified`: create items (`POST /api/items`), create rental requests (`POST /api/rentals`), sign contracts (`POST /api/rentals/:id/sign-contract`), record pickup (`PATCH /api/rentals/:id/pickup`). *(Note: `confirmRental` also checks both owner & renter `ekycStatus === 'verified'`.)* |
| **Item Owner** (contextual per item/rental) | User whose `_id === item.ownerId` / `rental.ownerId` | Edit/delist/delete own item, manage `blockedDates`, confirm/reject `pending_confirmation` rentals, cancel `confirmed` rental before pickup, approve pickup/return handover reports. |
| **Renter** (contextual per rental) | User whose `_id === rental.renterId` | Pay via VNPay, cancel before pickup proof, initiate pickup/return handover reports or approve counterpart's report. |
| **Admin** (`role: 'admin'`) | Platform moderator & operator | Access `/api/admin/*` and `/api/disputes` (list & resolve): view dashboard KPIs/charts/top lists, search/ban/suspend/unban users, view user/item deep detail & audit logs, delist/restore/feature items, resolve item reports, resolve disputes with winner & penalties, read rental chats. |

---

## 3. Core Domain Entities & Lifecycles

### 3.1. `Item` (`backend/models/Item.model.js`, `backend/enums/item.enum.js`)
- **Fields:** `code` (`SP...`), `name`, `description` (HTML via CKEditor, sanitized on render by `frontend/src/utils/sanitize.js`), `category`, `images`, `ownerId`, `pricePerDay`, `baseValue`, `depositPercentage` (0–120, default 100), `address`, `location` (GeoJSON `Point`), `status`, `isFeatured`, `delistedByAdmin` (`Boolean`), `adminDelistReason` (`String`), `blockedDates[]`.
- **Statuses:** `available` | `rented` | `delisted`.
- **Governance & Runtime behavior:** When `delistedByAdmin === true`, owner `PUT /api/items/:id` is blocked (`403`). `DELETE /api/items/:id` is blocked (`400`) if the item has any active or historical rental. `Item.status = rented` reflects whether an active booking (`confirmed`, `in_progress`, `disputed`) covers "today" via `syncItemRuntimeStatus` (`backend/services/itemAvailability.service.js`); future bookings remain date-range based.

### 3.2. `Rental` (`backend/models/Rental.model.js`, `backend/enums/rental.enum.js`)
- **Rental Statuses:** `pending_payment` -> `pending_confirmation` -> `confirmed` -> `in_progress` -> `completed` | `rejected` | `cancelled` | `disputed`. *(Note: `RentalStatus` does NOT include `refunded`; `PaymentStatus` tracks `pending` | `escrowed` | `refunded`.)*
- **Availability & Date Rules:** `createRentalRequest` blocks `startDate` before `00:00` today (`400`). `createRentalRequest`, `createVNPayUrl`, `handleVNPayReturn`, and `confirmRental` enforce `checkItemDateAvailability` (rejecting `delisted`/`delistedByAdmin`, owner `blockedDates`, and `ACTIVE_BOOKING_STATUSES` including `disputed`). `approvePickup` calls `syncItemRuntimeStatus`.
- **Pricing & Commission Formula (`createRentalRequest`):**
  - `days = ceil((end - start) / 86400000) + 1` (inclusive calendar days).
  - `rentalFee = days * item.pricePerDay`
  - `depositAmount = (item.baseValue * item.depositPercentage) / 100`
  - `commissionRate = 10` (%) -> `commissionAmount = rentalFee * 10%`, `payoutAmount = rentalFee - commissionAmount`
  - `totalAmount = rentalFee + depositAmount`
- **Two-Phase Handover:**
  1. Pickup: Party A calls `PATCH /api/rentals/:id/pickup` (saves `pickupImages` + `pickupReport`, status remains `confirmed`) -> Party B reviews/edits in `HandoverModal.jsx` and calls `PATCH /api/rentals/:id/approve-pickup` (advances status to `in_progress`).
  2. Return: Party A calls `PATCH /api/rentals/:id/complete` (saves `returnImages` + `returnReport`, status remains `in_progress`) -> Party B reviews/edits and calls `PATCH /api/rentals/:id/approve-return` (advances status to `completed`, recalculates TrustScore, queues `contract_completed` PDF email).

### 3.3. `Contract` (`backend/models/Contract.model.js`)
- Auto-created (1:1 `unique` `rentalId`) when Owner confirms rental (`confirmRental`), snapshotting owner/renter `fullName` & `idCardNumber`, item details, dates, and `totalPrice`.
- Both parties upload signature PNGs to Cloudinary and sign via `POST /api/rentals/:id/sign-contract`. When `ownerSignedAt` and `renterSignedAt` are set, `isFullySigned = true` and `notification-worker` emails the initial PDF contract.

### 3.4. `Dispute` (`backend/models/Dispute.model.js`, `backend/enums/dispute.enum.js`)
- **Statuses:** `pending` (48h mediation window via `mediationEndsAt`) -> `escalated` (by either party after `mediationEndsAt`) -> `resolved` (by Admin) or `withdrawn` (by reporter).
- **Atomicity & Outcomes (`winner`):** `escalateDispute`, `withdrawDispute`, and `resolveDispute` use atomic `Dispute.findOneAndUpdate` status guards (`409` on race) + optional MongoDB transaction. `renter` sets `rental.status = cancelled` and `paymentStatus = refunded` (only if currently `escrowed`) | `owner` sets `rental.status = completed` | `none` restores `previousRentalStatus` (requires `penaltyType = none`). All outcomes sync `Item.status` via `syncItemRuntimeStatus` (preserving `delisted` / `delistedByAdmin` and concurrent active rentals).
- **Penalties (`penaltyType`):** `none` | `warning` (-15 TrustScore) | `suspension` (+7 days `suspendedUntil`, -30 TrustScore, capped <= 40 while suspended) | `ban` (`isBanned = true`, TrustScore = 0).

### 3.5. `Review` & `TrustScore`
- **Reviews (`Review.model.js`):** Double-blind per `(rentalId, reviewerId)` on `completed` rentals within 7 days of `rental.updatedAt`. Hidden until counterpart submits OR 7 days pass (auto-published lazily in `getUserReviews` / `getItemReviews`).
- **TrustScore (`trustScore.service.js`):** `0–100` reliability score (`base 50 + eKYC [+20/-10/0] + completedRentals [2 each, max +20] + reviewScore [+10 to -10] - disputePenalties - itemReportPenalties`, clamped `[0, 100]`, capped `<= 40` while suspended, `0` if banned).

### 3.6. `ItemReport` & `AuditLog`
- `ItemReport`: `pending` -> `resolved` with `action` (`no_action`, `warn_owner` [-10], `hide_item` [-15 + delist], `delist_item` [-15 + delist], `ban_item` [-25 + delist]). One report per `(itemId, reporterId)` enforced in controller.
- `AuditLog`: Records admin actions (`admin.user.update_status`, `admin.item.update_status`, `admin.item.update_feature`, `admin.item_report.resolve`, `admin.dispute.resolve`).

---

## 4. Functional Status Classification

> Legend: **IMPLEMENTED** (live in source code) | **PARTIALLY IMPLEMENTED** (incomplete, mismatched, or DB-only) | **PLANNED** (documented as intended) | **PROPOSED** (idea / unapproved) | **UNKNOWN** (insufficient evidence).

### 4.1. IMPLEMENTED
- User registration, JWT login (with ban/suspension check), logout, `GET /api/auth/me`, profile update, forgot/reset password via RabbitMQ + SMTP worker (`auth.controller.js`, `worker.js`).
- eKYC verification via FPT.AI CCCD OCR (`verify-ekyc`) + identity-field lock after verification (`auth.controller.js:51-64`).
- Item CRUD, Vietnamese accent-insensitive search, GeoJSON 2dsphere `$geoNear` radius search + Leaflet map pickers, categories, bestsellers, CKEditor rich description + XSS sanitizer (`items.controller.js`, `PostItemPage.jsx`, `ShopPage.jsx`).
- Owner `blockedDates` add/remove (`items.controller.js`, `ItemDetailPage.jsx`).
- Favorites / Wishlist up to 100 items (`favorites.controller.js`, `FavoritesPage.jsx`).
- Rental request creation, VNPay signed URL + return redirect callback, owner confirm/reject, pre-pickup cancel (`rentals.controller.js`, `VNPayReturnPage.jsx`).
- Auto-generated electronic contract + Cloudinary signature pad + PDF generation with side-by-side signatures & handover annex (`ContractModal.jsx`, `SignatureModal.jsx`, `worker.js`).
- Two-phase pickup & return handover reports with photo proof (`HandoverModal.jsx`, `rentals.controller.js`).
- Real-time Socket.IO + REST rental chat with room authorization & rate limiting (`server.js`, `chatAuthorization.service.js`, `RentalChatPanel.jsx`).
- Double-blind review submission, user review list, product-specific review list (`reviews.controller.js`, `ItemDetailPage.jsx`, `PublicUserProfilePage.jsx`).
- Centralized `0–100` TrustScore calculation & backfill script (`trustScore.service.js`, `recalculate-trust-scores.js`).
- Dispute create/freeze, 48h mediation countdown, withdraw, escalate, admin resolve + progressive penalties (`disputes.controller.js`, `RentalDetailPage.jsx`, `AdminDisputesPage.jsx`, `AdminDisputeDetailPage.jsx`).
- Item violation reporting & admin item report resolution (`ReportItemModal.jsx`, `AdminItemReportsPage.jsx`).
- User Financial & Revenue Dashboard (`views.controller.js`, `FinancialDashboardPage.jsx`).
- Admin Dashboard (KPIs, charts, top items, top/risky users), User Management & Audit Logs, Item Management & Detail (`admin.controller.js`, `Admin*Page.jsx`).
- Express & Socket.IO rate limiting (`rateLimit.middleware.js`, `server.js`).

### 4.2. PARTIALLY IMPLEMENTED
- **Escrow, Refund & Owner Payout Settlement:** `paymentStatus` updates (`escrowed` / `refunded`) and `commissionAmount`/`payoutAmount` calculations exist in MongoDB, and UI requires `User.bankAccount` and claims "72h automatic refund", **but** backend performs zero VNPay refund API calls, zero VNPay IPN server-to-server webhook handling (relies on browser redirect `GET /vnpay-return`), zero bank-transfer/payout execution, and does not enforce `bankAccount` on backend.
- **Overdue, Late Fee & Rental Extension:** `getRentalDetail` and `getMyRentalsView` return `actualReturnDate`, `overdueDays`, `lateFeeAmount` (and `extensionRequest` in `views.controller.js:284`), **but** these fields do not exist on `Rental.model.js` and no endpoint/logic calculates late fees or processes rental extensions.
- **Availability Calendar vs Booking Enforcement:** Search (`items.controller.js`) and calendar view (`views.controller.js`) check `blockedDates` and `['pending_confirmation', 'confirmed', 'in_progress']` (missing `disputed`), whereas booking/payment/confirmation (`rentals.controller.js`) check `['pending_confirmation', 'confirmed', 'in_progress', 'disputed']` and **ignore `blockedDates`**.
- **Notification Worker Email Templates:** `rental_status_changed` only populates email body for `confirmed` and `rejected`; calls from `cancelRental` (`cancelled`), `approvePickup` (`in_progress`), and `approveReturn` (`completed`) trigger emails with blank `message` and generic title `"📢 Cập nhật đơn thuê"`.
- **Admin Audit Trail Completeness:** `AdminUsersPage.jsx` filter lists `admin.dispute.resolve` and `admin.user.update_ekyc`; `resolveDispute` now logs `admin.dispute.resolve`, while no admin eKYC override endpoint exists for `admin.user.update_ekyc`.
- **Frontend Role Guard & i18n:** `/admin/*` routes use `<ProtectedRoute />` which checks `isLoggedIn` only (not `user.role === 'admin'`); `vi.json` omits `rental.status.disputed` and most JSX pages use hardcoded Vietnamese strings.
- **AI Price Suggestion without Gemini Key:** `items.controller.js:560` averages `ruleBasedPrice` with `aiSuggestedPrice` (initialized `null`), halving suggested price when `GEMINI_API_KEY` is absent.
- **Auth Edge/Origin Rate Limiting & Edge HSTS (`docs/INFRASTRUCTURE.md` §1.1, §7.3, §12):** `POST /api/auth/register` lacks a dedicated backend limiter (uses general `apiLimiter` 300/15m); Cloudflare Auth Rate Limiting HTTP 429 behavior and Cloudflare Edge HSTS remain `TODO` (`nginx/nginx.tunnel.conf` serves HTTP `:80` behind Tunnel without HSTS).
- **Static / UI-only Web Surfaces (`docs/design/RENTALHUB_PRODUCT_CONTEXT.md`):** `/contact` (`ContactPage.jsx`) renders a message form with no submit handler/support inbox; `/` (`HomePage.jsx`) includes static promotional tiles without discount backend; `*` (`NotFoundPage.jsx`) displays English fallback copy; `/login` redirects to `/` even when reached from gated flows.

### 4.3. PLANNED / PROPOSED (Documented in Skills & Design Brief, Not Implemented)
- **Web UI/UX Redesign Exploration (Concept Phase):** 3 Style Exploration Boards covering 28 web routes documented in `docs/design/RENTALHUB_{DESIGNER_BRIEF,PRODUCT_CONTEXT,SCREEN_INVENTORY}.md`; Founder review precedes any production UI redesign.
- Dedicated `/admin/rentals` management page (referenced in `ui-designer/SKILL.md:82`, does not exist in routes/API).
- Separate Owner vs Renter TrustScore dimensions, time-decay for old penalties, cancellation-rate fraud signals, user-facing score breakdown, background cron for auto-publishing reviews, and admin manual TrustScore override (`trust-score-rules/SKILL.md` §11).
- Automated VNPay refund / payout disbursements.

### 4.4. UNKNOWN
- `mobile/` feature parity and contracts (explicitly out-of-scope).
- `README.md` now links `docs/INFRASTRUCTURE.md` and `.agents/AGENTS.md` while retaining outdated `docker-compose.yml` / `docker-compose.swarm.yml` instructions (`DRIFT` noted in `docs/INFRASTRUCTURE.md` §1.1); whether `swagger.yaml`, `HANDOFF.md`, and `DEMO_SCRIPT.md` remain intentionally frozen or should be refreshed is open.
- Production MongoDB Atlas backup/restore, GCP VPC/IAM audit, `rental-test` DNS/wildcard cleanup, `/api-docs` exposure verification, and live `/img/*` cache headers remain `TODO` in `docs/INFRASTRUCTURE.md` §12.

---

## 5. Confirmed Architecture & Constraints

- **Stack:** Node.js (`>=24.22 <25`) + Express + MongoDB/Mongoose + Socket.IO + RabbitMQ (`amqplib`) + Cloudinary + React 18 + Vite 8 + Bootstrap + Leaflet + SweetAlert2 + CKEditor 5.
- **Local Runtime:** `.\start-all.ps1` starts MongoDB (if loopback), RabbitMQ, `backend/server.js`, `frontend` (Vite port `3000`), and `notification-worker/worker.js` using root `.env` (no Docker needed locally).
- **Production Deployment & Security Baseline (`VERIFIED` per `docs/INFRASTRUCTURE.md`, 2026-11-27):**
  - **Host & URL:** `https://rental.thanquocthinh.id.vn` on GCP Linux VM (`rental-vps`, `/opt/Rental-P2P-MVP`), deployed via `/opt/Rental-P2P-MVP/deploy.sh` + `docker-compose.prod.yml` + `.env.prod`.
  - **Containers & Networking:** 5 containers on internal Docker bridge `app-network` (`rental_p2p_nginx`, `rental_p2p_cloudflared`, `rental_p2p_backend`, `rental_p2p_worker`, `rental_p2p_rabbitmq`) with zero host-published app ports.
  - **Ingress & Proxy:** Public traffic strictly via Cloudflare Tunnel `rentalhub-production` (ingress v4) → `http://nginx:80` (`nginx/nginx.tunnel.conf`, `client_max_body_size 10m`, real client IP via `CF-Connecting-IP` + Express `trust proxy = 1`; proxies `/api/` and `/socket.io/` to `backend:5000` so `/api-docs` is not proxied by `nginx.tunnel.conf`).
  - **Admin Access & Firewall:** SSH strictly via Google Cloud IAP (`35.235.240.0/20`) + key auth + UFW default-deny; Certbot host timer/cron disabled.
  - **External Services & Edge Security:** MongoDB Atlas (`MONGO_URI`), Cloudinary (`CLOUDINARY_*`), SMTP over 587/465 (GCP blocks outbound TCP 25); 2 Active Cloudflare WAF Custom Rules (scanner paths, non-standard ports) + 1 Active Rate Limiting Rule (`/api/auth/login`, `/api/auth/register`).
- **Automated Tests:** Backend runs `node --test tests/*.test.js` (`ekyc.test.js`, `itemModeration.test.js`, `itemAvailability.test.js`, `disputeSyncAudit.test.js`); `frontend/package.json` has no `test` script after Vite migration.
