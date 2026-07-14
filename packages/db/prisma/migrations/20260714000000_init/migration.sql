-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('super_admin', 'admin', 'outlet_manager', 'trainer', 'hr', 'staff');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('en', 'hi', 'gu');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('full_time', 'part_time', 'contract', 'trainee');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('active', 'on_leave', 'suspended', 'terminated', 'resigned');

-- CreateEnum
CREATE TYPE "TimelineEventType" AS ENUM ('joined', 'training', 'exam', 'promotion', 'warning', 'award', 'transfer', 'remark', 'suspension', 'resignation', 'termination');

-- CreateEnum
CREATE TYPE "SourceDocumentType" AS ENUM ('cookbook', 'sop', 'training_manual', 'recipe', 'service_manual', 'hygiene_guide', 'other');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('mcq', 'theory', 'video_image');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('easy', 'medium', 'hard');

-- CreateEnum
CREATE TYPE "ExpectedResponseType" AS ENUM ('image', 'video', 'both');

-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('draft', 'pending_review', 'approved', 'archived');

-- CreateEnum
CREATE TYPE "ReviewAction" AS ENUM ('approved', 'rejected', 'revision_requested');

-- CreateEnum
CREATE TYPE "ExamStatus" AS ENUM ('draft', 'scheduled', 'active', 'completed', 'cancelled', 'archived');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('assigned', 'notified', 'started', 'submitted', 'graded', 'absent', 'exempted');

-- CreateEnum
CREATE TYPE "ScheduleFallbackRule" AS ENUM ('next_monday', 'previous_friday', 'next_weekday');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('image', 'video');

-- CreateEnum
CREATE TYPE "CertificateType" AS ENUM ('monthly', 'quarterly', 'yearly', 'special', 'training_completion');

-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('gold', 'silver', 'bronze', 'employee_of_month', 'special');

-- CreateEnum
CREATE TYPE "TrainingStatus" AS ENUM ('assigned', 'in_progress', 'completed', 'overdue');

-- CreateEnum
CREATE TYPE "RemarkType" AS ENUM ('positive', 'improvement', 'warning', 'general');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('exam_scheduled', 'exam_reminder', 'exam_result', 'training_assigned', 'reward_earned', 'system');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('in_app', 'push', 'whatsapp', 'email');

