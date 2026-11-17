-- ============================================================================
-- NYC FloodGuard — Phase 2 Migration: saved_flood_events
-- Stores per-user bookmarks of selected historical NYC FloodNet events.
-- Run this script in your Supabase Dashboard -> SQL Editor.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.saved_flood_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  sensor_id text NOT NULL,
  sensor_name text NOT NULL,
  borough text,
  street_name text,
  zipcode text,
  flood_start_time text NOT NULL,
  flood_end_time text,
  max_depth_inches numeric(6, 2),
  duration_mins numeric(8, 2),
  data_source text NOT NULL DEFAULT 'nyc_open_data_aq7i_eu5q',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_flood_events_user_event_unique UNIQUE (user_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_saved_flood_events_user_created
  ON public.saved_flood_events (user_id, created_at DESC);

ALTER TABLE public.saved_flood_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own saved flood events" ON public.saved_flood_events;
CREATE POLICY "Users can view own saved flood events"
  ON public.saved_flood_events
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can save own flood events" ON public.saved_flood_events;
CREATE POLICY "Users can save own flood events"
  ON public.saved_flood_events
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own saved flood events" ON public.saved_flood_events;
CREATE POLICY "Users can delete own saved flood events"
  ON public.saved_flood_events
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
