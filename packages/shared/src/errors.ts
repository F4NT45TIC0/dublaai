/**
 * Taxonomia de erros (§70) e suas mensagens.
 *
 * Código e mensagem moram juntos de propósito. Separá-los é exatamente como
 * "Something went wrong" nasce: alguém adiciona um código e nunca escreve o
 * texto. Aqui o TypeScript obriga — `ERROR_MESSAGES` é um Record completo.
 *
 * Toda entrada responde à pergunta que mais importa numa tela de erro de
 * gravação: **eu perdi o que gravei?** (§117)
 */

export type DublaErrorCode =
  // Microfone
  | 'MIC_PERMISSION_DENIED'
  | 'MIC_PERMISSION_BLOCKED'
  | 'MIC_NOT_FOUND'
  | 'MIC_BUSY'
  | 'MIC_OVERCONSTRAINED'
  | 'MIC_DISCONNECTED'
  | 'MIC_DEVICE_CHANGED'
  // Vídeo
  | 'VIDEO_LOAD_FAILED'
  | 'VIDEO_BUFFERING'
  | 'VIDEO_HAS_AUDIO_TRACK'
  // Gravação
  | 'RECORDING_EMPTY'
  | 'RECORDING_TOO_QUIET'
  | 'RECORDING_CLIPPING'
  | 'RECORDING_FAILED'
  | 'TAB_SUSPENDED'
  | 'AUDIO_INTERRUPTED'
  | 'BROWSER_UNSUPPORTED'
  // Análise
  | 'ANALYSIS_FAILED'
  | 'REFERENCE_FEATURES_MISSING'
  // Rede e armazenamento
  | 'NETWORK_OFFLINE'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'STORAGE_UNAVAILABLE'
  | 'SCENE_NOT_FOUND'
  // Fase 5+ (definidos, ainda sem caminho de código)
  | 'UPLOAD_FAILED'
  | 'UPLOAD_URL_EXPIRED'
  | 'JOB_DUPLICATE'
  | 'RENDER_FAILED'
  | 'AUTH_EXPIRED'
  | 'QUOTA_EXCEEDED'
  | 'UNKNOWN_ERROR'

export interface ErrorPresentation {
  /** Título curto, em caixa alta na UI. */
  readonly title: string
  /** Uma ou duas frases. Sem jargão técnico (§25). */
  readonly message: string
  /** O que o usuário pode fazer agora. */
  readonly action?: string
  /**
   * Se existe um áudio capturado, ele sobreviveu a este erro?
   * `null` quando o erro acontece antes de haver qualquer gravação.
   */
  readonly recordingPreserved: boolean | null
  /** Se `true`, a UI oferece [TENTAR NOVAMENTE] como ação primária. */
  readonly retryable: boolean
}

