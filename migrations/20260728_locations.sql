begin;

create table if not exists site_locations (
  location_code text primary key,
  label text not null,
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into site_locations (location_code, label, sort_order)
values
  ('izhevsk', 'Ижевск', 10),
  ('moscow', 'Москва', 20)
on conflict (location_code) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    active = true,
    updated_at = now();

create table if not exists site_location_warehouse_settings (
  id bigserial primary key,
  location_code text not null references site_locations(location_code),
  marketplace text not null check (marketplace in ('all', 'wb', 'oz')),
  store_id text,
  marketplace_warehouse_id text,
  marketplace_warehouse_name text,
  sklad_warehouse_id integer,
  sklad_warehouse_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by bigint references users(id) on delete set null
);

create unique index if not exists idx_site_location_warehouse_settings_unique
  on site_location_warehouse_settings (
    location_code,
    marketplace,
    coalesce(store_id, ''),
    coalesce(marketplace_warehouse_id, '')
  );

do $$
begin
  if to_regclass('public.users') is not null then
    alter table users add column if not exists location_code text references site_locations(location_code);
    alter table users add column if not exists location_configured_at timestamptz;
    alter table users add column if not exists location_configured_by bigint references users(id) on delete set null;
  end if;

  if to_regclass('public.supply_settings') is not null then
    alter table supply_settings add column if not exists location_code text references site_locations(location_code);
    alter table supply_settings add column if not exists sklad_warehouse_id integer;
    alter table supply_settings add column if not exists sklad_warehouse_name text;
  end if;

  if to_regclass('public.ozon_assemblies') is not null then
    alter table ozon_assemblies add column if not exists location_code text references site_locations(location_code);
    alter table ozon_assemblies add column if not exists sklad_warehouse_id integer;
    alter table ozon_assemblies add column if not exists sklad_warehouse_name text;
  end if;
end $$;

create table if not exists site_settings_audit (
  id bigserial primary key,
  actor_user_id bigint references users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz not null default now()
);

commit;
