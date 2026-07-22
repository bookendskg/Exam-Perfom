-- CreateTable
CREATE TABLE "login_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" VARCHAR(15) NOT NULL,
    "ip_key" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'login',
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_attempts_phone_attempted_at_idx" ON "login_attempts"("phone", "attempted_at");

-- CreateIndex
CREATE INDEX "login_attempts_phone_ip_key_attempted_at_idx" ON "login_attempts"("phone", "ip_key", "attempted_at");

-- CreateIndex
CREATE INDEX "login_attempts_attempted_at_idx" ON "login_attempts"("attempted_at");
