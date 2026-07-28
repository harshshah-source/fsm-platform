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

## Comments

### 2026-07-28 — photo slots are a contract fact, not an implementation detail (freeze plan F2.7)

The reference images show **named slots**, which a flat `string[]` cannot express:

- `troubleshooting.png` — **4 labelled slots**: `Before`, `After`, `Part`, `Plate`, marked *Proof*.
  Today `photoRefs?: string[]` (`ticketing/troubleshoot.controller.ts:42`) is an unordered array of
  opaque strings with no slot semantics and no count cap.
- `vouchers.png` — **3 labelled document types**: `Receipt`, `Photo`, `Bill`, marked *Required*.
  Today one `photoRef` per item (`vouchers.controller.ts:47`).
- Install — one unnamed `photoRef`.

Note the spec conflict (**#172** item 7): PRD §513.4 says unstructured "photo refs" and §597.3 says
"at least 1 photo", while the images specify named roles. Resolve there before freezing the shape.

+1 AC: **the `photoRef` contract carries slot/kind semantics** for each consuming form, and the
consuming form endpoints validate against the expected set. Retrofitting slots onto a shipped flat
array is a breaking change for every photo screen.

Also still open and now blocking: the storage mechanism decision (D-12). This issue's body assumes
S3 presign citing CLAUDE.md, but **CLAUDE.md now states there is no S3 in the current stack**
(no Redis/BullMQ/S3). Pick presign-against-an-object-store or local-disk multipart behind the same
seam — the `photoRef` contract stays stable either way.
