-- Correct the export flags on the seeded plans (§4.1).
--
-- The multi-tenancy migration's plan INSERT omitted pdf_export and
-- excel_export, so the column default (false) applied to all three tiers —
-- including Enterprise. §4.1's matrix sells "PDF + Excel export" from
-- Professional up, so this locked a paid feature nobody could reach. Nothing
-- caught it because no code read the flags until Module 11.
--
-- Idempotent and keyed on `code`: it only touches the three seeded tiers, and
-- leaves alone any plan an operator has since created or edited. Re-seeding
-- would also fix a dev database (seedPlans upserts), but a deployed one does
-- not re-seed — so the correction has to live here.

UPDATE "plans" SET "pdf_export" = true,  "excel_export" = true
 WHERE "code" IN ('professional', 'enterprise');

UPDATE "plans" SET "pdf_export" = false, "excel_export" = false
 WHERE "code" = 'starter';
