-- Dubla Aí — schema inicial
--
-- ESTADO: escrito e revisado, NÃO aplicado. Entra em operação na Fase 5.
-- Nas Fases 0-4 os mesmos tipos vivem em packages/shared e persistem em OPFS/IndexedDB.
--
-- Convenções:
--   - snake_case; mapeia 1:1 para os tipos camelCase de packages/shared/src/domain.ts
--   - colunas de score são NULLABLE: NULL significa "não calculável" (§12), nunca 0
--   - nenhum blob no banco: apenas chaves de object storage (§44)

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------------

create type work_type        as enum ('film', 'series', 'animation', 'cartoon', 'anime', 'meme', 'other');
create type scene_status     as enum ('draft', 'processing', 'review', 'published', 'blocked', 'expired', 'archived');
create type scene_difficulty as enum ('easy', 'medium', 'hard', 'insane');
create type dub_mode         as enum ('original', 'parody');
create type recording_status as enum ('recording', 'uploading', 'queued', 'processing', 'completed', 'failed');
create type visibility_state as enum ('private', 'unlisted', 'public', 'moderation_review', 'blocked');
create type report_status    as enum ('open', 'reviewing', 'upheld', 'rejected');
create type job_status       as enum ('queued', 'running', 'completed', 'failed', 'cancelled');

-- ---------------------------------------------------------------------------
-- CATÁLOGO
-- ---------------------------------------------------------------------------

