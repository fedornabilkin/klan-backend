\set ON_ERROR_STOP on
\set VERBOSITY terse
-- psql reads and writes COPY text directly, preserving UTF-8 and JSON escaping.
CREATE TEMP VIEW reviewed_rows (relation, body) AS
  SELECT 'klan_users', to_jsonb(t) FROM public.klan_users t
  UNION ALL SELECT 'klan_entities', jsonb_build_object('id',t.id,'kind',t.kind,'data',t.data) FROM public.klan_entities t
  UNION ALL SELECT 'klan_tags', to_jsonb(t) FROM public.klan_tags t
  UNION ALL SELECT 'klan_items', to_jsonb(t) FROM public.klan_items t
  UNION ALL SELECT 'klan_activities', to_jsonb(t) FROM public.klan_activities t
  UNION ALL SELECT 'klan_migrations', to_jsonb(t) FROM public.klan_migrations t
  UNION ALL SELECT 'klan_auth', to_jsonb(t) FROM public.klan_auth t
    WHERE kind NOT IN ('sessions', 'authRequests', 'managedAdmins');

\if :export_mode
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
\else
BEGIN;
SET LOCAL lock_timeout = '15s';
\endif
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
DO $$
BEGIN
  IF (SELECT array_agg(tablename::text ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public')
     IS DISTINCT FROM ARRAY['klan_activities','klan_auth','klan_entities','klan_items','klan_migrations','klan_tags','klan_users']
     OR NOT coalesce((SELECT array_agg(version ORDER BY version) FROM public.klan_migrations) IN (ARRAY[1],ARRAY[1,2],ARRAY[1,2,3]), false) THEN
    RAISE EXCEPTION 'Unexpected Klan schema or migration version';
  END IF;
END $$;

\if :export_mode
DO $$ BEGIN
  IF current_database() <> 'klan_demo' THEN RAISE EXCEPTION 'Expected the reviewed klan_demo database'; END IF;
END $$;
\else
CREATE TEMP TABLE reviewed_input (relation text NOT NULL, body jsonb NOT NULL) ON COMMIT DROP;
\copy reviewed_input FROM 'reviewed.copy'
DO $$
DECLARE target text;
BEGIN
  PERFORM pg_advisory_xact_lock(54652602);
  IF (SELECT array_agg((body->>'version')::integer ORDER BY (body->>'version')::integer) FROM reviewed_input WHERE relation='klan_migrations')
     IS DISTINCT FROM (SELECT array_agg(version ORDER BY version) FROM public.klan_migrations) THEN
    RAISE EXCEPTION 'Update both databases to the same migration version before import';
  END IF;
  IF EXISTS (SELECT FROM reviewed_input WHERE relation='klan_auth' AND body->>'kind'='managedAdmins') THEN
    RAISE EXCEPTION 'Deployment administrator bindings belong to the target database';
  END IF;
  CREATE TEMP TABLE saved_admin_bindings ON COMMIT DROP AS SELECT * FROM public.klan_auth WHERE kind='managedAdmins';
  TRUNCATE public.klan_users, public.klan_entities, public.klan_tags, public.klan_items,
           public.klan_activities, public.klan_migrations, public.klan_auth;
  FOREACH target IN ARRAY ARRAY['klan_users','klan_entities','klan_tags','klan_items','klan_activities','klan_migrations','klan_auth']
  LOOP
    IF target='klan_entities' THEN
      INSERT INTO public.klan_entities(id,kind,data) SELECT body->>'id',body->>'kind',body->'data' FROM reviewed_input WHERE relation=target;
      CONTINUE;
    END IF;
    EXECUTE format('INSERT INTO public.%1$I SELECT (jsonb_populate_record(NULL::public.%1$I, body)).* FROM pg_temp.reviewed_input WHERE relation = $1', target)
      USING target;
  END LOOP;
  INSERT INTO public.klan_auth SELECT * FROM saved_admin_bindings;
  IF EXISTS ((TABLE reviewed_input EXCEPT ALL TABLE reviewed_rows)
             UNION ALL (TABLE reviewed_rows EXCEPT ALL TABLE reviewed_input)) THEN
    RAISE EXCEPTION 'Source and restored rows differ';
  END IF;
END $$;
\endif

-- Match the independently audited October import before exporting or committing.
DO $$
BEGIN
  IF (SELECT count(*) FROM public.klan_users) <> 734
     OR (SELECT count(DISTINCT nullif(data#>>'{location,city}','')) FROM public.klan_users) <> 192
     OR (SELECT count(*) FROM public.klan_entities WHERE kind='teams') <> 23
     OR (SELECT count(*) FROM public.klan_entities WHERE kind='challenges') <> 1
     OR NOT EXISTS (SELECT FROM public.klan_entities WHERE kind='challenges' AND id='history-challenge-f24c7cb336799a547084efb9')
     OR (SELECT count(*) FROM public.klan_auth WHERE kind='telegramUsers') <> 451
     OR NOT coalesce((SELECT array_agg(version ORDER BY version) FROM public.klan_migrations) IN (ARRAY[1],ARRAY[1,2],ARRAY[1,2,3]), false) THEN
    RAISE EXCEPTION 'Data does not match the reviewed October dataset';
  END IF;
END $$;
\if :export_mode
COPY (SELECT relation, body FROM reviewed_rows ORDER BY relation COLLATE "C", (body->>'id') COLLATE "C", (body->>'kind') COLLATE "C", body->>'version') TO STDOUT;
\endif
COMMIT;
