-- supabase/nova.sql — Stockage de Nova (à lancer UNE fois dans Supabase → SQL Editor).
-- Mémoire de Nova par utilisateur (fiche) + compteurs quotidiens (quotas).
-- Accès serveur uniquement : RLS activée SANS aucune règle, donc les clés
-- publiques de l'app (anon) n'y ont pas accès. Le backend utilise sa clé serveur.
-- Le backend bascule tout seul sur ces tables (au plus 10 min après), sans redéploiement.

create table if not exists public.nova_fiches (
  user_id    text primary key,
  fiche      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.nova_usage (
  key   text    not null,
  day   date    not null,
  count integer not null default 0,
  primary key (key, day)
);

alter table public.nova_fiches enable row level security;
alter table public.nova_usage  enable row level security;

-- Consomme 1 sur chaque compteur, seulement si AUCUN plafond n'est atteint
-- (une demande refusée ne coûte rien). Renvoie le compteur bloquant sinon.
create or replace function public.nova_consume(p_keys text[], p_limits integer[], p_day date)
returns table (allowed boolean, blocked_key text)
language plpgsql
set search_path = public
as $$
declare
  i int;
  n int;
begin
  for i in 1 .. coalesce(array_length(p_keys, 1), 0) loop
    select u.count into n from public.nova_usage u where u.key = p_keys[i] and u.day = p_day for update;
    if coalesce(n, 0) >= p_limits[i] then
      return query select false, p_keys[i];
      return;
    end if;
  end loop;
  for i in 1 .. coalesce(array_length(p_keys, 1), 0) loop
    insert into public.nova_usage as u (key, day, count) values (p_keys[i], p_day, 1)
    on conflict (key, day) do update set count = u.count + 1;
  end loop;
  return query select true, null::text;
end;
$$;

revoke all on function public.nova_consume(text[], integer[], date) from public, anon, authenticated;
grant execute on function public.nova_consume(text[], integer[], date) to service_role;

-- Rend 1 sur chaque compteur (l'appel à l'IA a échoué : le message n'est pas perdu).
create or replace function public.nova_refund(p_keys text[], p_day date)
returns void
language sql
set search_path = public
as $$
  update public.nova_usage set count = greatest(count - 1, 0)
  where key = any(p_keys) and day = p_day;
$$;

revoke all on function public.nova_refund(text[], date) from public, anon, authenticated;
grant execute on function public.nova_refund(text[], date) to service_role;

-- Entretien (facultatif, de temps en temps) : garder 30 jours de compteurs suffit.
-- delete from public.nova_usage where day < current_date - 30;