-- CreateEnum
CREATE TYPE "WhatsAppStatus" AS ENUM ('pending', 'sent', 'delivered', 'read', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" VARCHAR(15) NOT NULL,
    "email" VARCHAR(255),
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'staff',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "refresh_token" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "employee_code" VARCHAR(20),
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "photo_url" TEXT,
    "phone" VARCHAR(15) NOT NULL,
    "email" VARCHAR(255),
    "date_of_birth" DATE,
    "gender" "Gender",
    "address" TEXT,
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "outlet_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "designation_id" UUID NOT NULL,
    "joining_date" DATE NOT NULL,
    "employment_type" "EmploymentType" NOT NULL DEFAULT 'full_time',
    "employment_status" "EmploymentStatus" NOT NULL DEFAULT 'active',
    "preferred_language" "Language" NOT NULL DEFAULT 'en',
    "emergency_contact_name" VARCHAR(200),
    "emergency_contact_phone" VARCHAR(15),
    "emergency_contact_relation" VARCHAR(50),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_skills" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "skill_name" VARCHAR(100) NOT NULL,
    "skill_category" VARCHAR(50),
    "proficiency_level" SMALLINT NOT NULL,
    "assessed_by" UUID,
    "assessed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_timeline" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "event_type" "TimelineEventType" NOT NULL,
    "event_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_timeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "address" TEXT,
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "phone" VARCHAR(15),
    "email" VARCHAR(255),
    "manager_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outlets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "designations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "department_id" UUID,
    "level" SMALLINT NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "designations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_departments" (
    "outlet_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,

    CONSTRAINT "outlet_departments_pkey" PRIMARY KEY ("outlet_id","department_id")
);

-- CreateTable
CREATE TABLE "source_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(255) NOT NULL,
    "type" "SourceDocumentType" NOT NULL,
    "description" TEXT,
    "file_url" TEXT,
    "outlet_id" UUID,
    "department_id" UUID,
    "version" VARCHAR(20) DEFAULT '1.0',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "source_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name_en" VARCHAR(255) NOT NULL,
    "name_hi" VARCHAR(255),
    "name_gu" VARCHAR(255),
    "source_document_id" UUID,
    "parent_topic_id" UUID,
    "department_id" UUID,
    "sort_order" SMALLINT DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "QuestionType" NOT NULL,
    "difficulty" "Difficulty" NOT NULL DEFAULT 'medium',
    "topic_id" UUID,
    "department_id" UUID NOT NULL,
    "outlet_id" UUID,
    "designation_level_min" SMALLINT DEFAULT 1,
    "designation_level_max" SMALLINT DEFAULT 5,
    "question_text_en" TEXT NOT NULL,
    "question_text_hi" TEXT,
    "question_text_gu" TEXT,
    "explanation_en" TEXT,
    "explanation_hi" TEXT,
    "explanation_gu" TEXT,
    "instructions_en" TEXT,
    "instructions_hi" TEXT,
    "instructions_gu" TEXT,
    "image_url" TEXT,
    "video_url" TEXT,
    "audio_url" TEXT,
    "marks" DECIMAL(5,2) NOT NULL DEFAULT 1.0,
    "negative_marks" DECIMAL(5,2) DEFAULT 0,
    "time_limit_seconds" INTEGER,
    "options" JSONB,
    "expected_answer_en" TEXT,
    "expected_answer_hi" TEXT,
    "expected_answer_gu" TEXT,
    "max_word_limit" INTEGER,
    "min_word_limit" INTEGER,
    "response_type" "ExpectedResponseType",
    "max_file_size_mb" INTEGER DEFAULT 50,
    "max_video_duration_seconds" INTEGER DEFAULT 120,
    "rubric" JSONB,
    "status" "QuestionStatus" NOT NULL DEFAULT 'draft',
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "source_document_id" UUID,
    "source_chapter" VARCHAR(255),
    "source_page" VARCHAR(50),
    "tags" TEXT[],
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "question_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "action" "ReviewAction" NOT NULL,
    "comments" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name_en" VARCHAR(255) NOT NULL,
    "name_hi" VARCHAR(255),
    "name_gu" VARCHAR(255),
    "description_en" TEXT,
    "description_hi" TEXT,
    "description_gu" TEXT,
    "outlet_id" UUID,
    "department_id" UUID,
    "designation_id" UUID,
    "total_marks" DECIMAL(6,2) NOT NULL,
    "passing_percentage" DECIMAL(5,2) NOT NULL DEFAULT 40.0,
    "duration_minutes" INTEGER NOT NULL DEFAULT 60,
    "mcq_count" INTEGER DEFAULT 0,
    "mcq_marks_each" DECIMAL(5,2) DEFAULT 1.0,
    "theory_count" INTEGER DEFAULT 0,
    "theory_marks_each" DECIMAL(5,2) DEFAULT 5.0,
    "video_image_count" INTEGER DEFAULT 0,
    "video_image_marks_each" DECIMAL(5,2) DEFAULT 10.0,
    "question_selection" JSONB,
    "shuffle_questions" BOOLEAN DEFAULT true,
    "shuffle_options" BOOLEAN DEFAULT true,
    "show_result_immediately" BOOLEAN DEFAULT false,
    "allow_review" BOOLEAN DEFAULT false,
    "allow_back_navigation" BOOLEAN DEFAULT true,
    "show_explanation_after" BOOLEAN DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" UUID,
    "name_en" VARCHAR(255) NOT NULL,
    "name_hi" VARCHAR(255),
    "name_gu" VARCHAR(255),
    "exam_code" VARCHAR(20) NOT NULL,
    "scheduled_date" DATE NOT NULL,
    "start_time" TIME(6) NOT NULL,
    "end_time" TIME(6) NOT NULL,
    "timezone" VARCHAR(50) DEFAULT 'Asia/Kolkata',
    "outlet_id" UUID,
    "department_id" UUID,
    "designation_id" UUID,
    "total_marks" DECIMAL(6,2) NOT NULL,
    "passing_percentage" DECIMAL(5,2) NOT NULL DEFAULT 40.0,
    "duration_minutes" INTEGER NOT NULL,
    "shuffle_questions" BOOLEAN DEFAULT true,
    "shuffle_options" BOOLEAN DEFAULT true,
    "show_result_immediately" BOOLEAN DEFAULT false,
    "allow_review" BOOLEAN DEFAULT false,
    "allow_back_navigation" BOOLEAN DEFAULT true,
    "status" "ExamStatus" NOT NULL DEFAULT 'draft',
    "is_auto_scheduled" BOOLEAN DEFAULT false,
    "total_assigned" INTEGER DEFAULT 0,
    "total_attempted" INTEGER DEFAULT 0,
    "total_passed" INTEGER DEFAULT 0,
    "average_score" DECIMAL(5,2),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "sort_order" SMALLINT NOT NULL,
    "marks" DECIMAL(5,2) NOT NULL,
    "is_mandatory" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "exam_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'assigned',
    "notified_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "graded_at" TIMESTAMPTZ(6),
    "total_marks_obtained" DECIMAL(6,2),
    "percentage" DECIMAL(5,2),
    "grade" VARCHAR(5),
    "passed" BOOLEAN,
    "graded_by" UUID,
    "supervisor_remarks" TEXT,

    CONSTRAINT "exam_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_schedule_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "day_of_month" SMALLINT NOT NULL DEFAULT 15,
    "fallback_rule" "ScheduleFallbackRule" NOT NULL DEFAULT 'next_monday',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "outlet_id" UUID,
    "template_id" UUID,
    "notify_days_before" INTEGER NOT NULL DEFAULT 3,
    "reminder_day_before" BOOLEAN DEFAULT true,
    "reminder_morning_of" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_schedule_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_responses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_assignment_id" UUID NOT NULL,
    "exam_question_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "response_type" "QuestionType" NOT NULL,
    "selected_option_id" VARCHAR(50),
    "is_correct" BOOLEAN,
    "theory_answer" TEXT,
    "theory_answer_language" "Language",
    "media_urls" TEXT[],
    "media_type" "MediaType",
    "marks_obtained" DECIMAL(5,2),
    "max_marks" DECIMAL(5,2) NOT NULL,
    "is_auto_graded" BOOLEAN DEFAULT false,
    "graded_by" UUID,
    "graded_at" TIMESTAMPTZ(6),
    "grader_comments" TEXT,
    "rubric_scores" JSONB,
    "time_spent_seconds" INTEGER,
    "answered_at" TIMESTAMPTZ(6),
    "is_flagged" BOOLEAN DEFAULT false,
    "is_skipped" BOOLEAN DEFAULT false,

    CONSTRAINT "exam_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_assignment_id" UUID NOT NULL,
    "device_info" JSONB,
    "ip_address" INET,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "tab_switches" INTEGER DEFAULT 0,
    "app_backgrounds" INTEGER DEFAULT 0,
    "suspicious_activities" JSONB,
    "face_verified" BOOLEAN,
    "face_match_confidence" DECIMAL(5,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "exams_assigned" INTEGER DEFAULT 0,
    "exams_attempted" INTEGER DEFAULT 0,
    "exams_passed" INTEGER DEFAULT 0,
    "exams_missed" INTEGER DEFAULT 0,
    "average_score" DECIMAL(5,2),
    "highest_score" DECIMAL(5,2),
    "lowest_score" DECIMAL(5,2),
    "topic_scores" JSONB,
    "outlet_rank" INTEGER,
    "department_rank" INTEGER,
    "overall_rank" INTEGER,
    "improvement_from_last" DECIMAL(5,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "exam_id" UUID,
    "type" "CertificateType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "certificate_url" TEXT,
    "certificate_number" VARCHAR(50),
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" UUID,
    "valid_until" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rewards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "type" "RewardType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "month" INTEGER,
    "year" INTEGER,
    "criteria" JSONB,
    "awarded_by" UUID,
    "awarded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "topic_id" UUID,
    "source_document_id" UUID,
    "reason" TEXT,
    "assigned_by" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_date" DATE,
    "status" "TrainingStatus" NOT NULL DEFAULT 'assigned',
    "completed_at" TIMESTAMPTZ(6),
    "completion_notes" TEXT,
    "is_auto_assigned" BOOLEAN DEFAULT false,
    "triggering_exam_id" UUID,
    "triggering_score" DECIMAL(5,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "training_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supervisor_remarks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "remark_type" "RemarkType" NOT NULL,
    "remark" TEXT NOT NULL,
    "related_exam_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supervisor_remarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(50) NOT NULL,
    "entity_id" UUID,
    "old_values" JSONB,
    "new_values" JSONB,
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'in_app',
    "is_read" BOOLEAN DEFAULT false,
    "read_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "whatsapp_message_id" VARCHAR(100),
    "whatsapp_status" "WhatsAppStatus",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" VARCHAR(255) NOT NULL,
    "language" "Language" NOT NULL,
    "value" TEXT NOT NULL,
    "context" VARCHAR(100),

    CONSTRAINT "translations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_employee_code_key" ON "employees"("employee_code");

-- CreateIndex
CREATE INDEX "employees_outlet_id_idx" ON "employees"("outlet_id");

-- CreateIndex
CREATE INDEX "employees_department_id_idx" ON "employees"("department_id");

-- CreateIndex
CREATE INDEX "employees_user_id_idx" ON "employees"("user_id");

-- CreateIndex
CREATE INDEX "employee_skills_employee_id_idx" ON "employee_skills"("employee_id");

-- CreateIndex
CREATE INDEX "employee_timeline_employee_id_event_date_idx" ON "employee_timeline"("employee_id", "event_date");

-- CreateIndex
CREATE UNIQUE INDEX "outlets_code_key" ON "outlets"("code");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "designations_code_key" ON "designations"("code");

-- CreateIndex
CREATE INDEX "questions_type_department_id_idx" ON "questions"("type", "department_id");

-- CreateIndex
CREATE INDEX "questions_topic_id_idx" ON "questions"("topic_id");

-- CreateIndex
CREATE INDEX "questions_difficulty_idx" ON "questions"("difficulty");

-- CreateIndex
CREATE INDEX "question_reviews_question_id_idx" ON "question_reviews"("question_id");

-- CreateIndex
CREATE UNIQUE INDEX "exams_exam_code_key" ON "exams"("exam_code");

-- CreateIndex
CREATE INDEX "exams_scheduled_date_idx" ON "exams"("scheduled_date");

-- CreateIndex
CREATE INDEX "exams_outlet_id_idx" ON "exams"("outlet_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_questions_exam_id_question_id_key" ON "exam_questions"("exam_id", "question_id");

-- CreateIndex
CREATE INDEX "exam_assignments_employee_id_idx" ON "exam_assignments"("employee_id");

-- CreateIndex
CREATE INDEX "exam_assignments_status_idx" ON "exam_assignments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "exam_assignments_exam_id_employee_id_key" ON "exam_assignments"("exam_id", "employee_id");

-- CreateIndex
CREATE INDEX "exam_responses_exam_assignment_id_idx" ON "exam_responses"("exam_assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_responses_exam_assignment_id_exam_question_id_key" ON "exam_responses"("exam_assignment_id", "exam_question_id");

-- CreateIndex
CREATE INDEX "exam_sessions_exam_assignment_id_idx" ON "exam_sessions"("exam_assignment_id");

-- CreateIndex
CREATE INDEX "performance_snapshots_employee_id_year_month_idx" ON "performance_snapshots"("employee_id", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "performance_snapshots_employee_id_month_year_key" ON "performance_snapshots"("employee_id", "month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_certificate_number_key" ON "certificates"("certificate_number");

-- CreateIndex
CREATE INDEX "certificates_employee_id_idx" ON "certificates"("employee_id");

-- CreateIndex
CREATE INDEX "rewards_employee_id_idx" ON "rewards"("employee_id");

-- CreateIndex
CREATE INDEX "training_assignments_employee_id_idx" ON "training_assignments"("employee_id");

-- CreateIndex
CREATE INDEX "supervisor_remarks_employee_id_idx" ON "supervisor_remarks"("employee_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_idx" ON "notifications"("user_id", "is_read");

-- CreateIndex
CREATE UNIQUE INDEX "translations_key_language_key" ON "translations"("key", "language");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_designation_id_fkey" FOREIGN KEY ("designation_id") REFERENCES "designations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_assessed_by_fkey" FOREIGN KEY ("assessed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_timeline" ADD CONSTRAINT "employee_timeline_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_timeline" ADD CONSTRAINT "employee_timeline_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designations" ADD CONSTRAINT "designations_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_departments" ADD CONSTRAINT "outlet_departments_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_departments" ADD CONSTRAINT "outlet_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_parent_topic_id_fkey" FOREIGN KEY ("parent_topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_reviews" ADD CONSTRAINT "question_reviews_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_reviews" ADD CONSTRAINT "question_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_templates" ADD CONSTRAINT "exam_templates_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_templates" ADD CONSTRAINT "exam_templates_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_templates" ADD CONSTRAINT "exam_templates_designation_id_fkey" FOREIGN KEY ("designation_id") REFERENCES "designations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_templates" ADD CONSTRAINT "exam_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "exam_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_designation_id_fkey" FOREIGN KEY ("designation_id") REFERENCES "designations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_assignments" ADD CONSTRAINT "exam_assignments_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_assignments" ADD CONSTRAINT "exam_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_assignments" ADD CONSTRAINT "exam_assignments_graded_by_fkey" FOREIGN KEY ("graded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_schedule_config" ADD CONSTRAINT "exam_schedule_config_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_schedule_config" ADD CONSTRAINT "exam_schedule_config_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "exam_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_responses" ADD CONSTRAINT "exam_responses_exam_assignment_id_fkey" FOREIGN KEY ("exam_assignment_id") REFERENCES "exam_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_responses" ADD CONSTRAINT "exam_responses_exam_question_id_fkey" FOREIGN KEY ("exam_question_id") REFERENCES "exam_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_responses" ADD CONSTRAINT "exam_responses_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_responses" ADD CONSTRAINT "exam_responses_graded_by_fkey" FOREIGN KEY ("graded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_exam_assignment_id_fkey" FOREIGN KEY ("exam_assignment_id") REFERENCES "exam_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_awarded_by_fkey" FOREIGN KEY ("awarded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_triggering_exam_id_fkey" FOREIGN KEY ("triggering_exam_id") REFERENCES "exams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_remarks" ADD CONSTRAINT "supervisor_remarks_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_remarks" ADD CONSTRAINT "supervisor_remarks_related_exam_id_fkey" FOREIGN KEY ("related_exam_id") REFERENCES "exams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_remarks" ADD CONSTRAINT "supervisor_remarks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constraints that Prisma's schema language cannot express (§4.1).
-- Prisma's migration engine does not manage CHECK constraints, so this
-- survives future `migrate dev` runs without being reported as drift.
-- ---------------------------------------------------------------------------

-- §4.1 employee_skills: proficiency_level SMALLINT NOT NULL CHECK (BETWEEN 1 AND 5)
ALTER TABLE "employee_skills"
  ADD CONSTRAINT "employee_skills_proficiency_level_check"
  CHECK ("proficiency_level" BETWEEN 1 AND 5);
