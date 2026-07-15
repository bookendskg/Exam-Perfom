-- Multi-tenancy (SaaS §2, §7).
--
-- Turns the single-tenant Bookends portal into a shared-database, tenant-scoped
-- one. Every table that held customer data gains a tenant_id, and every global
-- unique constraint becomes unique-per-tenant instead.
--
-- WRITTEN BY HAND, not taken as-is from `prisma migrate dev`. The generated
-- version adds tenant_id as `UUID NOT NULL` in a single statement, which fails
-- outright on any table that already has rows — i.e. on the live Bookends
-- database with its ~300 employees. The safe shape is: add nullable, backfill,
-- then constrain.
--
-- Existing rows are adopted by an anchor tenant ("bookends") created below, so
-- the current deployment keeps working with its data intact.

-- ---------------------------------------------------------------------------
-- 1. Platform-level tables
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'suspended');

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(50) NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "price_monthly_inr" DECIMAL(10,2),
    "price_monthly_usd" DECIMAL(10,2),
    "price_annual_inr" DECIMAL(10,2),
    "price_annual_usd" DECIMAL(10,2),
    "max_employees" INTEGER,
    "max_outlets" INTEGER,
    "max_exams_per_month" INTEGER,
    "max_questions" INTEGER,
    "max_storage_gb" DECIMAL(5,2),
    "question_types" TEXT[],
    "auto_scheduling" BOOLEAN NOT NULL DEFAULT false,
    "max_languages" INTEGER DEFAULT 1,
    "pdf_export" BOOLEAN NOT NULL DEFAULT false,
    "excel_export" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_notifications" BOOLEAN NOT NULL DEFAULT false,
    "ai_insights" BOOLEAN NOT NULL DEFAULT false,
    "custom_branding" BOOLEAN NOT NULL DEFAULT false,
    "custom_domain" BOOLEAN NOT NULL DEFAULT false,
    "api_access" BOOLEAN NOT NULL DEFAULT false,
    "data_retention_months" INTEGER NOT NULL DEFAULT 6,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "plan_id" UUID,
    "subscription_status" "SubscriptionStatus" NOT NULL DEFAULT 'trialing',
    "trial_ends_at" TIMESTAMPTZ(6),
    "employee_code_prefix" VARCHAR(10) NOT NULL DEFAULT 'EMP',
    "owner_name" VARCHAR(200),
    "owner_email" VARCHAR(255) NOT NULL,
    "owner_phone" VARCHAR(15),
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
    "default_language" "Language" NOT NULL DEFAULT 'en',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "suspended_at" TIMESTAMPTZ(6),
    "suspended_reason" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_usage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "billing_period" VARCHAR(7) NOT NULL,
    "active_employees" INTEGER NOT NULL DEFAULT 0,
    "active_outlets" INTEGER NOT NULL DEFAULT 0,
    "total_questions" INTEGER NOT NULL DEFAULT 0,
    "exams_conducted" INTEGER NOT NULL DEFAULT 0,
    "storage_bytes" BIGINT NOT NULL DEFAULT 0,
    "whatsapp_messages" INTEGER NOT NULL DEFAULT 0,
    "ai_requests" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_usage_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 2. Seed the plans and the anchor tenant
--
-- Inline rather than left to the seed script: the backfill below cannot run
-- without a tenant to point at, and a migration that depends on a separate
-- script having been run first is a migration that fails in production.
--
-- No ON CONFLICT: both tables are created empty a few statements above, so
-- there is nothing to conflict with — and their unique indexes are not built
-- until section 6, which makes an ON CONFLICT inference fail outright (42P10).
-- ---------------------------------------------------------------------------

INSERT INTO "plans" ("name", "code", "price_monthly_inr", "price_monthly_usd", "max_employees", "max_outlets", "max_exams_per_month", "max_questions", "question_types", "auto_scheduling", "max_languages", "whatsapp_notifications", "ai_insights", "custom_branding", "data_retention_months", "sort_order")
VALUES
  ('Starter',      'starter',      2999, 39,   50,   1,    2,    500,  ARRAY['mcq'],                        false, 1,    false, false, false, 6,   1),
  ('Professional', 'professional', 7999, 99,   300,  5,    NULL, 5000, ARRAY['mcq','theory'],               true,  3,    true,  false, true,  24,  2),
  ('Enterprise',   'enterprise',   NULL, NULL, NULL, NULL, NULL, NULL, ARRAY['mcq','theory','video_image'], true,  NULL, true,  true,  true,  999, 3);

