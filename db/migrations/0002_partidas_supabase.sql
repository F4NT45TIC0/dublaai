-- Partidas multiplayer no Supabase.
--
-- POR QUE SAIR DO BLOB
--
-- O Blob é armazenamento de arquivos, e a sala virava um JSON relido em laço.
-- Isso quebrava de três formas que apareciam como "meu amigo não consegue
-- entrar": a leitura podia devolver uma versão antiga da sala, duas escritas
-- quase simultâneas se sobrescreviam, e presença era adivinhada por timeout.
-- Aqui a sala é uma linha, com atualização atômica e aviso por Realtime.
--
-- COMO ISTO É PROTEGIDO
--
-- Não há login. O que autoriza é conhecer o código da partida — 12 caracteres
-- em base 32, ou 2^60 combinações. Para que isso seja verdade, as tabelas ficam
-- com RLS ligado e SEM política nenhuma: pela API pública ninguém lê nem
-- escreve diretamente, então também não dá para listar partidas alheias.
--
-- Todo acesso passa pelas funções abaixo, que são `security definer` e exigem o
-- código como argumento. Sem o código não há resposta — e não existe consulta
-- que devolva "todas as partidas".

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tabelas

create table if not exists public.partidas (
  codigo           text primary key,
  host_id          text        not null,
  video_id         text        not null,
  video_name       text        not null,
  duration_ms      integer     not null check (duration_ms > 0),
  segmentos        jsonb       not null,
  personagens      jsonb       not null,
  -- Uma das duas formas de a cena chegar ao convidado: link de origem ou
  -- arquivo no Storage. Nunca as duas ao mesmo tempo.
  video_url        text,
  video_path       text,
  criada_em        timestamptz not null default now(),
  atualizada_em    timestamptz not null default now(),
  -- Gravação de voz não fica num servidor para sempre por causa de uma
  -- brincadeira de dez minutos.
  expira_em        timestamptz not null default now() + interval '24 hours'
);

create table if not exists public.partida_jogadores (
  codigo        text        not null references public.partidas (codigo) on delete cascade,
  jogador_id    text        not null,
  nome          text        not null,
  personagem_id text        not null,
  -- Só entra no rodízio depois de terminar de preparar a cena no aparelho.
  pronto        boolean     not null default false,
  visto_em      timestamptz not null default now(),
  primary key (codigo, jogador_id),
  -- Dois jogadores nunca dublam o mesmo personagem.
  unique (codigo, personagem_id)
);

create table if not exists public.partida_tomadas (
  codigo        text        not null references public.partidas (codigo) on delete cascade,
  trecho_id     text        not null,
  jogador_id    text        not null,
  audio_path    text        not null,
  offset_ms     real        not null,
  sample_rate   integer     not null check (sample_rate > 0),
  criada_em     timestamptz not null default now(),
  -- Uma tomada por trecho: a chave primária é a trava contra dois aparelhos
  -- gravarem a mesma fala ao mesmo tempo.
  primary key (codigo, trecho_id)
);

create index if not exists partidas_expira_em_idx on public.partidas (expira_em);

-- ------------------------------------------------------------------- RLS

alter table public.partidas          enable row level security;
alter table public.partida_jogadores enable row level security;
alter table public.partida_tomadas   enable row level security;

-- Sem políticas de propósito: a chave publishable não abre nada por conta
-- própria. Quem lê e escreve são as funções abaixo.

-- ------------------------------------------------------------- utilidades

create or replace function public.partida_viva(p_codigo text)
returns public.partidas
language sql
stable
security definer
set search_path = public
as $$
  select * from public.partidas where codigo = p_codigo and expira_em > now();
$$;

-- ---------------------------------------------------------------- leitura

/**
 * Estado completo da sala, para quem tem o código.
 *
 * Devolve tudo numa chamada só — sala, jogadores e tomadas. Três consultas
 * separadas poderiam pegar momentos diferentes e mostrar um turno que não
 * existe.
 */
