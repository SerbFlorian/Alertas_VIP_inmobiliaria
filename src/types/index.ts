// ============================================================
// TIPOS CENTRALES DEL SISTEMA — Alertas VIP Telegram
// ============================================================

// ------------------------------------------------------------
// Inmueble / Piso
// ------------------------------------------------------------

/** Portales soportados por el sistema */
export type Portal =
  | 'idealista'
  | 'idealista-new'   // Idealista filtrado por "publicado hoy"
  | 'pisoscom'
  | 'habitaclia'
  | 'yaencontre'
  | 'indomio'
  | 'rentola'
  | 'fotocasa'
  | 'rentumo'
  | 'spotahome'
  | 'uniplaces'
  | 'milanuncios'     // Clasificados particulares, precios más bajos
  | 'wallapop'        // Marketplace C2C, sin comisión de agencia
  | 'vibbo'           // Ex-Segundamano, particulares Adevinta
  | 'nuroa';          // Agregador: indexa portales locales y agencias pequeñas


/** Ciudades monitorizadas */
export type Ciudad = 'barcelona' | 'madrid' | 'valencia';

/** Precio máximo permitido por ciudad (filtro anti-spam) */
export const PRECIO_MAX_POR_CIUDAD: Record<Ciudad, number> = {
  barcelona: 1000,
  madrid: 950,
  valencia: 800,
};

/** Representa un inmueble extraído de cualquier portal */
export interface Piso {
  id: string;           // ID único (del portal o derivado de URL)
  titulo: string;
  precio: number;       // En euros, ya limpio (sin símbolos)
  enlace: string;       // URL completa al anuncio
  portal: Portal;
  ciudad: Ciudad;
  zona?: string;        // Zona extraída para matching VIP (ej. "Eixample (BCN)")
  zonaNorm?: string;    // Zona normalizada (minúsculas, sin acentos) para índices/agrupación
  habitaciones?: number; // Número de habitaciones
  tipo?: string;        // "Piso", "Habitación", "Casa", etc.
  resumen?: string;      // Detalles/resumen corto (máx. 120 caracteres)
}

/** Fila tal como se almacena en la BD */
export interface PisoDB extends Piso {
  publicado_en_telegram: boolean;
  telegram_message_id?: number | null;
  telegram_chat_id?: string | null;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------
// Scraping
// ------------------------------------------------------------

/** Tarea de scraping: un portal + ciudad + URL concreta */
export interface ScrapingTask {
  portal: Portal;
  ciudad: Ciudad;
  url: string;
  pagina: number;
}

/** Resultado del scraper: pisos extraídos de una URL */
export interface ScrapingResult {
  task: ScrapingTask;
  pisos: Piso[];
  error?: string;       // Si hubo error, se registra aquí (no rompe el flujo)
}

/** Opciones de configuración del BaseScraper */
export interface ScraperOptions {
  maxRetries: number;
  requestDelayMs: number;
  useBrightData: boolean;
}

// ------------------------------------------------------------
// Usuarios VIP
// ------------------------------------------------------------

export type EstadoUsuario = 'Pendiente_Pago' | 'Pagado' | 'Cancelando' | 'Cancelado';

export interface NotificacionEnviada {
  id: number;
  telegram_id: string;
  id_piso: string;
  portal: string;
  enviado_en: Date;
}


