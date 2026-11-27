# RentHub UI/UX designer brief

## Assignment

Create **three distinct Style Exploration Boards** for RentHub, a Vietnamese peer-to-peer marketplace for renting personal items. Each board should use the same components, screens, Vietnamese copy, example data and transaction states so the Founder can compare visual directions and select one. The deliverable is visual exploration at concept fidelity. Production code and full-site design come after Founder review.

Aim for a modern, professional, easy-to-understand marketplace that feels trustworthy without being intimidating. The experience should be visually consistent, accessible and responsive. Existing colors, layouts and branding treatments are open to exploration. Use **RentHub** as the working name.

## Product and people

- **Guests** want to find the right item, understand price and availability, and assess the person renting it out. They can search, browse listings and read public profiles and reviews.
- **Renters** want to reserve an available item, know what they owe, coordinate pickup and return, and understand who needs to act next.
- **Owners** want to list an item, control its availability, assess a request, and document the item’s condition. One member can be both a renter and an owner.
- **Admins** moderate users and listings, review item reports, and decide rental disputes with photos and read-only rental chat. Admin tools are part of the product and can inherit the selected visual direction later.

The value proposition is short-term access to useful items without buying them and income from belongings owners already have. Cameras, camping gear and tools are representative categories. Device preferences and priority demographic segments remain open.

## Verified journeys to preserve

1. **Discover.** Browse **Trang chủ** or **Cửa hàng**. Search by name, category, location/address and dates. The nearby map supports a selected point and radius. Open listing photos, description, daily price, deposit, busy dates, item reviews and the owner’s trust summary. Signed-in members can save favorites.
2. **Prepare and request.** The renter chooses dates and can add a note. Own items are ineligible. Booking and new listings require identity verification. The web also asks for bank name, account number and account holder before booking or posting/editing. A request is created before the renter pays the rental fee plus deposit via VNPay. Success means the request is waiting for the owner. The payment result links to rental management for eligible retries and to Shop to continue browsing. The listing form reports unavailable dates where detected before submission.
3. **Accept and sign.** The owner accepts or rejects a paid request. Acceptance requires both parties to be verified and creates the electronic contract. Each signs individually, with an explicit waiting state after the first signature. Neither party can record pickup until both have signed. **Quản lý đơn thuê** groups **Tôi đang thuê**, **Yêu cầu thuê đồ** and **Sản phẩm của tôi** under the same account.
4. **Pick up and return.** Participants use order-specific text chat. At each handover one party submits a photo-backed condition report. The report can include accessories and notes, with damage details at return. The other party views the report, can edit it, and must confirm it. Preserve the distinctions between recording, waiting for the counterpart, review/edit and approval. Pickup approval starts the rental. Return approval completes it. The system supports viewing/printing the contract and sending PDF versions after signing and completion, with a handover/return annex in the final version.
5. **Review or resolve.** Eligible parties can review each other after completion. A first review stays private until the counterpart reviews or it is released after the seven-day wait. A renter can reopen an item from a cancelled, rejected or completed order via **Thuê lại sản phẩm**. For eligible active transactions, **Báo cáo sự cố** opens a rental dispute with a reason and optional photos. Transaction actions freeze for mediation. Either participant can request admin intervention after 48 hours. The reporter can currently withdraw a pending or escalated complaint. Show the decision or restored transaction state when the case closes. **Báo cáo vi phạm** is a separate listing-level moderation action.

## Content and state rules