create or replace function public.abrir_partida(p_codigo text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when p.codigo is null then null else jsonb_build_object(
    'codigo',      p.codigo,
    'hostId',      p.host_id,
    'videoId',     p.video_id,
    'videoName',   p.video_name,
    'durationMs',  p.duration_ms,
    'segmentos',   p.segmentos,
    'personagens', p.personagens,
    'videoUrl',    p.video_url,
    'videoPath',   p.video_path,
    'criadaEm',    p.criada_em,
    'atualizadaEm', p.atualizada_em,
    'jogadores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',          j.jogador_id,
        'nome',        j.nome,
        'personagemId', j.personagem_id,
        'pronto',      j.pronto,
        'vistoEm',     j.visto_em
      ) order by j.visto_em)
      from public.partida_jogadores j where j.codigo = p.codigo
    ), '[]'::jsonb),
    'tomadas', coalesce((
      select jsonb_object_agg(t.trecho_id, jsonb_build_object(
        'jogadorId',  t.jogador_id,
        'audioPath',  t.audio_path,
        'offsetMs',   t.offset_ms,
        'sampleRate', t.sample_rate
      ))
      from public.partida_tomadas t where t.codigo = p.codigo
    ), '{}'::jsonb)
  ) end
  from public.partida_viva(p_codigo) p;
$$;

-- ------------------------------------------------------------------ criar

