-- ============================================================================
-- NYC FloodGuard — Migration: Real Role-Based Authorization & Prototype Settings
-- File: supabase_roles_and_settings.sql
--
-- Purpose:
--   1. Creates `public.user_profiles` with real database-enforced roles
--      ('user' | 'admin'). Public signups ALWAYS receive role = 'user'.
--   2. Creates `public.monitoring_settings` storing the prototype's mounting
--      height, Warning/Critical thresholds (cm), noise filter parameters, and
--      optional flood-barrier threshold.
--   3. Enforces Supabase Row Level Security (RLS) so:
--      - Regular users can READ their own profile and READ monitoring_settings.
--      - ONLY verified administrators (role = 'admin' in user_profiles) can
--        UPDATE monitoring_settings.
--      - Nobody can self-promote to 'admin' from the browser client.
--
-- Run this script in your Supabase Dashboard -> SQL Editor.
-- ============================================================================

-- 1. User Profiles Table (linked to auth.users)
CREATE TABLE IF NOT EXISTS public.user_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  full_name text,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Helper function (SECURITY DEFINER) to check admin status safely inside RLS
CREATE OR REPLACE FUNCTION public.is_floodguard_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE user_id = auth.uid()
      AND role = 'admin'
  );
$$;

-- Automatically create a 'user' profile whenever a new account signs up.
-- Public signups can NEVER set role = 'admin'.
CREATE OR REPLACE FUNCTION public.handle_new_floodguard_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'user'
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_floodguard ON auth.users;
CREATE TRIGGER on_auth_user_created_floodguard
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_floodguard_user();

-- Backfill profiles for any existing accounts created before this migration
INSERT INTO public.user_profiles (user_id, email, full_name, role)
SELECT
  id,
  email,
  COALESCE(raw_user_meta_data->>'full_name', ''),
  'user'
FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- RLS Policies for user_profiles:
-- Authenticated users may read ONLY their own profile row.
-- No INSERT/UPDATE/DELETE policies are granted to browser clients,
-- preventing privilege escalation from client code.
DROP POLICY IF EXISTS "Users can view own profile" ON public.user_profiles;
CREATE POLICY "Users can view own profile"
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- 2. Prototype Monitoring Settings Table (Single Configuration Row id = 1)
CREATE TABLE IF NOT EXISTS public.monitoring_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  mount_height_cm numeric(6, 2) NOT NULL DEFAULT 25.0 CHECK (mount_height_cm > 5 AND mount_height_cm <= 400),
  warn_threshold_cm numeric(6, 2) NOT NULL DEFAULT 6.0 CHECK (warn_threshold_cm > 0),
  crit_threshold_cm numeric(6, 2) NOT NULL DEFAULT 12.0 CHECK (crit_threshold_cm > warn_threshold_cm),
  min_rise_rate_cm_per_min numeric(5, 2) NOT NULL DEFAULT 0.25 CHECK (min_rise_rate_cm_per_min >= 0.05),
  barrier_threshold_cm numeric(6, 2) NOT NULL DEFAULT 10.0 CHECK (barrier_threshold_cm > 0),
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.monitoring_settings (
  id,
  mount_height_cm,
  warn_threshold_cm,
  crit_threshold_cm,
  min_rise_rate_cm_per_min,
  barrier_threshold_cm
)
VALUES (1, 25.0, 6.0, 12.0, 0.25, 10.0)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.monitoring_settings ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read current prototype thresholds & calibration
DROP POLICY IF EXISTS "Authenticated users can read monitoring settings" ON public.monitoring_settings;
CREATE POLICY "Authenticated users can read monitoring settings"
  ON public.monitoring_settings
  FOR SELECT
  TO authenticated
  USING (true);

-- ONLY verified administrators (role = 'admin' in user_profiles) can update settings
DROP POLICY IF EXISTS "Only administrators can update monitoring settings" ON public.monitoring_settings;
CREATE POLICY "Only administrators can update monitoring settings"
  ON public.monitoring_settings
  FOR UPDATE
  TO authenticated
  USING (public.is_floodguard_admin())
  WITH CHECK (public.is_floodguard_admin());

-- ============================================================================
-- HOW TO PROMOTE YOUR OWN ACCOUNT TO ADMINISTRATOR (Run manually in SQL Editor)
-- Replace the email address below with your registered account email:
--
--   UPDATE public.user_profiles
--   SET role = 'admin'
--   WHERE email = 'your-admin-email@example.com';
--
-- ============================================================================
