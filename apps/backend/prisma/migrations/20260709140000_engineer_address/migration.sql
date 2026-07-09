-- Phase 4 (SE Management) — admin-entered SE contact address on the SE profile.
-- Nullable free text; existing rows default to NULL. Identity/contact for RBAC (name/phone/email) stay
-- on `users`; this is the one non-RBAC SE-profile field the admin CRUD adds.
ALTER TABLE "engineer_master" ADD COLUMN "address" TEXT;
