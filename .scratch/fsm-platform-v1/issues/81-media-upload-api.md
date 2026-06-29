# 81 — Media Upload API (photo references for mobile capture)

Status: ready-for-agent
Type: AFK · Backend

## Business purpose

Every mobile capture flow that carries a photo submits a **string `photoRef`**, never a blob —
troubleshoot (`photoRefs: string[]`), expense voucher (`items[].photoRef`), and install
(`fitted.photoRef`). There is currently **no endpoint that turns a captured image into a `photoRef`**,
so those photo legs cannot be built. This issue owns the upload seam that produces the `photoRef`
consumed by Issues 58, 61, 71.

## PRD references

- §485 (Troubleshooting Form — photo refs), §493 (Expense Voucher — photo proof, ≥1 required),
  §562 (Install Form — installation photo), §307 (offline-first: photos compressed, stored as local
  file refs, uploaded on sync).

## Workflow references

- `fsm-business-technical-workflow.md` — field photo capture during troubleshoot/install/voucher.
- CLAUDE.md — object storage is **S3**.

## API specification

Recommended pattern (S3 presign — aligns with CLAUDE.md; no image bytes through the API):

- `POST /api/media/presign` — body `{ kind: 'TROUBLESHOOT'|'VOUCHER'|'INSTALL', contentType }` →
  `{ uploadUrl, photoRef }`. The client PUTs the compressed image to `uploadUrl`, then submits
  `photoRef` on the owning form.
- (Alternative if presign is rejected: `POST /api/media/upload` multipart → `{ photoRef }`. Pick one;
  do not implement both.)
- `photoRef` is an opaque server-owned string; the existing form endpoints already accept it as-is.

> No business logic beyond "produce a referenceable, retrievable photo id." The mechanism (presign vs
> direct) is an architecture decision, not a new feature.

## Acceptance criteria

- [ ] An SE can obtain a `photoRef` for a captured image via the chosen mechanism
- [ ] The `photoRef` returned is accepted unchanged by `/tickets/:id/troubleshoot`, `/vouchers`, `/install/:id/fitted`
- [ ] Stored media is retrievable for the admin review surfaces (voucher lightbox, verification, install)
- [ ] RBAC: SERVICE_ENGINEER may upload; references are scoped so an SE cannot read another SE's unsubmitted media

## Validation & error codes

- `INVALID_CONTENT_TYPE` (non-image), `FILE_TOO_LARGE` (over the configured cap), `INVALID_KIND` (400).

## Permissions

- Upload: SERVICE_ENGINEER. Read of submitted media: the owning SE + manager/WM review roles per the consuming feature.

## Dependencies

- #01 (auth/RBAC, S3 config). Consumed by #58, #61, #71.

## Test plan (TDD)

- presign returns a usable `uploadUrl` + `photoRef`; oversized/non-image → respective 400s.
- a `photoRef` round-trips through troubleshoot/voucher/install submit unchanged.
- an SE cannot read another SE's unsubmitted media (RBAC).

## TDD implementation notes

- Start with the contract test (presign shape) red, then the RBAC test, then retrieval. Keep image
  bytes out of the API surface if using presign. No changes to the consuming form contracts.

## Blocked by

- #01
