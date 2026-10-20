-- Links a Firebase (Google / Apple) identity to an existing profile.
-- NOT applied. Review, then run on the Fincas Supabase project (nrapvmbzovoimzepvinq).
-- Access is still decided only by farm_members; this table only says "who is this person".
--   pending  = matched by verified email, waiting for the owner of the platform to confirm
--   active   = confirmed
--   revoked  = blocked

create table if not exists public.firebase_identities (
  firebase_uid text primary key,
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  provider     text,
  status       text not null default 'pending' check (status in ('pending','active','revoked')),
  linked_at    timestamptz not null default now(),
  confirmed_at timestamptz
);

create index if not exists firebase_identities_profile_idx on public.firebase_identities(profile_id);

-- RLS on, no policies: only the backend service role can read or write.
alter table public.firebase_identities enable row level security;

-- Confirm a pending link (replace the uid):
--   update public.firebase_identities set status='active', confirmed_at=now() where firebase_uid='<uid>';
-- Link by hand (e.g. Apple hidden email), replace both values:
--   insert into public.firebase_identities(firebase_uid, profile_id, provider, status, confirmed_at)
--   values ('<uid>', '<profile uuid>', 'apple.com', 'active', now());
