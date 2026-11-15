-- SQL de secours « Appel APK » : à coller dans Supabase > SQL Editor > Run (seulement si le site n'a pas pu créer la table tout seul).
CREATE TABLE IF NOT EXISTS public.apk_calls (
     id           BIGSERIAL PRIMARY KEY,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     channel_id   TEXT NOT NULL,
     channel_name TEXT NOT NULL DEFAULT '',
     game_number  INTEGER,
     suit         TEXT NOT NULL DEFAULT '',
     kind         TEXT NOT NULL DEFAULT 'prediction',
     message      TEXT NOT NULL DEFAULT ''
   );

ALTER TABLE public.apk_calls ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apk_calls' AND policyname = 'apk_calls_lecture') THEN
       CREATE POLICY apk_calls_lecture ON public.apk_calls FOR SELECT TO anon USING (true);
     END IF;
   END $$;

GRANT SELECT ON public.apk_calls TO anon;

NOTIFY pgrst, 'reload schema';
