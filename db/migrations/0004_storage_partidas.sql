-- Políticas do bucket `partidas`.
--
-- O bucket é privado, e privado no Supabase significa que a chave publishable
-- não escreve nem lê nada por padrão. Sem estas políticas, subir uma fala
-- devolve 403 e a partida trava sem explicação.
--
-- O que autoriza continua sendo o código: todo objeto mora sob `<codigo>/`, e o
-- código tem 60 bits. Quem não o conhece não monta o caminho — e a leitura
-- pública continua fechada, porque o app entrega links assinados de uma hora,
-- gerados pelo servidor do Supabase, não a URL crua.
--
-- Rode no SQL Editor depois de criar o bucket `partidas` (privado).

insert into storage.buckets (id, name, public)
values ('partidas', 'partidas', false)
on conflict (id) do nothing;

-- Limpa versões anteriores destas políticas, para o arquivo poder ser rodado
-- mais de uma vez sem erro de nome duplicado.
drop policy if exists "partidas_insert_anon" on storage.objects;
drop policy if exists "partidas_select_anon" on storage.objects;
drop policy if exists "partidas_update_anon" on storage.objects;

/**
 * Escrever no bucket da partida.
 *
 * Sem `delete`: apagar a fala do outro no meio do jogo não é uma ação que a
 * interface ofereça, e uma política que a permitisse abriria a porta para
 * alguém com o código estragar a partida alheia. A limpeza é da faxina, que
 * roda com permissão de serviço.
 */
create policy "partidas_insert_anon"
on storage.objects for insert to anon
with check (bucket_id = 'partidas');

/**
 * Ler o próprio objeto.
 *
 * Necessário para o servidor emitir os links assinados. A URL direta continua
 * inútil sem assinatura, porque o bucket é privado.
 */
create policy "partidas_select_anon"
on storage.objects for select to anon
using (bucket_id = 'partidas');

/**
 * Regravar o vídeo da sala.
 *
 * O `upsert` do vídeo depende disto. As tomadas nunca sobrescrevem: cada uma
 * nasce com um nome único, e o banco recusa a segunda para o mesmo trecho.
 */
create policy "partidas_update_anon"
on storage.objects for update to anon
using (bucket_id = 'partidas')
with check (bucket_id = 'partidas');

/**
 * Faxina do armazenamento.
 *
 * A limpeza das linhas apaga a partida, mas os arquivos ficariam órfãos no
 * bucket — inclusive as gravações de voz, que é justamente o que não pode
 * sobreviver às 24 horas prometidas.
 */
create or replace function public.limpar_arquivos_vencidos()
returns integer
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_apagados integer;
begin
  with vivos as (select codigo from public.partidas),
  mortos as (
    delete from storage.objects
     where bucket_id = 'partidas'
       and split_part(name, '/', 1) not in (select codigo from vivos)
    returning 1
  )
  select count(*)::integer into v_apagados from mortos;
  return v_apagados;
end;
$$;

-- Reagenda junto com a faxina das linhas, logo depois dela.
select cron.unschedule('limpar-arquivos-vencidos')
where exists (select 1 from cron.job where jobname = 'limpar-arquivos-vencidos');

select cron.schedule(
  'limpar-arquivos-vencidos',
  '5 * * * *',
  $$ select public.limpar_arquivos_vencidos(); $$
);
