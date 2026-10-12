-- ==============================================================================
-- Master Schema: Workday Automation Database
-- Location: src/db/schema.sql
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ------------------------------------------------------------------------------
-- 1. Table: clients
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applywizz_id TEXT UNIQUE NOT NULL,
  client_name TEXT,
  first_name TEXT,
  last_name TEXT,
  mobile_number TEXT,
  company_email TEXT,
  resume_url TEXT,
  education TEXT,
  university_or_school TEXT,
  degree TEXT,
  field_of_study TEXT,
  graduation_year TEXT,
  gpa TEXT,
  skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  latest_company TEXT,
  latest_job_title TEXT,
  latest_job_location TEXT,
  currently_working BOOLEAN,
  work_from TEXT,
  work_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 2. Table: client_questions (Semantic deduplicated Q&A store)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applywizz_id TEXT NOT NULL REFERENCES public.clients(applywizz_id) ON DELETE CASCADE,
  question_raw TEXT NOT NULL,
  question_normalized TEXT NOT NULL,
  answer TEXT NOT NULL,
  answer_source TEXT NOT NULL DEFAULT 'ai' CHECK (answer_source IN ('profile', 'resume', 'api', 'ai', 'database', 'default')),
  confidence_score NUMERIC(3,2) NOT NULL DEFAULT 0.70 CHECK (confidence_score >= 0 AND confidence_score <= 1),
  field_type TEXT,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (applywizz_id, question_normalized)
);

CREATE INDEX IF NOT EXISTS client_questions_question_trgm_idx
  ON public.client_questions USING gin (question_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS client_questions_awl_idx
  ON public.client_questions (applywizz_id, updated_at DESC);

-- ------------------------------------------------------------------------------
-- 3. Table: job_distributions
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applywizz_id TEXT NOT NULL,
  job_id TEXT,
  job_url TEXT NOT NULL,
  company TEXT NOT NULL,
  role_title TEXT,
  lead_applywizz_id TEXT,
  scraped_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  question_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'distributed',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_job_distributions_awl_url UNIQUE (applywizz_id, job_url)
);

CREATE INDEX IF NOT EXISTS idx_job_dist_awl ON public.job_distributions(applywizz_id);
CREATE INDEX IF NOT EXISTS idx_job_dist_url ON public.job_distributions(job_url);
CREATE INDEX IF NOT EXISTS idx_job_dist_created ON public.job_distributions(created_at DESC);

-- ------------------------------------------------------------------------------
-- 4. Table: submission_tasks
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.submission_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  distribution_id UUID REFERENCES public.job_distributions(id) ON DELETE CASCADE,
  applywizz_id TEXT NOT NULL,
  job_url TEXT NOT NULL,
  company TEXT,
  role_title TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'applying', 'submitted', 'failed')),
  worker_id TEXT,
  application_submitted_screenshot_url TEXT,
  reviewed_by TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_submission_tasks_status ON public.submission_tasks(status);
CREATE INDEX IF NOT EXISTS idx_submission_tasks_awl ON public.submission_tasks(applywizz_id);

-- ------------------------------------------------------------------------------
-- 5. Table: workday_application_token_usage (Workday Application Filling LLM Token Usage)
-- Tracks exact LLM prompt, completion, cache tokens and monetary cost per application.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workday_application_token_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applywizz_id TEXT NOT NULL,
  job_url TEXT NOT NULL,
  role TEXT NOT NULL,
  application_id UUID,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  token_cost NUMERIC(12, 6) NOT NULL DEFAULT 0.000000,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_workday_application_token_usage UNIQUE (applywizz_id, job_url, date)
);

-- Performance and analytical query indexes
CREATE INDEX IF NOT EXISTS idx_workday_token_usage_applywizz
  ON public.workday_application_token_usage (applywizz_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_workday_token_usage_date
  ON public.workday_application_token_usage (date DESC);

CREATE INDEX IF NOT EXISTS idx_workday_token_usage_application_id
  ON public.workday_application_token_usage (application_id);

CREATE INDEX IF NOT EXISTS idx_workday_token_usage_job_url
  ON public.workday_application_token_usage (job_url);

CREATE INDEX IF NOT EXISTS idx_workday_token_usage_model
  ON public.workday_application_token_usage (model);

-- Row Level Security (RLS)
ALTER TABLE public.workday_application_token_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service_role access to workday_application_token_usage" ON public.workday_application_token_usage;
CREATE POLICY "Allow service_role access to workday_application_token_usage" ON public.workday_application_token_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow authenticated read access to workday_application_token_usage" ON public.workday_application_token_usage;
CREATE POLICY "Allow authenticated read access to workday_application_token_usage" ON public.workday_application_token_usage
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow anon read access to workday_application_token_usage" ON public.workday_application_token_usage;
CREATE POLICY "Allow anon read access to workday_application_token_usage" ON public.workday_application_token_usage
  FOR SELECT TO anon USING (true);

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION public.set_workday_token_usage_updated_at()
RETURNS trigger AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workday_token_usage_updated_at ON public.workday_application_token_usage;
CREATE TRIGGER trg_workday_token_usage_updated_at
BEFORE UPDATE ON public.workday_application_token_usage
FOR EACH ROW EXECUTE FUNCTION public.set_workday_token_usage_updated_at();

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';

