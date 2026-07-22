-- CreateTable
CREATE TABLE "user_outlets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_outlets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_outlets_user_id_idx" ON "user_outlets"("user_id");

-- CreateIndex
CREATE INDEX "user_outlets_outlet_id_idx" ON "user_outlets"("outlet_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_outlets_user_id_outlet_id_key" ON "user_outlets"("user_id", "outlet_id");

-- AddForeignKey
ALTER TABLE "user_outlets" ADD CONSTRAINT "user_outlets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_outlets" ADD CONSTRAINT "user_outlets_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: give every existing trainer the outlet they work at.
--
-- This is not cosmetic. A later migration narrows `trainer` from `all` to
-- `own_outlet` on employee/question/exam/grading reads, and the route gate
-- returns 403 the moment an `own_outlet` scope resolves to the empty set. Any
-- trainer without a row here would therefore be locked out of every read the
-- instant the permission matrix is re-seeded.
--
-- Employee.outletId is a singular "where they work", whereas §3.1 says a trainer
-- may cover several outlets. So this is a floor, not the final answer: it
-- guarantees nobody is denied on day one, and administrators widen it from
-- there through PUT /outlets/:id.
--
-- Trainers with no Employee row get nothing and must be assigned by hand; the
-- NOTICE below names them rather than letting them fail silently later.
INSERT INTO "user_outlets" ("user_id", "outlet_id")
SELECT u."id", e."outlet_id"
  FROM "users" u
  JOIN "employees" e ON e."user_id" = u."id"
 WHERE u."role" = 'trainer'
   AND u."is_active" = true
ON CONFLICT ("user_id", "outlet_id") DO NOTHING;

DO $$
DECLARE
  unassigned INT;
BEGIN
  SELECT COUNT(*) INTO unassigned
    FROM "users" u
   WHERE u."role" = 'trainer'
     AND u."is_active" = true
     AND NOT EXISTS (SELECT 1 FROM "user_outlets" o WHERE o."user_id" = u."id");

  IF unassigned > 0 THEN
    RAISE WARNING
      'user_outlets backfill: % active trainer(s) have no employee record and therefore no outlet assignment. Assign them via PUT /outlets/:id before narrowing the permission matrix, or they will be denied every read.',
      unassigned;
  END IF;
END $$;
