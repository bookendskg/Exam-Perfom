-- Platform-level identity and audit (SaaS §6.1, §10, §20.2).
--
-- Purely additive: two new tables and an enum. Nothing existing is altered, so
-- unlike the multi-tenancy migration there is no populated-table hazard here.
--
-- WHY A SEPARATE TABLE, not a flag on `users`:
--   A platform admin can read and suspend EVERY tenant. A tenant user must
--   never become one by accident. Sharing a table means one missed WHERE turns
--   a customer's admin into a platform operator — so they share no table, no
--   role enum, and no JWT secret (PLATFORM_JWT_SECRET, §21.3). A tenant token
--   cannot authenticate here even if the middleware is wired up wrong: the
--   signature simply does not verify.
--
-- WHY platform_audit_logs.target_tenant_id IS NOT NAMED tenant_id:
--   The tenant extension derives what it scopes from the presence of a
--   `tenantId` field (packages/db/src/tenant.ts). Naming this column tenant_id
--   would enrol the table automatically — and then the platform admin reading
--   their own audit trail would be filtered to a tenant they do not belong to,
--   i.e. would see nothing. The name is load-bearing. Verified: the extension
--   reports 30 scoped models and this is not one of them.

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('super_admin', 'support', 'finance');

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_id" UUID,
    "target_tenant_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "details" JSONB,
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE INDEX "platform_audit_logs_target_tenant_id_created_at_idx" ON "platform_audit_logs"("target_tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "platform_audit_logs_admin_id_idx" ON "platform_audit_logs"("admin_id");

-- CreateIndex
CREATE INDEX "platform_audit_logs_action_idx" ON "platform_audit_logs"("action");

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

