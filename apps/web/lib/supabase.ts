'use client'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Cliente do Supabase, criado uma vez por aba.
 *
 * A chave publishable é feita para viver no navegador — ela não é segredo. O
 * que protege os dados é o RLS: as tabelas da partida estão fechadas e só as
 * funções de `db/migrations/0002` respondem, e todas exigem o código da sala
 * como argumento. Sem o código não há resposta, e não existe consulta que
 * liste partidas alheias.
 *
 * Um cliente por aba, e não por chamada: cada instância abre a própria conexão
 * de Realtime, e várias delas significariam vários websockets para a mesma
 * sala.
 */
let cliente: SupabaseClient | null = null

export function supabaseConfigurado(): boolean {
  return (
    typeof process.env['NEXT_PUBLIC_SUPABASE_URL'] === 'string' &&
    typeof process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] === 'string'
  )
}

export class SupabaseIndisponivel extends Error {
  constructor() {
    super(
      'O multiplayer precisa do Supabase configurado. Defina NEXT_PUBLIC_SUPABASE_URL e ' +
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY no projeto.',
    )
    this.name = 'SupabaseIndisponivel'
  }
}

export function supabase(): SupabaseClient {
  if (cliente) return cliente

  const url = process.env['NEXT_PUBLIC_SUPABASE_URL']
  const key = process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']
  if (!url || !key) throw new SupabaseIndisponivel()

  cliente = createClient(url, key, {
    auth: {
      // Não há login: guardar sessão só encheria o armazenamento local com
      // tokens que ninguém usa.
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      // Uma sala tem dois jogadores e poucos eventos por minuto. O padrão de 10
      // eventos/s é folgado e evita que uma rajada de presença seja engolida.
      params: { eventsPerSecond: 10 },
    },
  })
  return cliente
}

/** Caminho do WAV de uma tomada dentro do bucket `partidas`. */
export function caminhoDaTomada(codigo: string, trechoId: string, unico: string): string {
  // O id do trecho vem do cliente e vira caminho: só passa o alfabeto que nós
  // mesmos geramos, para que "../" não escape da pasta da partida.
  const seguro = trechoId.replace(/[^a-zA-Z0-9_-]/g, '')
  return `${codigo}/tomadas/${seguro}-${unico}.wav`
}

/** Caminho do vídeo da cena dentro do bucket `partidas`. */
export function caminhoDoVideo(codigo: string): string {
  return `${codigo}/cena.mp4`
}

export const BUCKET_PARTIDAS = 'partidas'
