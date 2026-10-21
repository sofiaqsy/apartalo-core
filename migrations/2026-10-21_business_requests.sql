-- Requests to register a new business. NOT applied: review, then run on the Fincas Supabase project.
-- A request creates nothing by itself. A platform admin (profiles.role = 'admin') approves it,
-- and only then are the farm, the owner membership and the identity link created.

create table if not exists public.business_requests (
  id            uuid primary key default gen_random_uuid(),
  firebase_uid  text not null,
  display_name  text,
  email         text,
  business_name text not null,
  city          text not null,
  contact_phone text not null,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  farm_id       uuid references public.farms(id) on delete set null,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references public.profiles(id) on delete set null
);

-- One open request per person.
create unique index if not exists business_requests_one_pending
  on public.business_requests(firebase_uid) where status = 'pending';

-- RLS on, no policies: only the backend service role can read or write.
alter table public.business_requests enable row level security;