export const ERROR_MESSAGES: Readonly<Record<DublaErrorCode, ErrorPresentation>> = {
  MIC_PERMISSION_DENIED: {
    title: 'Sem acesso ao microfone',
    message: 'Você precisa autorizar o microfone para dublar. Nada é enviado — sua voz fica no seu aparelho.',
    action: 'Clique em Tentar novamente e escolha "Permitir".',
    recordingPreserved: null,
    retryable: true,
  },
  MIC_PERMISSION_BLOCKED: {
    title: 'Microfone bloqueado',
    message: 'O navegador não vai mais perguntar porque o acesso foi bloqueado para este site.',
    action: 'Clique no cadeado ao lado do endereço, libere o microfone e recarregue a página.',
    recordingPreserved: null,
    retryable: false,
  },
  MIC_NOT_FOUND: {
    title: 'Nenhum microfone encontrado',
    message: 'Não localizamos nenhum microfone conectado a este aparelho.',
    action: 'Conecte um microfone ou fone com microfone. Detectamos automaticamente.',
    recordingPreserved: null,
    retryable: true,
  },
  MIC_BUSY: {
    title: 'Microfone em uso',
    message: 'Outro programa está usando seu microfone agora.',
    action: 'Feche chamadas ou gravadores abertos e tente de novo.',
    recordingPreserved: null,
    retryable: true,
  },
  MIC_OVERCONSTRAINED: {
    title: 'Microfone incompatível',
    message: 'Este microfone não aceita a configuração que pedimos.',
    action: 'Vamos tentar com a configuração padrão.',
    recordingPreserved: null,
    retryable: true,
  },
  MIC_DISCONNECTED: {
    title: 'Microfone desconectado',
    message: 'O microfone foi desconectado no meio da gravação. Guardamos o que já tinha sido gravado.',
    action: 'Você pode ouvir o trecho ou gravar de novo.',
    recordingPreserved: true,
    retryable: true,
  },
  MIC_DEVICE_CHANGED: {
    title: 'Dispositivos mudaram',
    message: 'A lista de microfones mudou. Continuamos usando o mesmo dispositivo desta gravação.',
    recordingPreserved: true,
    retryable: false,
  },

  VIDEO_LOAD_FAILED: {
    title: 'Não foi possível carregar a cena',
    message: 'O vídeo desta cena não carregou.',
    action: 'Verifique sua conexão e tente novamente.',
    recordingPreserved: null,
    retryable: true,
  },
  VIDEO_BUFFERING: {
    title: 'Carregando a cena',
    message: 'Estamos terminando de carregar o vídeo. A gravação só começa quando tudo estiver pronto.',
    recordingPreserved: null,
    retryable: false,
  },
  VIDEO_HAS_AUDIO_TRACK: {
    title: 'Cena inválida',
    message: 'Esta cena foi publicada com faixa de áudio, o que não é permitido no modo de dublagem.',
    recordingPreserved: null,
    retryable: false,
  },

  RECORDING_EMPTY: {
    title: 'Gravação curta demais',
    message: 'Quase nada foi gravado.',
    action: 'Tente de novo e fale durante a cena.',
    recordingPreserved: false,
    retryable: true,
  },
  RECORDING_TOO_QUIET: {
    title: 'Quase não conseguimos ouvir sua voz',
    message: 'O áudio ficou muito baixo para analisar.',
    action: 'Chegue mais perto do microfone, fale mais alto e tente de novo.',
    recordingPreserved: true,
    retryable: true,
  },
  RECORDING_CLIPPING: {
    title: 'Sua voz está estourando',
    message: 'O volume passou do limite e distorceu partes da gravação.',
    action: 'Afaste-se um pouco do microfone na próxima tentativa.',
    recordingPreserved: true,
    retryable: true,
  },
  RECORDING_FAILED: {
    title: 'A gravação falhou',
    message: 'Algo interrompeu a captura do áudio antes de terminar.',
    action: 'Tente novamente.',
    recordingPreserved: false,
    retryable: true,
  },
  TAB_SUSPENDED: {
    title: 'A aba ficou em segundo plano',
    message:
      'O navegador pausou esta aba durante a gravação, então o encaixe com o vídeo pode não estar correto. Guardamos o áudio mesmo assim.',
    action: 'Para um resultado confiável, grave com esta aba visível.',
    recordingPreserved: true,
    retryable: true,
  },
  AUDIO_INTERRUPTED: {
    title: 'Gravação interrompida',
    message: 'Uma ligação, notificação ou troca de aplicativo interrompeu a gravação. Guardamos o que deu tempo.',
    action: 'Você pode ouvir o trecho ou gravar de novo.',
    recordingPreserved: true,
    retryable: true,
  },
  BROWSER_UNSUPPORTED: {
    title: 'Navegador sem suporte',
    message: 'Seu navegador não tem os recursos de áudio que o Dubla Aí precisa para gravar em sincronia.',
    action: 'Use uma versão recente de Chrome, Edge, Firefox ou Safari.',
    recordingPreserved: null,
    retryable: false,
  },

  ANALYSIS_FAILED: {
    title: 'Não conseguimos calcular seu resultado',
    message: 'Sua gravação está salva e pode ser ouvida normalmente — só a análise falhou.',
    action: 'Calcular de novo não custa nada.',
    recordingPreserved: true,
    retryable: true,
  },
  REFERENCE_FEATURES_MISSING: {
    title: 'Referência indisponível',
    message: 'Os dados de referência desta cena não carregaram, então não dá para comparar sua dublagem.',
    action: 'Você ainda pode gravar e ouvir o resultado.',
    recordingPreserved: true,
    retryable: true,
  },

  NETWORK_OFFLINE: {
    title: 'Você está sem conexão',
    message: 'Gravar e ouvir continuam funcionando normalmente — tudo acontece no seu aparelho.',
    recordingPreserved: true,
    retryable: false,
  },
  STORAGE_QUOTA_EXCEEDED: {
    title: 'Sem espaço para salvar',
    message: 'O espaço reservado para este site acabou. Sua gravação atual continua disponível nesta sessão.',
    action: 'Apague gravações antigas para liberar espaço.',
    recordingPreserved: true,
    retryable: true,
  },
  STORAGE_UNAVAILABLE: {
    title: 'Não é possível salvar neste navegador',
    message: 'Seu navegador não permite guardar arquivos deste site. Você pode gravar e ouvir, mas não salvar.',
    recordingPreserved: true,
    retryable: false,
  },
  SCENE_NOT_FOUND: {
    title: 'Cena não encontrada',
    message: 'Esta cena não existe ou saiu do ar.',
    action: 'Veja outras cenas disponíveis.',
    recordingPreserved: null,
    retryable: false,
  },

  UPLOAD_FAILED: {
    title: 'Envio interrompido',
    message: 'Não conseguimos enviar sua gravação. Ela continua guardada aqui.',
    action: 'Tente enviar novamente.',
    recordingPreserved: true,
    retryable: true,
  },
  UPLOAD_URL_EXPIRED: {
    title: 'Link de envio expirou',
    message: 'O envio demorou mais que o esperado. Sua gravação está intacta.',
    action: 'Tente enviar novamente.',
    recordingPreserved: true,
    retryable: true,
  },
  JOB_DUPLICATE: {
    title: 'Processamento já em andamento',
    message: 'Esta gravação já está sendo processada.',
    recordingPreserved: true,
    retryable: false,
  },
  RENDER_FAILED: {
    title: 'Não conseguimos gerar o vídeo',
    message: 'Sua gravação está intacta — só a geração do vídeo para compartilhar falhou.',
    action: 'Tente gerar novamente.',
    recordingPreserved: true,
    retryable: true,
  },
  AUTH_EXPIRED: {
    title: 'Sua sessão expirou',
    message: 'Entre de novo para continuar. Sua gravação foi preservada.',
    action: 'Entrar',
    recordingPreserved: true,
    retryable: true,
  },
  QUOTA_EXCEEDED: {
    title: 'Limite de uso atingido',
    message: 'Você atingiu o limite de análises deste período.',
    recordingPreserved: true,
    retryable: false,
  },
  UNKNOWN_ERROR: {
    title: 'Algo saiu do previsto',
    message: 'Encontramos um problema que ainda não sabemos explicar direito.',
    action: 'Tente novamente. Se continuar, recarregue a página.',
    recordingPreserved: null,
    retryable: true,
  },
}

