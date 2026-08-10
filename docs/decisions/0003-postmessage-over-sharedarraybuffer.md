# ADR 0003 — `postMessage` com transferables em vez de `SharedArrayBuffer`

**Status:** aceito · **Data:** 2026-08-09

## Contexto

O `AudioWorklet` precisa entregar PCM ao thread principal continuamente. As duas opções são
`SharedArrayBuffer` com ring buffer lock-free, ou `postMessage` com `ArrayBuffer` transferível.

## Decisão

`postMessage` com chunks de 4096 quadros e transferência de posse do buffer.

## Razões

`SharedArrayBuffer` exige isolamento de origem cruzada — `Cross-Origin-Opener-Policy: same-origin` e
`Cross-Origin-Embedder-Policy: require-corp` — **em toda a aplicação**. Isso quebra qualquer recurso
de terceiros sem CORP e complica futuras integrações (embeds, analytics, storage externo na Fase 5).

O ganho não se justifica nesta escala: a 48 kHz mono, 4096 quadros são ≈85 ms de áudio e ~16 KB. São
cerca de 12 mensagens por segundo com transferência de posse — custo desprezível, sem cópia. A
precisão temporal **não depende** do transporte: ela vem de `currentFrame` dentro do worklet, que é
registrado no momento da captura, não no momento da entrega.

Ou seja: `SharedArrayBuffer` reduziria latência de entrega, não erro de medição. Latência de entrega
importa apenas para o desenho da waveform ao vivo, onde 85 ms é imperceptível.

## Consequências

- Sem COOP/COEP; nenhuma restrição sobre recursos externos.
- Se um dia a análise em tempo real durante a gravação exigir latência menor, a decisão pode ser
  revista sem mudar a arquitetura de medição.
- O tamanho do chunk é uma constante em um só lugar (`packages/audio/src/constants.ts`).
