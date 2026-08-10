# ADR 0005 — XState v5 para a máquina de gravação

**Status:** aceito · **Data:** 2026-08-09

## Contexto

O §55 exige máquina de estados explícita e proíbe controlar a gravação com dezenas de booleans. O §56
lista doze race conditions concretas que precisam ser tratadas.

## Decisão

XState v5 para a máquina de gravação — **e apenas para ela**. O resto da aplicação usa estado React
comum.

## Razões

O problema não é representar estados; é representar **transições com efeitos assíncronos
canceláveis**. Countdown, aquisição de microfone, carregamento de vídeo e análise são todos
operações longas que podem ser interrompidas a qualquer momento, e cujo resultado tardio precisa ser
descartado.

Um redutor escrito à mão para isso converge, na prática, para um XState pior: sem guards declarativos,
sem cancelamento de actor, sem delays testáveis, com o cancelamento espalhado por flags.

O que decidiu:

- **actors invocados** com cancelamento automático ao sair do estado — resolve "análise antiga
  sobrescreve a nova" e "upload termina após nova tentativa" sem flags;
- **guards** declarativos — os cinco pré-requisitos de `preparing → countdown` (§19, §59) ficam
  legíveis em um lugar;
- **delays** controláveis — o countdown é testável sem esperar 3 segundos reais;
- **testabilidade headless** — `createActor` roda a máquina inteira em Vitest, sem DOM.

## Custo

~15 KB gzipped, carregados por `import()` dinâmico apenas na rota da cena. A home não paga nada (§61).

## Limite

XState **não** vira o estado global da aplicação. Fora da gravação, ele seria overengineering (§1).
