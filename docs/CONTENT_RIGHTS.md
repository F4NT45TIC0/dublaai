# CONTENT_RIGHTS — Direitos sobre o conteúdo audiovisual

## 1. Posição do projeto

O Dubla Aí **não** baixa, não hospeda e não redistribui conteúdo protegido. A arquitetura assume o
oposto do que costuma ser assumido em projetos parecidos: nenhuma obra comercial entra no repositório,
nem para demonstração (§39, §112).

Proibido, sem exceção:

- baixar filmes, séries ou episódios automaticamente;
- usar torrents ou APIs não oficiais de streaming;
- povoar o catálogo com títulos e falas reais de obras comerciais durante o desenvolvimento (§40);
- versionar mídia cuja licença não esteja registrada.

## 2. Como o catálogo de desenvolvimento é construído

Todo o conteúdo das Fases 0–4 é **autoral e gerado localmente** por `scripts/generate-mock-scenes.ts`:

| Elemento | Origem | Licença |
|---|---|---|
| Diálogos | escritos para este projeto | do projeto |
| Vozes | síntese local (SAPI, voz `Microsoft Maria`, pt-BR) | saída de síntese local, sem redistribuição do motor |
| Vídeo | composição tipográfica gerada por ffmpeg | do projeto |
| Personagens e obras | fictícios | do projeto |

Nenhum arquivo de terceiros é baixado. O script roda offline. A mídia gerada não é versionada — é
reconstruída com `pnpm content:build` a partir dos `scene.json`, que são a fonte autoral.

**As obras do catálogo mock são inventadas.** Não há Shrek, Breaking Bad ou Toy Story no repositório,
apesar de o documento de origem citá-los como exemplo de experiência — citá-los como exemplo não
autoriza distribuí-los.

## 3. Registro obrigatório

Toda cena publicada exige uma linha em `content_rights`, garantido por trigger no banco
(`scenes_require_rights` em `db/migrations/0001_init.sql`):

| Campo | Significado |
|---|---|
| `source` | de onde veio o material |
| `owner` | quem detém os direitos |
| `license_type` | `original` · `public_domain` · `cc_by` · `licensed` · `user_upload` |
| `license_start` / `license_end` | validade |
| `territories` | onde pode ser exibido |
| `usage_restrictions` | limites contratuais em texto |
| `proof_reference` | contrato, e-mail ou ID de licença |

Uma cena com `license_end` no passado deve ir para `expired` por rotina agendada.

## 4. Kill-switch

Retirar conteúdo do ar é uma operação de um campo:

```sql
update scenes set status = 'blocked' where slug = '...';
```

A RLS deixa de expor a cena imediatamente — nenhuma invalidação de cache é necessária para a API,
porque a política filtra por `status = 'published'`. Thumbnails em CDN têm TTL curto por esse motivo.

## 5. Quando existir conteúdo licenciado de verdade

1. Registrar `content_rights` **antes** de fazer upload da mídia.
2. Ingerir por `/admin` (§83), nunca por script direto em produção.
3. Publicar só depois do estado `review`.
4. Manter `proof_reference` auditável.
5. Revisar vencimentos periodicamente.

## 6. Conteúdo gerado pelo usuário

Gravações de voz são conteúdo do usuário e dado sensível (§42). Ver `SECURITY.md` §4. Paródias podem
gerar conteúdo ofensivo — o modelo de moderação (`reports`, `visibility`) está no schema desde já,
ativado na Fase 5 (§41).