create table works (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  title       text not null,
  type        work_type not null,
  year        smallint,
  synopsis    text,
  poster_key  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table characters (
  id             uuid primary key default gen_random_uuid(),
  work_id        uuid not null references works(id) on delete cascade,
  name           text not null,
  color_token    text not null,
  -- §63: cor sozinha não pode identificar um personagem. O padrão visual é a
  -- redundância não-cromática usada por leitores de tela e daltônicos.
  pattern_token  text not null,
  created_at     timestamptz not null default now(),
  unique (work_id, name)
);

create table scenes (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text not null unique,
  work_id              uuid not null references works(id) on delete cascade,
  title                text not null,
  description          text,
  duration_ms          integer not null,
  difficulty           scene_difficulty not null default 'medium',
  language             text not null default 'pt-BR',
  video_key            text not null,
  reference_audio_key  text not null,
  features_key         text not null,
  thumbnail_key        text,
  character_count      smallint not null default 1,
  status               scene_status not null default 'draft',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- §9: nenhuma cena passa de ~60s no MVP
  constraint scene_duration_bounded check (duration_ms > 0 and duration_ms <= 60000)
);

create index scenes_status_idx on scenes (status) where status = 'published';
create index scenes_work_idx   on scenes (work_id);

create table speaker_segments (
  id            uuid primary key default gen_random_uuid(),
  scene_id      uuid not null references scenes(id) on delete cascade,
  character_id  uuid not null references characters(id) on delete restrict,
  start_ms      integer not null,
  end_ms        integer not null,
  text          text not null,
  order_index   smallint not null,
  constraint segment_range_valid check (end_ms > start_ms),
  unique (scene_id, order_index)
);

create index speaker_segments_scene_idx on speaker_segments (scene_id, start_ms);

create table subtitle_segments (
  id                  uuid primary key default gen_random_uuid(),
  scene_id            uuid not null references scenes(id) on delete cascade,
  speaker_segment_id  uuid references speaker_segments(id) on delete set null,
  start_ms            integer not null,
  end_ms              integer not null,
  text                text not null,
  constraint subtitle_range_valid check (end_ms > start_ms)
);

create index subtitle_segments_scene_idx on subtitle_segments (scene_id, start_ms);

-- ---------------------------------------------------------------------------
-- DIREITOS (§39)
-- ---------------------------------------------------------------------------

create table content_rights (
  id                  uuid primary key default gen_random_uuid(),
  scene_id            uuid not null unique references scenes(id) on delete cascade,
  source              text not null,
  owner               text not null,
  license_type        text not null,
  license_start       date,
  license_end         date,
  territories         text[] not null default '{}',
  usage_restrictions  text,
  proof_reference     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Uma cena não pode ser publicada sem direitos registrados.
create or replace function enforce_rights_before_publish() returns trigger
language plpgsql as $$
begin
  if new.status = 'published'
     and not exists (select 1 from content_rights cr where cr.scene_id = new.id) then
    raise exception 'scene % cannot be published without a content_rights row', new.id;
  end if;
  return new;
end;
$$;

create trigger scenes_require_rights
  before insert or update of status on scenes
  for each row execute function enforce_rights_before_publish();

-- ---------------------------------------------------------------------------
-- USUÁRIO
-- ---------------------------------------------------------------------------

-- Em Supabase, referencia auth.users. Fora dele, vira uma tabela própria.
create table profiles (
  id            uuid primary key,
  username      text not null unique,
  display_name  text,
  bio           text,
  avatar_key    text,
  is_public     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- GRAVAÇÃO
-- ---------------------------------------------------------------------------

create table recordings (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid references profiles(id) on delete cascade,  -- NULL = anônima (§53)
  scene_id               uuid not null references scenes(id) on delete cascade,
  mode                   dub_mode not null,
  storage_key            text not null,
  duration_ms            integer not null,
  format                 text not null,
  sample_rate            integer not null,
  channels               smallint not null default 1,
  -- §18: a ponte medida entre o relógio de áudio e a timeline do vídeo
  recording_offset_ms    integer not null default 0,
  clock_confidence       real not null default 0,
  sample_continuity_ok   boolean not null default true,
  visibility             visibility_state not null default 'private',
  status                 recording_status not null default 'completed',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint clock_confidence_range check (clock_confidence between 0 and 1)
);

create index recordings_user_idx  on recordings (user_id, created_at desc);
create index recordings_scene_idx on recordings (scene_id, created_at desc);

create table recording_attempts (
  id              uuid primary key default gen_random_uuid(),
  recording_id    uuid not null references recordings(id) on delete cascade,
  attempt_number  smallint not null,
  is_best         boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (recording_id, attempt_number)
);

-- ---------------------------------------------------------------------------
-- ANÁLISE (§51)
-- ---------------------------------------------------------------------------

create table analyses (
  id                   uuid primary key default gen_random_uuid(),
  recording_id         uuid not null references recordings(id) on delete cascade,
  -- §52: sem estes dois campos, scores antigos ficam inexplicáveis
  engine_version       text not null,
  config_version       text not null,
  -- NULL = métrica não calculável. Jamais gravar 0 para representar isso (§12).
  overall_score        numeric(5,2),
  sync_score           numeric(5,2),
  articulation_score   numeric(5,2),
  rhythm_score         numeric(5,2),
  pitch_score          numeric(5,2),
  energy_score         numeric(5,2),
  occupancy_score      numeric(5,2),
  confidence           real not null,
  unavailable_metrics  text[] not null default '{}',
  -- §2.2 do SCORING.md: atraso do setup do usuário, reportado, não escondido
  global_offset_ms     integer not null default 0,
  raw_analysis         jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  constraint confidence_range check (confidence between 0 and 1),
  constraint scores_in_range check (
    coalesce(overall_score, 0)      between 0 and 100 and
    coalesce(sync_score, 0)         between 0 and 100 and
    coalesce(articulation_score, 0) between 0 and 100 and
    coalesce(rhythm_score, 0)       between 0 and 100 and
    coalesce(pitch_score, 0)        between 0 and 100 and
    coalesce(energy_score, 0)       between 0 and 100 and
    coalesce(occupancy_score, 0)    between 0 and 100
  )
);

create index analyses_recording_idx on analyses (recording_id, created_at desc);

-- ---------------------------------------------------------------------------
-- SOCIAL E MODERAÇÃO (§41) — criadas agora, usadas na Fase 5+
-- ---------------------------------------------------------------------------

create table favorites (
  user_id     uuid not null references profiles(id) on delete cascade,
  scene_id    uuid not null references scenes(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, scene_id)
);

create table reports (
  id            uuid primary key default gen_random_uuid(),
  recording_id  uuid not null references recordings(id) on delete cascade,
  reporter_id   uuid references profiles(id) on delete set null,
  reason        text not null,
  details       text,
  status        report_status not null default 'open',
  created_at    timestamptz not null default now()
);

create table render_jobs (
  id                  uuid primary key default gen_random_uuid(),
  recording_id        uuid not null references recordings(id) on delete cascade,
  -- §57: idempotência. A mesma chave nunca produz dois renders.
  idempotency_key     text not null unique,
  processing_version  text not null,
  status              job_status not null default 'queued',
  output_key          text,
  error_code          text,
  attempts            smallint not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS (§81) — descobrir um UUID não dá acesso a nada
-- ---------------------------------------------------------------------------

alter table works              enable row level security;
alter table characters         enable row level security;
alter table scenes             enable row level security;
alter table speaker_segments   enable row level security;
alter table subtitle_segments  enable row level security;
alter table content_rights     enable row level security;
alter table profiles           enable row level security;
alter table recordings         enable row level security;
alter table recording_attempts enable row level security;
alter table analyses           enable row level security;
alter table favorites          enable row level security;
alter table reports            enable row level security;
alter table render_jobs        enable row level security;

-- Catálogo: público apenas quando a cena está publicada.
create policy scenes_public_select on scenes for select
  using (status = 'published');

create policy works_public_select on works for select
  using (exists (select 1 from scenes s where s.work_id = works.id and s.status = 'published'));

create policy characters_public_select on characters for select
  using (exists (select 1 from scenes s where s.work_id = characters.work_id and s.status = 'published'));

create policy speaker_segments_public_select on speaker_segments for select
  using (exists (select 1 from scenes s where s.id = speaker_segments.scene_id and s.status = 'published'));

create policy subtitle_segments_public_select on subtitle_segments for select
  using (exists (select 1 from scenes s where s.id = subtitle_segments.scene_id and s.status = 'published'));

-- content_rights: sem política de leitura. Nenhum cliente lê esta tabela.

-- Perfis: públicos só se o usuário quiser.
create policy profiles_select on profiles for select
  using (is_public or id = auth.uid());
create policy profiles_update on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- Gravações: dono ou explicitamente pública.
create policy recordings_select on recordings for select
  using ((user_id is not null and user_id = auth.uid()) or visibility = 'public');
create policy recordings_insert on recordings for insert
  with check (user_id = auth.uid());
create policy recordings_update on recordings for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy recordings_delete on recordings for delete
  using (user_id = auth.uid());

-- Tentativas e análises herdam a visibilidade da gravação.
create policy recording_attempts_select on recording_attempts for select
  using (exists (
    select 1 from recordings r where r.id = recording_attempts.recording_id
      and ((r.user_id is not null and r.user_id = auth.uid()) or r.visibility = 'public')
  ));

create policy analyses_select on analyses for select
  using (exists (
    select 1 from recordings r where r.id = analyses.recording_id
      and ((r.user_id is not null and r.user_id = auth.uid()) or r.visibility = 'public')
  ));

-- Análises são escritas apenas pelo servidor (service role), nunca pelo cliente (§78).

create policy favorites_all on favorites for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy reports_insert on reports for insert
  with check (reporter_id = auth.uid() or reporter_id is null);

-- render_jobs: sem política pública. Apenas service role.

-- ---------------------------------------------------------------------------
-- updated_at automático
-- ---------------------------------------------------------------------------

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger works_touch          before update on works          for each row execute function touch_updated_at();
create trigger scenes_touch         before update on scenes         for each row execute function touch_updated_at();
create trigger content_rights_touch before update on content_rights for each row execute function touch_updated_at();
create trigger profiles_touch       before update on profiles       for each row execute function touch_updated_at();
create trigger recordings_touch     before update on recordings     for each row execute function touch_updated_at();
create trigger render_jobs_touch    before update on render_jobs    for each row execute function touch_updated_at();
