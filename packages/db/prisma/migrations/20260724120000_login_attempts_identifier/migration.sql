-- Login now accepts an email or a phone number, so the lockout store must be
-- able to key on either. A RENAME (not drop+add) preserves the in-flight
-- rate-limit rows and widens the column from a phone's 15 chars to an email's.
ALTER TABLE "login_attempts" RENAME COLUMN "phone" TO "identifier";
ALTER TABLE "login_attempts" ALTER COLUMN "identifier" SET DATA TYPE VARCHAR(255);

-- Keep the index names aligned with the new column, so Prisma does not try to
-- drop and recreate them on the next migration.
ALTER INDEX "login_attempts_phone_attempted_at_idx" RENAME TO "login_attempts_identifier_attempted_at_idx";
ALTER INDEX "login_attempts_phone_ip_key_attempted_at_idx" RENAME TO "login_attempts_identifier_ip_key_attempted_at_idx";