- Keep the lifecycle labels recognizable as **Thanh toán → Chờ xác nhận → Ký hợp đồng → Giao/Nhận đồ → Đang thuê → Hoàn tất**. Show the current state, next actor and eligible action. A saved photo report means **waiting for counterpart approval** until it is approved. Keep cancelled, rejected and disputed states distinct from normal completion.
- Separate the rental lifecycle, payment record and dispute outcome visually. Use **Chờ thanh toán**, **Chờ xác nhận**, **Đang thuê**, **Hoàn tất**, **Đang hòa giải** and **Đã yêu cầu Admin xử lý** where appropriate. Use the same state labels and examples across the three boards.
- Show fee, deposit and amount due in VND as distinct values. Normal backend pricing counts both endpoints of the date range. Refund and payout figures on the site are application records/calculations. Confirmed bank arrival, an automatic 72-hour refund, and an owner cash-out action are outside the verified experience.
- Distinguish **Xác thực danh tính (eKYC)**, a **0–100 TrustScore** and **1–5 review stars with a count**. An unrated item has its own empty state. The public profile uses a safe summary. Use fictional names, images, addresses and evidence in the boards. Reserve identity documents, banking, signed contracts and investigations for authorized contexts.
- Keep Vietnamese labels, accents, readable date formats and natural currency formatting. Provide a visible focus state, readable contrast, text in addition to color for status, touch-friendly controls, and flows that work without hover. Consider keyboard use, long labels, missing images, a narrow calendar, upload feedback and mobile keyboard overlap.

## Three boards with one common comparison set

Give each board a distinct brand personality and a deliberate approach to **color palette, Vietnamese-capable typography, iconography, hierarchy, spacing and layout**. Define colors for surface, text, primary actions, focus and feedback. Show how standard and compact content densities work. Suggested starting points are a neighborly marketplace, a photo-led catalog and a calm service-oriented interface. These prompts leave color, typography, imagery and layout choices to the Designer.

For **each** board, show the same four screen previews at desktop and narrow phone widths. Around 1440 px and 390 px are comparison samples.

| Preview | Common content and action |
| --- | --- |
| **Trang chủ** | Main search and entry to featured listings, with one example card carried through the other previews. |
| **Cửa hàng** | A search for **máy ảnh**, a selected date range, a nearby/filter control and a results grid. Show how a shopper finds and clears active filters. |
| **Chi tiết vật phẩm** | Listing gallery, location, daily price, deposit, dates, owner verification/TrustScore and item reviews. Show **Gửi yêu cầu thuê** and the cost breakdown in the booking area. |
| **Chi tiết đơn thuê** | Show an in-progress rental from the owner’s perspective. The renter has recorded the return report and the owner can review and approve it. Show timeline, role, payment summary, next action, photo evidence and chat entry. |

**Common fictional example.** Use **Máy ảnh Canon EOS M50**, **28–29/11/2026**, **180.000 đ/ngày**, **360.000 đ tiền thuê**, **600.000 đ tiền cọc**, **960.000 đ tổng thanh toán**. Use an owner with a verified badge, **TrustScore 82/100** and a separate **4,8/5 · 12 đánh giá** owner rating. Use a different item review count or an unrated item state so those signals stay distinguishable.

Add a compact set of component states to each board. Include primary/secondary and disabled/loading buttons, a date or form control with focus and validation, listing card with favorite control, verification/trust/review and transaction badges, and an evidence thumbnail with upload and failed-upload treatment. Show a no-results search with clear filters, a VNPay outcome with next step, and the waiting/approval variants of the report as small panels or annotations. Include an active dispute/mediation variant with its frozen action state. Use the same state samples across all boards.

Add two or three short notes per board explaining how the direction handles discovery, the price/date decision and a high-stakes rental action. Compare the three directions on clarity, trust, mobile use and consistency as the Founder selects one.

## Pending Founder decisions

The current web experience exposes incident reporting during confirmed and in-progress rentals. The API has additional completed-rental eligibility. Use the web baseline for the boards. Confirm the final eligibility, withdrawal cutoff, date-block handling, price-estimate wording, refund/payout policy, public phone visibility, support intake and production brand before implementation. The board scope covers in-person pickup and return, rental-scoped chat and the existing dispute process. Shipping, a general inbox, insurance, rental extensions and automated money disbursement lack verified delivery in the current web product.
