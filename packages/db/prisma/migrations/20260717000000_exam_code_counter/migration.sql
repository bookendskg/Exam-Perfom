-- CreateTable
CREATE TABLE "exam_code_counters" (
    "period" VARCHAR(7) NOT NULL,
    "last_seq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "exam_code_counters_pkey" PRIMARY KEY ("period")
);