create or replace function public.criar_partida(
  p_codigo      text,
  p_host_id     text,
  p_video_id    text,
  p_video_name  text,
  p_duration_ms integer,
  p_segmentos   jsonb,
  p_personagens jsonb,
  p_video_url   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Só HTTPS: este endereço é repassado ao navegador do convidado, e um
  -- `javascript:` guardado aqui viraria arma na outra ponta.
  if p_video_url is not null and p_video_url !~ '^https://' then
    raise exception 'O link do vídeo precisa ser https.';
  end if;
  if jsonb_array_length(p_personagens) <> 2 then
    raise exception 'A partida precisa de exatamente dois personagens.';
  end if;

  insert into public.partidas (
    codigo, host_id, video_id, video_name, duration_ms,
    segmentos, personagens, video_url
  ) values (
    p_codigo, p_host_id, p_video_id, p_video_name, p_duration_ms,
    p_segmentos, p_personagens, p_video_url
  );

  return public.abrir_partida(p_codigo);
end;
$$;

-- ------------------------------------------------------------------ entrar

/**
 * Entra na sala, ou volta para a vaga que já era sua.
 *
 * A sala é de dois. O terceiro é recusado aqui, no banco, e não na tela: a
 * regra de turno nunca depende do cliente (§78).
 */
create or replace function public.entrar_na_partida(
  p_codigo        text,
  p_jogador_id    text,
  p_nome          text,
  p_personagem_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_partida public.partidas;
  v_ocupadas integer;
begin
  select * into v_partida from public.partida_viva(p_codigo);
  if v_partida.codigo is null then
    raise exception 'Partida não encontrada ou expirada.';
  end if;
  if not (v_partida.personagens ? p_personagem_id) then
    raise exception 'Esse personagem não existe nesta partida.';
  end if;

  select count(*) into v_ocupadas
  from public.partida_jogadores
  where codigo = p_codigo and jogador_id <> p_jogador_id;

  if v_ocupadas >= 2 then
    raise exception 'A partida já está cheia.';
  end if;

  insert into public.partida_jogadores (codigo, jogador_id, nome, personagem_id, visto_em)
  values (p_codigo, p_jogador_id, p_nome, p_personagem_id, now())
  on conflict (codigo, jogador_id) do update
    -- Trocar de personagem obriga a preparar a cena de novo.
    set nome          = excluded.nome,
        pronto        = public.partida_jogadores.pronto
                          and public.partida_jogadores.personagem_id = excluded.personagem_id,
        personagem_id = excluded.personagem_id,
        visto_em      = now();

  update public.partidas set atualizada_em = now() where codigo = p_codigo;
  return public.abrir_partida(p_codigo);
end;
$$;

-- --------------------------------------------------------------- presença

create or replace function public.marcar_presenca(
  p_codigo     text,
  p_jogador_id text,
  p_pronto     boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.partida_jogadores
     set visto_em = now(),
         pronto   = coalesce(p_pronto, pronto)
   where codigo = p_codigo and jogador_id = p_jogador_id;

  update public.partidas set atualizada_em = now() where codigo = p_codigo;
  return public.abrir_partida(p_codigo);
end;
$$;

create or replace function public.sair_da_partida(p_codigo text, p_jogador_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.partida_jogadores
   where codigo = p_codigo and jogador_id = p_jogador_id;
  update public.partidas set atualizada_em = now() where codigo = p_codigo;
  return public.abrir_partida(p_codigo);
end;
$$;

-- --------------------------------------------------------------- tomadas

/**
 * Registra a fala gravada.
 *
 * A vez é conferida aqui: quem tenta gravar o trecho do outro, ou um trecho já
 * fechado, é recusado pelo banco. A tela apenas reflete isso.
 */
create or replace function public.guardar_tomada(
  p_codigo      text,
  p_trecho_id   text,
  p_jogador_id  text,
  p_audio_path  text,
  p_offset_ms   real,
  p_sample_rate integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_partida     public.partidas;
  v_personagem  text;
  v_dono        text;
begin
  select * into v_partida from public.partida_viva(p_codigo);
  if v_partida.codigo is null then
    raise exception 'Partida não encontrada ou expirada.';
  end if;

  select seg->>'characterId' into v_personagem
    from jsonb_array_elements(v_partida.segmentos) seg
   where seg->>'id' = p_trecho_id;
  if v_personagem is null then
    raise exception 'Trecho desconhecido nesta partida.';
  end if;

  select jogador_id into v_dono
    from public.partida_jogadores
   where codigo = p_codigo and personagem_id = v_personagem;
  if v_dono is null then
    raise exception 'Ninguém escolheu esse personagem ainda.';
  end if;
  if v_dono <> p_jogador_id then
    raise exception 'Esse trecho é do outro jogador.';
  end if;

  insert into public.partida_tomadas (
    codigo, trecho_id, jogador_id, audio_path, offset_ms, sample_rate
  ) values (
    p_codigo, p_trecho_id, p_jogador_id, p_audio_path, p_offset_ms, p_sample_rate
  );

  update public.partidas set atualizada_em = now() where codigo = p_codigo;
  return public.abrir_partida(p_codigo);
end;
$$;

create or replace function public.registrar_video(
  p_codigo     text,
  p_jogador_id text,
  p_video_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_partida public.partidas;
begin
  select * into v_partida from public.partida_viva(p_codigo);
  if v_partida.codigo is null then
    raise exception 'Partida não encontrada ou expirada.';
  end if;
  if v_partida.host_id <> p_jogador_id then
    raise exception 'Somente o anfitrião pode enviar o vídeo.';
  end if;
  if v_partida.video_path is not null then
    raise exception 'Esta partida já tem um vídeo.';
  end if;

  update public.partidas
     set video_path = p_video_path, atualizada_em = now()
   where codigo = p_codigo;

  return public.abrir_partida(p_codigo);
end;
$$;

-- ------------------------------------------------------------- permissões

-- `anon` só enxerga as funções. As tabelas continuam fechadas por RLS.
revoke all on public.partidas, public.partida_jogadores, public.partida_tomadas from anon;

grant execute on function public.abrir_partida(text)                       to anon;
grant execute on function public.criar_partida(text, text, text, text, integer, jsonb, jsonb, text) to anon;
grant execute on function public.entrar_na_partida(text, text, text, text) to anon;
grant execute on function public.marcar_presenca(text, text, boolean)      to anon;
grant execute on function public.sair_da_partida(text, text)               to anon;
grant execute on function public.guardar_tomada(text, text, text, text, real, integer) to anon;
grant execute on function public.registrar_video(text, text, text)         to anon;

-- `partida_viva` é peça interna das outras funções, não porta de entrada.
revoke execute on function public.partida_viva(text) from anon, public;

-- ------------------------------------------------------------- faxina

/**
 * Apaga partidas vencidas.
 *
 * Agende em Database → Cron para rodar de hora em hora. Sem isso, as gravações
 * de voz ficariam guardadas além das 24 horas que a tela promete.
 */
create or replace function public.limpar_partidas_vencidas()
returns integer
language sql
security definer
set search_path = public
as $$
  with apagadas as (
    delete from public.partidas where expira_em <= now() returning 1
  )
  select count(*)::integer from apagadas;
$$;
