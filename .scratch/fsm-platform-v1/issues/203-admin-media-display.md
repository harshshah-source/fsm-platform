# 203 — Admin can display uploaded media (the voucher lightbox is broken)

Status: ready-for-agent
Type: AFK · Admin
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04
Blocked by: nothing — [#81](./81-media-upload-api.md) shipped the endpoint

## Root cause

#81 changed `photoRef` from a URL-shaped value into an opaque `media_objects` row id and explicitly
did not touch the consuming surfaces. The admin voucher reviewer still passes that value straight
into an `<img src>`, so every photo a mobile SE uploads renders as a broken image. The endpoint that
exists precisely for this — `GET /api/media/:id`, already role-scoped to the reviewer roles — has
**zero callers anywhere in `apps/admin/src`**, and could not be used naively anyway because an
`<img>` tag cannot send an `Authorization` header.

## Findings closed

Audit 2 **A3**. New: **N6** (#38's photo-lightbox AC silently broken).

## Evidence — verified 2026-08-04

- `apps/admin/src/pages/vouchers/VoucherReviewPage.tsx:128` — `onClick={() => setLightbox(it.photoRef)}`
  and `:291` — `<img src={lightbox} alt="Expense proof" …>`. `lightbox` is `string | null`, set only
  from `it.photoRef`.
- `apps/backend/src/media/media.controller.ts:82` — upload returns `{ photoRef: created.mediaId, … }`;
  `media.service.ts:38-40` confirms `mediaId` is the `media_objects` primary key.
- The endpoint exists and is correctly scoped: `media.controller.ts:85-94` — `GET /media/:id`,
  `@Roles('SERVICE_ENGINEER','ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD')`
  (`REVIEW_ROLES`, `:32`), returns a `StreamableFile`.
- **No admin media client exists** — there is no `apps/admin/src/api/media.ts` among its 37 API
  modules, and no fetch of `/media/` anywhere in the app.
- Even a constructed URL fails: `apps/backend/src/common/guards/auth.guard.ts:42-49` requires
  `Authorization: Bearer`, which `<img src>` cannot send. Admin tokens live in `sessionStorage`
  (`apps/admin/src/api/tokens.ts:6-15`) and are attached per-fetch.
- **This is a spec violation, not a gap.** `PRD:459` — "photo thumbnails with **full-screen
  lightbox**"; `workflow:1295-1301` makes "**Photo proof is present and legible**" one of the four
  things a ZM must check; `workflow:1288` makes at least one photo mandatory before submission.
- `#38`'s AC `[x] ZM review shows … photo lightbox` was true when written and is now false — recorded
  in place on #38.

## Scope

**In:** an authenticated media fetch in the admin app (blob → object URL, revoked on unmount), wired
into the voucher review lightbox; loading and error states so a missing or forbidden object reads as
such rather than as a broken image icon.

**Out:** changing the wire format (`photoRef` stays an opaque id — that is #81's ratified design).
Signed/pre-authenticated URLs — a reasonable alternative, but it is a backend design change and
should be its own decision if the blob approach proves awkward. Verification and Install photo
surfaces: same fix shape, but neither renders photos today, so they are follow-on work, not a
regression — note them rather than build them here.

## Acceptance criteria

- [ ] A voucher submitted from mobile with a receipt photo renders that photo in the admin lightbox
- [ ] The fetch sends the reviewer's bearer token; a 403 renders an explicit "not permitted" state
      and a 404 an explicit "image unavailable" state — neither is a silent broken image
- [ ] Object URLs are revoked when the lightbox closes (no blob leak across repeated opens)
- [ ] `#38`'s photo AC is re-verifiable — i.e. the AC that was silently broken is true again
- [ ] Regression test asserting the lightbox requests `/media/:id` with an Authorization header.
      **Cheap** — `VoucherReviewPage` already has a test file and the admin suite mocks fetch

## Verification

```bash
cd apps/admin && npx vitest run src/pages/vouchers
```
Plus end-to-end against the #210 dataset: submit a voucher with a photo from the handset, open it as
`zm.north@fsm.test` in the admin voucher queue, and confirm the image renders.

## Risk if deferred

The ZM voucher-review workflow is specified around checking the receipt, and the receipt is exactly
what does not render. Approvals are therefore being made blind, or rejected for a missing photo that
was in fact uploaded — a direct financial-control failure, and one that will be blamed on the mobile
app because that is where the photo was taken.

## Size estimate

S. One small API module plus a hook; the endpoint, the roles and the storage all already exist.