export class DublaError extends Error {
  readonly code: DublaErrorCode
  readonly presentation: ErrorPresentation
  override readonly cause?: unknown

  constructor(code: DublaErrorCode, options?: { cause?: unknown; detail?: string }) {
    const presentation = ERROR_MESSAGES[code]
    super(options?.detail ? `${code}: ${options.detail}` : code)
    this.name = 'DublaError'
    this.code = code
    this.presentation = presentation
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

export function isDublaError(value: unknown): value is DublaError {
  return value instanceof DublaError
}

/**
 * Traduz o erro de `getUserMedia` para a taxonomia.
 *
 * Os nomes variam entre navegadores para a mesma condição — Chrome usa
 * `NotReadableError` onde Firefox historicamente usou `TrackStartError`.
 * Tratamos os dois como a mesma coisa.
 */
export function mapMediaError(error: unknown): DublaErrorCode {
  if (!(error instanceof Error)) return 'UNKNOWN_ERROR'

  switch (error.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'MIC_PERMISSION_DENIED'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'MIC_NOT_FOUND'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'MIC_BUSY'
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'MIC_OVERCONSTRAINED'
    case 'AbortError':
      return 'RECORDING_FAILED'
    case 'SecurityError':
      return 'MIC_PERMISSION_BLOCKED'
    default:
      return 'UNKNOWN_ERROR'
  }
}

export function toDublaError(error: unknown): DublaError {
  if (isDublaError(error)) return error
  return new DublaError(mapMediaError(error), { cause: error })
}
