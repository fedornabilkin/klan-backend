// Both projections depend only on their source document. PostgreSQL refreshes them atomically
// for API writes, imports and restores. Keep the original document for editing and exports.
export const cardProjection = `
CREATE OR REPLACE FUNCTION klan_card(doc jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('id',doc->'id','type',doc->'type','publicId',doc->'publicId',
    'title',doc->'title','bookAuthor',doc->'bookAuthor','description',doc->'description','status',doc->'status','category',doc->'category',
    'tags',doc->'tags','createdAt',doc->'createdAt','schedule',doc->'schedule','location',doc->'location','goal',doc->'goal',
    'teamCount',CASE WHEN doc->>'type'='challenges' THEN (SELECT count(DISTINCT p#>>'{team,id}') FROM jsonb_array_elements(nullif(doc->'participants','null')) p) END,
    'participantCount',coalesce(jsonb_array_length(nullif(doc->'participants','null')),0),'readerCount',coalesce(jsonb_array_length(nullif(doc->'readers','null')),0)))
$$;
`;

export const readProjections = `
${cardProjection}
CREATE FUNCTION klan_member_refs(entries jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT coalesce(jsonb_agg((r-'user') || jsonb_build_object('user',jsonb_build_object('id',r#>'{user,id}')) ORDER BY pos),'[]')
  FROM jsonb_array_elements(entries) WITH ORDINALITY x(r,pos)
$$;
CREATE FUNCTION klan_detail(doc jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT BEGIN ATOMIC
  WITH fields AS MATERIALIZED (SELECT * FROM jsonb_to_record(doc) p(participants jsonb,results jsonb,"pendingResults" jsonb,readers jsonb,author jsonb)),
  people AS (SELECT p->'user' AS u,true AS counted FROM fields,jsonb_array_elements(participants) p UNION ALL
    SELECT p->'user',true FROM fields,jsonb_array_elements(results) p UNION ALL
    SELECT p->'user',false FROM fields,jsonb_array_elements("pendingResults") p UNION ALL
    SELECT p,true FROM fields,jsonb_array_elements(readers) p UNION ALL SELECT author,true FROM fields),
  profiles AS (SELECT DISTINCT ON (u->>'id') u FROM people WHERE u->>'id' IS NOT NULL)
  SELECT (doc - ARRAY['historicalImport','participants','results','pendingResults','readers','author']) ||
    jsonb_build_object('participants',coalesce(klan_member_refs(participants),'[]'),
      'results',klan_member_refs(results),'pendingResults',klan_member_refs("pendingResults"),
      'readers',(SELECT jsonb_agg(jsonb_build_object('id',r->'id') ORDER BY pos) FROM jsonb_array_elements(readers) WITH ORDINALITY x(r,pos)),
      'author',CASE WHEN author->>'id' IS NOT NULL THEN jsonb_build_object('id',author->'id') END,
      'embeddedTags',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'tags',tags)), '[]') FROM
        (SELECT DISTINCT u->'id' AS id, u->'tags' AS tags FROM people WHERE counted AND u->>'id' IS NOT NULL AND jsonb_array_length(u->'tags')>0) refs),
      'snapshots',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',u->'id','publicId',u->'publicId','role',u->'role',
        'name',u->'name','initials',u->'initials','color',u->'color','username',u->'username','callsign',u->'callsign','location',u->'location')),'[]') FROM profiles))
  FROM fields;
END;
ALTER TABLE klan_entities ADD COLUMN card jsonb GENERATED ALWAYS AS (klan_card(data)) STORED,
  ADD COLUMN detail jsonb GENERATED ALWAYS AS (klan_detail(data)) STORED;
`;
