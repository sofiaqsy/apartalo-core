-- Staff invitations. NOT applied: review, then run on the Fincas Supabase project.
-- A code only identifies the business; it never grants access. Access exists only after the
-- owner approves the request, which is what creates the farm_members row.

create table if not exists public.join_codes (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null references public.farms(id) on delete cascade,
  code_hash   text not null unique,              -- sha256 of the code; the code itself is shown once
  role        text not null default 'staff' check (role in ('staff','manager')),
  max_uses    int  not null default 1 check (max_uses between 1 and 20),
  uses        int  not null default 0,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.join_requests (
  id             uuid primary key default gen_random_uuid(),
  farm_id        uuid not null references public.farms(id) on delete cascade,
  code_id        uuid references public.join_codes(id) on delete set null,
  firebase_uid   text not null,
  display_name   text,
  email          text,
  requested_role text not null default 'staff',
  status         text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,
  decided_by     uuid references public.profiles(id) on delete set null
);

-- One open request per person and business.
create unique index if not exists join_requests_one_pending
  on public.join_requests(farm_id, firebase_uid) where status = 'pending';
create index if not exists join_requests_uid_idx on public.join_requests(firebase_uid);

-- RLS on, no policies: only the backend service role can read or write.
alter table public.join_codes    enable row level security;
alter table public.join_requests enable row level security;
