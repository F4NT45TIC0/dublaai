# MVP

## 1. O que o MVP precisa provar

> "É divertido e funcional dublar uma cena sincronizada." (§94)

Uma única frase. Tudo que não serve a ela fica fora.

## 2. Entra

**Descoberta**
- Home com identidade forte e chamada direta
- `/explorar` com filtros: tipo, duração, dificuldade, nº de personagens
- `/cena/[slug]` com contexto suficiente para decidir dublar

**Cena**
- Player próprio (§14) — play, pause, restart, seek, fullscreen, estados de buffer
- Vídeo sem faixa de áudio no arquivo
- Legendas sincronizadas com identificação de personagem
- Waveform da referência acompanhando a timeline
- Escolha entre modo Original e Paródia antes de gravar

**Gravação**
- Seleção de microfone com labels tolerantes a permissão ausente
- Countdown 3-2-1 que só começa com vídeo, worklet e microfone prontos
- Gravação sincronizada com offset medido, não presumido
- Waveform ao vivo
- Cancelamento limpo em qualquer ponto
- Todas as telas de erro do `FAILURE_MATRIX.md`

**Resultado**
- Playback da própria voz sobre o vídeo, sincronizado
- Mixagem: só minha voz · voz + referência
- Comparação com mel-espectrograma duplo e fita de alinhamento DTW
- Score honesto: sincronia, articulação, ritmo, entonação, energia — cada um com status e confiança
- Tentar de novo, com histórico de tentativas e melhor resultado
- Persistência local das gravações

**Transversal**
- Desktop e mobile moderno
- Teclado, foco visível, contraste, leitor de tela, reduced-motion
- Nenhum microfone ativo após sair da página

## 3. Não entra

Login · upload · servidor · banco aplicado · worker · render de vídeo · compartilhamento · perfil ·
ranking · XP · streak · conquistas · desafio diário · admin · pagamentos · multipersonagem · duetos ·
comentários · seguir usuários.

Nenhum deles fica bloqueado pela arquitetura — ver `ARCHITECTURE.md` §7.

## 4. Fora por decisão explícita

**Score de texto e qualquer transcrição.** A fidelidade é medida acusticamente. Ver `SCORING.md` §0.

**Pitch como métrica de V2** (§95): antecipada para o MVP porque, sem score de texto, a entonação passa
a carregar parte do eixo de fidelidade. Entra com degradação declarada quando a cobertura de sonoridade
é baixa.

## 5. Critérios de aceitação (§111)

O MVP só é funcional se **todos** passarem:

| # | Critério | Como se verifica |
|---|---|---|
| 1 | Usuário abre uma cena | E2E |
| 2 | Vídeo carrega | E2E |
| 3 | Vídeo toca sem áudio | `ffprobe` na ingestão + E2E |
| 4 | Legenda acompanha a cena | E2E com asserção de texto por instante |
| 5 | Waveform acompanha a timeline | manual + teste de unidade do mapeamento tempo→pixel |
| 6 | Usuário autoriza o microfone | E2E com mídia falsa |
| 7 | Countdown funciona | E2E |
| 8 | Gravação começa sincronizada | teste de offset da claquete (±30 ms) |
| 9 | Usuário dubla até o final | E2E |
| 10 | Gravação para corretamente | E2E |
| 11 | Usuário ouve a própria voz com o vídeo | manual |
| 12 | Sistema calcula métricas básicas | fixtures do ScoreEngine |
| 13 | Usuário tenta de novo | E2E |
| 14 | Nenhum microfone ativo ao sair | teste de integração de cleanup |
| 15 | Erros de permissão tratados | testes do gravador |
| 16 | Buffering não inicia gravação inutilizável | teste do guard de `preparing` |
| 17 | Funciona em desktop e mobile moderno | checklist manual |

## 6. Depois do MVP

**V2** (§95): perfil, favoritos, upload, análise no servidor, ranking, conquistas, compartilhamento com
render, desafio diário, admin.

**Futuro** (§96/§97): duetos, multipersonagem, salas privadas, batalhas, criadores, campanhas.