-- Bookends is the anchor customer (§1.2), on Professional: 300 employees and
-- 3 outlets fit that tier, and it is the one that unlocks the auto-scheduling
-- (§7) the portal already implements.
INSERT INTO "tenants" ("name", "slug", "plan_id", "subscription_status", "employee_code_prefix", "owner_email", "updated_at")
SELECT 'Bookends Hospitality', 'bookends', p."id", 'active', 'BK', 'admin@bookendshospitality.com', NOW()
  FROM "plans" p
 WHERE p."code" = 'professional';

-- ---------------------------------------------------------------------------
-- 3. Add tenant_id everywhere — nullable for now, so populated tables accept it
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "certificates" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "designations" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "employee_skills" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "employee_timeline" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "exam_assignments" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "exam_code_counters" DROP CONSTRAINT "exam_code_counters_pkey";
ALTER TABLE "exam_code_counters" ADD COLUMN "tenant_id" UUID;

-- AlterTable
ALTER TABLE "exam_questions" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "exam_responses" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "exam_schedule_config" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "exam_sessions" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "exam_templates" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "exams" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "outlet_departments" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "outlets" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "performance_snapshots" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "question_reviews" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "rewards" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "settings" DROP CONSTRAINT "settings_pkey";
ALTER TABLE "settings" ADD COLUMN "tenant_id" UUID;

-- AlterTable
ALTER TABLE "source_documents" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "supervisor_remarks" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "topics" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "training_assignments" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "user_sessions" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tenant_id" UUID;

-- ---------------------------------------------------------------------------
-- 4. Backfill: every existing row belongs to the anchor tenant
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  anchor_id UUID;
BEGIN
  SELECT "id" INTO anchor_id FROM "tenants" WHERE "slug" = 'bookends';
  IF anchor_id IS NULL THEN
    RAISE EXCEPTION 'Anchor tenant missing; cannot backfill tenant_id';
  END IF;

    UPDATE "audit_logs" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "certificates" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "departments" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "designations" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "employee_skills" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "employee_timeline" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "employees" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "exam_assignments" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "exam_code_counters" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "exam_questions" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "exam_responses" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "exam_schedule_config" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "exam_sessions" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "exam_templates" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "exams" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "notifications" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "outlet_departments" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "outlets" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "performance_snapshots" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "question_reviews" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "questions" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "rewards" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "settings" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "source_documents" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "supervisor_remarks" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "topics" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "training_assignments" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "user_sessions" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
    UPDATE "users" SET "tenant_id" = anchor_id WHERE "tenant_id" IS NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Now that every row has one, make it required
-- ---------------------------------------------------------------------------

ALTER TABLE "audit_logs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "certificates" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "departments" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "designations" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "employee_skills" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "employee_timeline" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "employees" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "exam_assignments" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "exam_code_counters" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "exam_questions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "exam_responses" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "exam_schedule_config" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "exam_sessions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "exam_templates" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "exams" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "notifications" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "outlet_departments" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "outlets" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "performance_snapshots" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "question_reviews" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "questions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "rewards" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "settings" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "source_documents" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "supervisor_remarks" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "topics" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "training_assignments" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "user_sessions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "users" ALTER COLUMN "tenant_id" SET NOT NULL;

ALTER TABLE "exam_code_counters" ADD CONSTRAINT "exam_code_counters_pkey" PRIMARY KEY ("tenant_id", "period");
ALTER TABLE "settings" ADD CONSTRAINT "settings_pkey" PRIMARY KEY ("tenant_id", "key");

-- ---------------------------------------------------------------------------
-- 6. Replace global unique constraints with per-tenant ones
--
-- These DROPs are the point of the whole exercise: "AK", "KIT" and phone
-- 9876543210 belong to a tenant, not to the platform. Two customers must be
-- able to use the same outlet code, and one person may legitimately work for
-- both (§24.1).
-- ---------------------------------------------------------------------------

-- DropIndex
DROP INDEX "certificates_certificate_number_key";

-- DropIndex
DROP INDEX "departments_code_key";

-- DropIndex
DROP INDEX "designations_code_key";

-- DropIndex
DROP INDEX "employees_employee_code_key";

-- DropIndex
DROP INDEX "exams_exam_code_key";

-- DropIndex
DROP INDEX "outlets_code_key";

-- DropIndex
DROP INDEX "users_email_key";

