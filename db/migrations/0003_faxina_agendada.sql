-- Agenda a faxina das partidas vencidas.
--
-- Vai por SQL, e não pelo painel, porque o Cron do Supabase já mudou de lugar
-- mais de uma vez (hoje fica em Integrations, antes ficava em Database). O
-- comando abaixo funciona independentemente de onde estiver o botão.
--
-- Rode no SQL Editor DEPOIS de 0002_partidas_supabase.sql.

create extension if not exists pg_cron;

-- Reagendar com o mesmo nome substitui a tarefa anterior em vez de criar uma
-- segunda: rodar este arquivo duas vezes não duplica a faxina.
select cron.unschedule('limpar-partidas-vencidas')
where exists (
  select 1 from cron.job where jobname = 'limpar-partidas-vencidas'
);

/**
 * De hora em hora.
 *
 * As partidas valem 24 horas e a tela promete isso. Sem a faxina, as gravações
 * de voz ficariam guardadas indefinidamente — e voz é dado sensível: o prazo
 * curto é parte do que torna o modo online aceitável (SECURITY.md §42).
 */
select cron.schedule(
  'limpar-partidas-vencidas',
  '0 * * * *',
  $$ select public.limpar_partidas_vencidas(); $$
);

-- Conferir depois de rodar:
--   select jobname, schedule, active from cron.job;
--
-- E, para ver se já rodou alguma vez:
--   select jobname, status, start_time
--     from cron.job_run_details
--    order by start_time desc
--    limit 5;
