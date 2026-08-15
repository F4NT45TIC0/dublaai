-- Aviso da sala por broadcast, não por replicação de tabela.
--
-- O QUE ESTAVA ERRADO
--
-- A assinatura usava `postgres_changes`, que respeita RLS: o cliente só recebe
-- o evento de uma linha que ele teria permissão de ler. As tabelas da partida
-- têm RLS ligado e NENHUMA política — de propósito, para o código da sala ser a
-- única credencial. As duas decisões, juntas, faziam o Realtime filtrar
-- absolutamente tudo. Nenhum evento chegava, e a sala parecia congelada.
--
-- Também faltava incluir as tabelas na publicação `supabase_realtime`; mesmo
-- com políticas, nada teria sido emitido.
--
-- A SAÍDA
--
-- `realtime.send` publica num canal nomeado, sem passar por RLS de tabela. O
-- canal é `partida:<codigo>`, e o código tem 60 bits: quem não o conhece não
-- monta o nome do canal. É a mesma regra do resto do sistema — o código é a
-- credencial —, agora aplicada ao transporte.
--
-- O payload é só o código. Quem recebe chama `abrir_partida`, que já confere
-- tudo. Mandar o estado no evento duplicaria a regra em dois lugares e abriria
-- a chance de a tela acreditar num payload que o banco recusaria.
--
-- Rode no SQL Editor depois de 0004_storage_partidas.sql.

create or replace function public.avisar_partida()
returns trigger
language plpgsql
security definer
set search_path = public, realtime
as $$
declare
  v_codigo text;
begin
  -- `delete` não traz NEW; sair da sala também precisa avisar o outro lado.
  v_codigo := coalesce(new.codigo, old.codigo);
  if v_codigo is null then
    return coalesce(new, old);
  end if;

  perform realtime.send(
    jsonb_build_object('codigo', v_codigo),
    'mudou',
    'partida:' || v_codigo,
    -- Canal público: a proteção é o nome do canal conter o código de 60 bits,
    -- e o payload não carregar nada além dele.
    false
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists partidas_avisa      on public.partidas;
drop trigger if exists jogadores_avisa     on public.partida_jogadores;
drop trigger if exists tomadas_avisa       on public.partida_tomadas;

-- As três tabelas avisam porque as três mudam o que a tela mostra: entrar na
-- sala, ficar pronto e gravar uma fala acontecem em lugares diferentes.
create trigger partidas_avisa
after insert or update or delete on public.partidas
for each row execute function public.avisar_partida();

create trigger jogadores_avisa
after insert or update or delete on public.partida_jogadores
for each row execute function public.avisar_partida();

create trigger tomadas_avisa
after insert or update or delete on public.partida_tomadas
for each row execute function public.avisar_partida();

-- Conferir depois de rodar:
--   select tgname, tgrelid::regclass
--     from pg_trigger
--    where tgname like '%_avisa';
