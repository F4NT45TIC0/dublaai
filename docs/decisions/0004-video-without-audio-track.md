# ADR 0004 — Vídeo servido sem faixa de áudio, não apenas mudo

**Status:** aceito · **Data:** 2026-08-09

## Contexto

O §14 exige que o áudio original não seja audível durante a dublagem. A solução comum é
`video.muted = true`.

## Decisão

O arquivo de vídeo da cena é gerado **sem stream de áudio** (`ffmpeg -an`). O áudio de referência é um
artefato separado, baixado apenas na tela de comparação.

## Razões

1. **Garantia real.** `muted` é um atributo do DOM: qualquer extensão, devtools ou bug de estado pode
   desfazê-lo. Um arquivo sem faixa de áudio não tem o que desmutar.
2. **Banda.** A faixa de áudio seria transferida e descartada. Em uma cena de 30 s isso são ~180 KB
   inúteis em toda sessão de dublagem (§61).
3. **Separação de artefatos** exigida pelo §15 — "nunca presumir que tudo está em um único MP4".
4. **Verificação objetiva.** A ingestão roda `ffprobe -select_streams a` e reprova a publicação se
   houver qualquer stream de áudio. Um requisito de produto vira um teste.

## Consequências

- O pipeline de ingestão produz obrigatoriamente dois arquivos de mídia por cena.
- A tela de comparação faz um fetch adicional do `reference.opus`, sob gesto do usuário (§33, §66).
- Conteúdo licenciado futuro precisa passar pelo mesmo desmembramento — não é possível apontar direto
  para um MP4 completo de terceiros.
