# 81 — Media Upload API (photo references for mobile capture)

Status: ready-for-agent — D-12 settled 2026-08-03 (see Comments): Postgres-backed for the pilot,
storage fully hidden behind the `photoRef` seam; multipart upload, not presign
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

### 2026-07-28 — #172 decision 6 ratified: slots are in the contract

Confirmed against the images. `photoRef` **must carry slot/kind semantics**:
Troubleshoot has **4** named slots (`Before`, `After`, `Part`, `Plate`), Vouchers has **3**
(`Receipt`, `Photo`, `Bill`), Install has 1 unnamed. The PRD's unstructured "photo refs" wording is
overridden. A flat `string[]` cannot express any of this, and retrofitting slots onto a shipped flat
array is a breaking change for every photo screen.

### 2026-08-03 — D-12 SETTLED: Postgres-backed storage for the pilot, behind an opaque seam

**Operator decision, recorded so it does not reopen.**

**Storage.** Photo bytes go in the **existing FSM Postgres** for the pilot, with a **planned move to
a separate media instance before rollout**. Not object storage for now: #111 (deployment
packaging) is unbuilt, so no deployment target exists, and picking a storage service ahead of that
is the wrong order. The team's preference for a separate instance is **accepted as the eventual
shape — this is sequencing, not disagreement.** The reasoning: the benefit of a separate store
(backup/restore size, disk headroom) scales with volume we don't have yet, while its cost —
cross-database orphan handling when a blob write succeeds and its form write fails — lands on day
one regardless. Single-DB keeps blob + `media_objects` row + (later) form linkage inside one
transactional boundary for the pilot.

**Mechanism follows from the decision:** the issue body's two alternatives resolve to
**`POST /api/media/upload` multipart → `{ photoRef }`** (there is nothing to presign against).
The presign section above is superseded; do not implement both.

**Upload contract — the seam is load-bearing for the whole decision.** The endpoint must fully hide
the storage backend: the app sends a file, receives an opaque `photoRef`, and learns **nothing**
about where bytes live (no URLs, no storage keys, no backend hints in the ref format). This opacity
is what makes the later move — separate instance, or object storage — an infra change with **zero
mobile impact**. Any leak of storage detail into the contract converts the planned move into a
client-breaking change, which (per #170's no-OTA decision) means manual reinstall across the fleet.

**Slots — the irreversible part.** Carry the #172 Decision 6 slot semantics from day one:
troubleshoot 4 named slots (`Before`/`After`/`Part`/`Plate`), vouchers 3 (`Receipt`/`Photo`/`Bill`),
install 1 unnamed. Today's flat `string[]` cannot express this, and retrofitting after the client
ships breaks every photo screen on every handset. **Storage location is reversible; the slot-bearing
contract shape is not.** Get the second one right.

**Client-side compression.** Target a few hundred KB per photo, not multi-MB — this matters *more*
under this decision, since bytes now traverse the API and land in Postgres. It belongs on **mobile,
not backend** (PRD:311 already mandates client-side compression for the offline queue). No new
issue: it rides on the capture work — #54's `PhotoCaptureRow` kit primitive and the #58/#61 form
ACs. Backend enforces a hard `FILE_TOO_LARGE` cap as the backstop, per the existing AC.

**Verified while recording (2026-08-03):**
- **Nothing in the repo assumes S3-presign semantics.** Grep across `apps/backend/src`,
  `apps/mobile/src`, `packages/`, `.env.example`: zero presign/aws-sdk/S3 hits (the only "S3"
  matches are #91's *slice-3* naming in auth files). The presign assumption lived only in this
  issue's own body text and the old CLAUDE.md line. **CLAUDE.md's contradiction (recommends S3
  presign vs "no S3 in the current stack") is resolved by this decision** — the current stack
  stays S3-free.
- **Retention/audit for expense-claim photos: nothing is recorded anywhere.** Every retention
  mention in PRD/CONTEXT/workflow is *client-side* offline-queue cache (PRD:311, :750, :775 —
  local copies removed after upload, 7–15-day ticket cache). ZM review requires thumbnails +
  lightbox (PRD:459) and Finance export validation (PRD:134), which implies server-side persistence
  at least through review — but **no server-side retention period or audit requirement exists in
  the written record. Open product question, not an assumed "none":** how long must voucher-proof
  photos be retrievable after PAID, and do they fall under any finance-audit retention rule?
  Owner: product/finance.