-- DropIndex
DROP INDEX "users_phone_key";

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_slug_idx" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_usage_tenant_id_billing_period_key" ON "tenant_usage"("tenant_id", "billing_period");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_idx" ON "audit_logs"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "certificates_tenant_id_idx" ON "certificates"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_tenant_id_certificate_number_key" ON "certificates"("tenant_id", "certificate_number");

-- CreateIndex
CREATE INDEX "departments_tenant_id_idx" ON "departments"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_code_key" ON "departments"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "designations_tenant_id_idx" ON "designations"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "designations_tenant_id_code_key" ON "designations"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "employee_skills_tenant_id_idx" ON "employee_skills"("tenant_id");

-- CreateIndex
CREATE INDEX "employee_timeline_tenant_id_idx" ON "employee_timeline"("tenant_id");

-- CreateIndex
CREATE INDEX "employees_tenant_id_outlet_id_idx" ON "employees"("tenant_id", "outlet_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_tenant_id_employee_code_key" ON "employees"("tenant_id", "employee_code");

-- CreateIndex
CREATE INDEX "exam_assignments_tenant_id_employee_id_idx" ON "exam_assignments"("tenant_id", "employee_id");

-- CreateIndex
CREATE INDEX "exam_questions_tenant_id_idx" ON "exam_questions"("tenant_id");

-- CreateIndex
CREATE INDEX "exam_responses_tenant_id_idx" ON "exam_responses"("tenant_id");

-- CreateIndex
CREATE INDEX "exam_schedule_config_tenant_id_idx" ON "exam_schedule_config"("tenant_id");

-- CreateIndex
CREATE INDEX "exam_sessions_tenant_id_idx" ON "exam_sessions"("tenant_id");

-- CreateIndex
CREATE INDEX "exam_templates_tenant_id_idx" ON "exam_templates"("tenant_id");

-- CreateIndex
CREATE INDEX "exams_tenant_id_scheduled_date_idx" ON "exams"("tenant_id", "scheduled_date");

-- CreateIndex
CREATE UNIQUE INDEX "exams_tenant_id_exam_code_key" ON "exams"("tenant_id", "exam_code");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_user_id_is_read_idx" ON "notifications"("tenant_id", "user_id", "is_read");

-- CreateIndex
CREATE INDEX "outlet_departments_tenant_id_idx" ON "outlet_departments"("tenant_id");

-- CreateIndex
CREATE INDEX "outlets_tenant_id_idx" ON "outlets"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "outlets_tenant_id_code_key" ON "outlets"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "performance_snapshots_tenant_id_employee_id_year_month_idx" ON "performance_snapshots"("tenant_id", "employee_id", "year", "month");

-- CreateIndex
CREATE INDEX "question_reviews_tenant_id_idx" ON "question_reviews"("tenant_id");

-- CreateIndex
CREATE INDEX "questions_tenant_id_type_department_id_idx" ON "questions"("tenant_id", "type", "department_id");

-- CreateIndex
CREATE INDEX "rewards_tenant_id_idx" ON "rewards"("tenant_id");

-- CreateIndex
CREATE INDEX "source_documents_tenant_id_idx" ON "source_documents"("tenant_id");

-- CreateIndex
CREATE INDEX "supervisor_remarks_tenant_id_idx" ON "supervisor_remarks"("tenant_id");

-- CreateIndex
CREATE INDEX "topics_tenant_id_idx" ON "topics"("tenant_id");

-- CreateIndex
CREATE INDEX "training_assignments_tenant_id_idx" ON "training_assignments"("tenant_id");

-- CreateIndex
CREATE INDEX "user_sessions_tenant_id_idx" ON "user_sessions"("tenant_id");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_phone_key" ON "users"("tenant_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- ---------------------------------------------------------------------------
-- 7. Foreign keys
-- ---------------------------------------------------------------------------

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_usage" ADD CONSTRAINT "tenant_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_code_counters" ADD CONSTRAINT "exam_code_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_timeline" ADD CONSTRAINT "employee_timeline_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designations" ADD CONSTRAINT "designations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_departments" ADD CONSTRAINT "outlet_departments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_reviews" ADD CONSTRAINT "question_reviews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_templates" ADD CONSTRAINT "exam_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_assignments" ADD CONSTRAINT "exam_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_schedule_config" ADD CONSTRAINT "exam_schedule_config_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_responses" ADD CONSTRAINT "exam_responses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_remarks" ADD CONSTRAINT "supervisor_remarks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
