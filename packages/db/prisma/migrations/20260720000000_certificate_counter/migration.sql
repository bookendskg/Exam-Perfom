-- Certificate numbering (§4.1, §12).
--
-- A counter, not COUNT(*)+1 — the same reasoning as exam_code_counters, and it
-- matters more here: a certificate number is a claim an employee makes to a
-- future employer, so two people holding CERT-2026-0007 is unfixable after the
-- fact. Concurrent issuers reading the same count would mint the same number,
-- and revoking a certificate must not free its number for reuse.
--
-- Keyed (tenant_id, year): numbers run annually per §4.1, and every tenant has
-- its own sequence starting at 1.

-- CreateTable
CREATE TABLE "certificate_counters" (
    "tenant_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "last_seq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "certificate_counters_pkey" PRIMARY KEY ("tenant_id","year")
);

-- AddForeignKey
ALTER TABLE "certificate_counters" ADD CONSTRAINT "certificate_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

