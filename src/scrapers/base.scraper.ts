import axios, { type AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import type { Piso, ScrapingTask, ScrapingResult, ScraperOptions } from '../types';
import { logger } from '../services/logger';
import { prisma } from '../db/prisma';
import { mapearAMacroZona } from '../utils/zonas-diccionario';

// ============================================================
// BASE SCRAPER — Clase abstracta para todos los extractores
// ============================================================

/**
 * Clase base que implementa:
 * - Peticiones HTTP via Bright Data Web Unlocker (proxy residencial)
 * - User-Agents rotativos y headers anti-bot realistas
 * - Session IDs únicos por petición + country targeting
 * - Retry automático con backoff exponencial + jitter aleatorio
 * - Validación de respuestas (detección de bloqueos)
 * - Interfaz estándar para todos los scrapers hijos
 */
export abstract class BaseScraper {
  protected readonly options: ScraperOptions;
  private readonly httpClient: AxiosInstance;

  // ── Pool de User-Agents rotativos ──────────────────────────
  // Chrome, Firefox y Edge en Windows, macOS y Linux.
  // Se selecciona uno pseudoaleatoriamente en cada petición para
  // que el fingerprint del navegador varíe y no sea predecible.
  private static readonly USER_AGENTS: readonly string[] = [
    // Chrome — Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    // Chrome — macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    // Firefox — Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
    // Firefox — macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0',
    // Edge — Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
    // Chrome — Linux (menos común, añade variedad)
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  ];

  // ── Headers anti-bot que simulan navegación real ───────────
  // Los navegadores modernos envían estas cabeceras en cada
  // petición de navegación. Su ausencia es una señal de bot.
  private static readonly ANTI_BOT_HEADERS: Record<string, string> = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
    'DNT': '1',
  };

  constructor(options?: Partial<ScraperOptions>) {
    const envMaxRetries = process.env['MAX_RETRIES'] ? parseInt(process.env['MAX_RETRIES'], 10) : undefined;
    this.options = {
      maxRetries: envMaxRetries !== undefined ? envMaxRetries : (options?.maxRetries ?? 1),
      requestDelayMs: parseInt(process.env['REQUEST_DELAY_MS'] ?? '2000', 10),
      // Por defecto OFF: cada portal/carril activa BD solo si está en allowlist + presupuesto
      useBrightData: options?.useBrightData ?? false,
      ...options,
    };
    if (envMaxRetries !== undefined) {
      this.options.maxRetries = envMaxRetries;
    }

    this.httpClient = axios.create({
      timeout: 60_000, // 60 segundos — Idealista puede tardar 60-90s en resolver
    });
  }

  // ------------------------------------------------------------
  // Método abstracto que cada scraper hijo debe implementar
  // ------------------------------------------------------------

  /**
   * Parsea el HTML de una página y extrae la lista de pisos.
   * Cada scraper hijo implementa su lógica específica con cheerio.
   *
   * @param html - HTML completo de la página scrapeada
   * @param task - Contexto de la tarea (portal, ciudad, url)
   * @returns Array de pisos extraídos y validados
   */
  protected abstract parse(html: string, task: ScrapingTask): Piso[];

  /**
   * (Opcional) Determina si un piso necesita Deep Scraping (entrar a su anuncio).
   * Solo entramos si faltan datos clave para el matching VIP (zona, habitaciones o tipo).
   */
  protected requiresDeepScraping(piso: Piso): boolean {
    return !piso.zona || piso.habitaciones === undefined || !piso.tipo;
  }

  /**
   * (Opcional) Extrae detalles adicionales directamente del anuncio individual.
   * La implementación base extrae todo el texto de la página para completar
   * zona/habitaciones/tipo si faltan, y un resumen corto (máx. 120 caracteres).
   */
  protected parseDetalle(html: string, piso: Piso): void {
    const $ = this.loadHTML(html);

    // Buscar descripciones usando selectores CSS (los programadores suelen usar 'description' en inglés para el código,
    // pero añadimos también en español/catalán por si acaso). Solo se usa para completar zona/tipo/habitaciones y resumen.
    let descripcion = this.limpiarTexto($('[class*="description"], [class*="Description"], [id*="description"], [class*="descripcion"], [class*="descripcio"], .readMoreText, p.body-text-s').text());

    // Si la descripción está muy escondida, buscar encabezados con el texto visible "Descripción" (o catalán "Descripció")
    if (!descripcion || descripcion.length < 20) {
      const heading = $('h2, h3, h4, h5, div, span').filter((_i, el) => {
        const text = $(el).text().toLowerCase();
        return text.includes('descripci') || text.includes('característic');
      });
      if (heading.length > 0) {
        descripcion = this.limpiarTexto(heading.parent().text());
      }
    }

    if (descripcion && descripcion.length > 20 && !piso.resumen) {
      piso.resumen = descripcion.slice(0, 120);
    }

    // Extraer todo el texto visible (ignorando scripts/estilos)
    $('script, style, noscript').remove();
    const todoElTexto = this.limpiarTexto($('body').text());

    // Extraer datos usando la información de la página completa
    if (!piso.zona) piso.zona = this.parsearZona(todoElTexto, piso.ciudad);
    if (piso.habitaciones === undefined) piso.habitaciones = this.parsearHabitaciones(todoElTexto);
    if (!piso.tipo) piso.tipo = this.parsearTipo(todoElTexto);
  }

  // ------------------------------------------------------------
  // Método público principal
  // ------------------------------------------------------------

  /**
   * Scrapea una tarea completa con gestión de errores y reintentos.
   */
  async scrape(task: ScrapingTask): Promise<ScrapingResult> {
    const startTime = Date.now();
    let renderJS = false;
    let mobileRetry = false;

    for (let intento = 1; intento <= this.options.maxRetries; intento++) {
      try {
        logger.info(
          `🔍 [${task.portal}] ${task.ciudad} p.${task.pagina} — Intento ${intento}/${this.options.maxRetries} (JS: ${renderJS}, Mobile: ${mobileRetry})`
        );

        const html = await this.fetchHTML(task.url, renderJS, mobileRetry);

        // Validar que la respuesta no sea una página de bloqueo
        const errorDetectado = this.detectarBloqueo(html);
        if (errorDetectado) {
          throw new Error(`Bloqueo detectado: ${errorDetectado}`);
        }

        const pisosList = this.parse(html, task);
        
        // --- DEEP SCRAPING (Modo Híbrido) ---
        // Si el piso le falta información vital, entramos en el anuncio.
        // OPTIMIZACIÓN: Sólo hacemos Deep Scraping si el anuncio NO está ya registrado en la BD.
        const ids = pisosList.map((p) => p.id);
        const existingPisos = ids.length > 0 ? await prisma.piso.findMany({
          where: {
            id_piso: { in: ids },
            portal: task.portal
          },
          select: { id_piso: true }
        }) : [];
        const existingIds = new Set(existingPisos.map((p) => p.id_piso));
        const deepMax = parseInt(process.env['DEEP_SCRAPE_MAX_PER_PAGE'] ?? '2', 10);
        let deepHechos = 0;
        const deepUsaBd = process.env['DEEP_SCRAPE_USE_BD'] === 'true';

        for (const piso of pisosList) {
          if (existingIds.has(piso.id)) {
            logger.info(`   ⏭️ Saltando Deep Scraping: piso ${piso.id} ya existe en la BD.`);
            continue;
          }

          if (this.requiresDeepScraping(piso)) {
            if (deepHechos >= deepMax) {
              logger.info(`   ⏭️ Deep Scraping: tope ${deepMax} por página alcanzado.`);
              break;
            }
            try {
              logger.info(`   🕵️ Deep Scraping: entrando al anuncio -> ${piso.id}`);
              // Por defecto deep solo en directo (ahorro Unlocker); BD solo si DEEP_SCRAPE_USE_BD=true
              const prevBd = this.options.useBrightData;
              if (!deepUsaBd) this.options.useBrightData = false;
              const detalleHtml = await this.fetchHTML(piso.enlace, false, false);
              this.options.useBrightData = prevBd;

              if (!this.detectarBloqueo(detalleHtml)) {
                this.parseDetalle(detalleHtml, piso);
                deepHechos++;
              } else {
                 logger.warn(`   ⚠️ Bloqueo en deep scrape ${piso.id}. Omitido.`);
              }

              const deepScrapeDelay = Math.floor(Math.random() * 3000) + 3000;
              logger.info(`   ⏳ Esperando ${deepScrapeDelay}ms antes del siguiente anuncio...`);
              await this.sleep(deepScrapeDelay);
            } catch (err) {
              logger.warn(`   ⚠️ Fallo en Deep Scraping para ${piso.id}: ${err}`);
            }
          }
        }

        const pisos = pisosList;

        logger.info(
          `✅ [${task.portal}] ${task.ciudad} p.${task.pagina} — ${pisos.length} pisos extraídos (${Date.now() - startTime}ms)`
        );

        return { task, pisos };
      } catch (error) {
        const mensaje = error instanceof Error ? error.message : String(error);
        logger.warn(
          `⚠️  [${task.portal}] ${task.ciudad} p.${task.pagina} — Error intento ${intento}: ${mensaje}`
        );

        if (mensaje.includes('Bloqueo detectado')) {
          // Estrategia escalonada:
          // Intento 2 → Mobile UA (evade filtros de dispositivo)
          // Intento 3 → Mobile UA + render:true (Chrome headless completo)
          if (intento === 1) {
            mobileRetry = true;
            logger.info(`   🔄 Activando modo Mobile para evadir el bloqueo...`);
          } else if (intento === 2) {
            renderJS = true;
            logger.info(`   🔄 Activando renderizado JS + Mobile para evadir el bloqueo...`);
          }
        }

        if (intento < this.options.maxRetries) {
          const baseDelay = this.options.requestDelayMs * Math.pow(2, intento - 1);
          const jitter = (Math.random() * 0.8) + 0.6;
          const delay = Math.round(baseDelay * jitter);
          logger.info(`   ⏳ Esperando ${delay}ms antes del siguiente intento (jitter aplicado)...`);
          await this.sleep(delay);
        } else {
          logger.error(
            `❌ [${task.portal}] ${task.ciudad} p.${task.pagina} — Todos los intentos fallaron.`
          );
          return { task, pisos: [], error: mensaje };
        }
      }
    }

    return { task, pisos: [], error: 'Máximo de reintentos alcanzado' };
  }

  // ------------------------------------------------------------
  // Petición HTTP via Bright Data
  // ------------------------------------------------------------

  /**
   * Realiza la petición HTTP usando Bright Data como proxy.
   * Si usePlaywright=true, usa el Scraping Browser real.
   * Si useBrightData=false, hace la petición directa (útil para tests).
   */
  protected async fetchHTML(url: string, renderJS: boolean = false, mobile: boolean = false): Promise<string> {
    if (this.options.useBrightData) {
      try {
        logger.info(`   🆓 Intentando conexión directa sin proxy...`);
        const htmlDirect = await this.fetchDirect(url);
        const bloqueo = this.detectarBloqueo(htmlDirect);
        if (!bloqueo) {
          logger.info(`   ✅ Conexión directa exitosa (Ahorro de 1 crédito)`);
          return htmlDirect;
        }
        logger.info(`   🛡️ Bloqueo detectado en conexión directa: ${bloqueo}. Cambiando a Web Unlocker...`);
      } catch (error) {
        logger.info(`   🛡️ WAF bloqueó la conexión directa. Cambiando a Web Unlocker API...`);
      }
      return this.fetchViaBrightData(url, renderJS, mobile);
    }
    
    return this.fetchDirect(url);
  }

  /**
   * Petición via Bright Data Web Unlocker API.
   *
   * Estrategia de reintentos escalonada:
   * - Intento 1: Desktop UA, sin renderizado JS
   * - Intento 2: Mobile UA (device_type='mobile'), sin JS — evade filtros de dispositivo
   * - Intento 3: Mobile UA + render:true — Chrome headless completo
   *
   * NOTA: 'headers' y 'session_id' NO son campos del Web Unlocker API
   */
  private async fetchViaBrightData(url: string, renderJS: boolean, mobile: boolean = false): Promise<string> {
    const apiKey = process.env['BRIGHTDATA_API_KEY'];
    const zone = process.env['BRIGHTDATA_ZONE'] ?? 'web_unlocker1';
    const country = process.env['BRIGHTDATA_COUNTRY'] ?? 'es';

    if (!apiKey) {
      throw new Error('BRIGHTDATA_API_KEY no configurada en .env');
    }

    const body: Record<string, unknown> = {
      zone,
      url,
      format: 'raw',
      render: renderJS,
      country,
    };

    // Mobile mode: Bright Data cambia la IP a una residencial móvil y
    // ajusta el TLS fingerprint — esto evade filtros que distinguen
    // escritorio/móvil y a veces tiene rate limits más permisivos.
    if (mobile) {
      body['device_type'] = 'mobile';
    }

    const response = await this.httpClient.post<string>(
      'https://api.brightdata.com/request',
      body,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        responseType: 'text',
      }
    );

    const html = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);

    return html;
  }

  /**
   * Petición directa sin proxy (solo para tests/desarrollo local).
   * Usa User-Agent rotativo y headers anti-bot completos.
   */
  private async fetchDirect(url: string): Promise<string> {
    const userAgent = this.getRandomUserAgent();

    const response = await this.httpClient.get<string>(url, {
      headers: {
        'User-Agent': userAgent,
        ...BaseScraper.ANTI_BOT_HEADERS,
      },
      responseType: 'text',
    });

    return response.data;
  }

  // ------------------------------------------------------------
  // Selección aleatoria de User-Agent
  // ------------------------------------------------------------

  /**
   * Devuelve un User-Agent aleatorio del pool.
   * Usa Math.random() para asegurar distribución uniforme.
   */
  private getRandomUserAgent(): string {
    const pool = BaseScraper.USER_AGENTS;
    const index = Math.floor(Math.random() * pool.length);
    return pool[index]!;
  }

  // ------------------------------------------------------------
  // Detección de bloqueos y respuestas inválidas
  // ------------------------------------------------------------

  /**
   * Detecta si la respuesta de Bright Data contiene un error conocido.
   * @returns mensaje de error, o null si la respuesta es válida
   */
  private detectarBloqueo(html: string): string | null {
    const htmlLower = html.toLowerCase();
    
    if (html.includes('No property named')) {
      return 'Error de Bright Data: "No property named"';
    }
    if (html.includes('Access Denied') && html.trim().length < 2000) {
      return 'Acceso denegado por el portal';
    }
    if (html.includes('cf-challenge') || html.includes('cf-browser-verification')) {
      return 'Cloudflare challenge detectado';
    }
    // Detectar DataDome/PerimeterX de forma específica (no palabras genéricas)
    // '/robots.txt' puede aparecer en sitemaps y footers normales — usamos
    // frases de bloqueo real: "disallowed", "denied", "blocked" junto a bot/robot.
    if (htmlLower.includes('datadome') || htmlLower.includes('px-captcha') || htmlLower.includes('px-block')) {
      return 'Captcha avanzado detectado (Datadome / PerimeterX)';
    }
    if (htmlLower.includes('bot.txt') || htmlLower.includes('automated block') || htmlLower.includes('access to this page has been denied')) {
      return 'Bloqueo explícito de bots';
    }
    if (htmlLower.includes('are you human') || htmlLower.includes('verify you are human') || htmlLower.includes('i am human')) {
      return 'Verificación humana solicitada';
    }
    
    if (html.trim().length < 500) {
      return 'Respuesta HTML demasiado corta (posible bloqueo)';
    }
    return null;
  }

  // ------------------------------------------------------------
  // Utilidades de parseo disponibles para todos los hijos
  // ------------------------------------------------------------

  /**
   * Carga el HTML en cheerio y devuelve el objeto $ para parseo.
   */
  protected loadHTML(html: string): cheerio.CheerioAPI {
    return cheerio.load(html);
  }

  /**
   * Limpia un texto de precio y lo convierte a número entero.
   * Maneja formatos: "1.200 €", "1200€/mes", "€ 950"
   * Evita falsos positivos como "Desde 1.200 € (2 habitaciones)" -> 12002.
   *
   * @returns número entero, o 0 si no se puede parsear
   */
  protected parsearPrecio(textoPrecio: string): number {
    if (!textoPrecio) return 0;
    
    // Normalizar separador de miles (1.200 → 1200, 1,200 → 1200)
    const normalizado = textoPrecio
      .replace(/(\d)\.(\d{3})/g, '$1$2')  // 1.200 → 1200
      .replace(/(\d),(\d{3})/g, '$1$2');  // 1,200 → 1200
      
    // Extraer primer número de 2-5 dígitos (rango de precio realista)
    const match = normalizado.match(/\d{2,5}/);
    if (!match) return 0;
    
    const precio = parseInt(match[0], 10);
    return (precio > 0 && precio <= 10000) ? precio : 0; // Sanity check
  }

  /**
   * Asegura que una URL sea absoluta. Si es relativa, antepone el dominio base.
   */
  protected resolverURL(urlRelativa: string, dominioBase: string): string {
    if (!urlRelativa) return '';
    if (urlRelativa.startsWith('http://') || urlRelativa.startsWith('https://')) {
      return urlRelativa;
    }
    const base = dominioBase.replace(/\/$/, '');
    const ruta = urlRelativa.startsWith('/') ? urlRelativa : `/${urlRelativa}`;
    return `${base}${ruta}`;
  }

  /**
   * Elimina duplicados de un array de pisos por su id.
   */
  protected deduplicar(pisos: Piso[]): Piso[] {
    return Array.from(
      new Map(pisos.map((p) => [p.id, p])).values()
    );
  }

  protected limpiarTexto(texto: string): string {
    return texto.replace(/\s+/g, ' ').trim();
  }

  /**
   * Extrae el número de habitaciones de un texto.
   * Ej: "2 hab.", "3 habitaciones", "1 dormitorio"
   */
  protected parsearHabitaciones(texto: string): number | undefined {
    if (!texto) return undefined;
    
    // Normalizar texto para números en letra comunes
    let t = texto.toLowerCase();
    t = t.replace(/un\b|una\b/g, '1');
    t = t.replace(/dos\b/g, '2');
    t = t.replace(/tres\b/g, '3');
    t = t.replace(/cuatro\b/g, '4');
    t = t.replace(/cinco\b/g, '5');

    const match = t.match(/(\d+)\s*(hab|dormitorio|habitaci)/i);
    if (match) return parseInt(match[1], 10);
    if (t.includes('estudio')) return 0; // Estudio = 0 habs
    return undefined;
  }

  /**
   * Determina el tipo de inmueble.
   * Ej: "Piso en alquiler", "Habitación en alquiler"
   */
  protected parsearTipo(texto: string): string | undefined {
    if (!texto) return undefined;
    const t = texto.toLowerCase();
    
    // PRIORIDAD 1: Buscar expresiones claras de que es alquiler de habitación
    if (
      t.match(/alquiler de habitaci/i) || 
      t.match(/habitación en alquiler/i) || 
      t.match(/habitacion en piso/i) ||
      t.match(/piso compartido/i) || 
      t.match(/compañer[oa] de piso/i) || 
      t.includes('/habitacion/') || 
      t.includes('/share/')
    ) {
      return 'Habitación';
    }

    // PRIORIDAD 2: Tipos principales
    if (t.includes('estudio') || t.includes('piso') || t.includes('apartamento') || t.includes('dúplex') || t.includes('ático')) return 'Piso';
    if (t.includes('chalet') || t.includes('casa') || t.includes('villa') || t.includes('finca') || t.includes('masía')) return 'Casa';
    
    // Fallback
    if (t.includes('habitaci') || t.includes('habitación')) return 'Habitación';
    
    return undefined;
  }

  /**
   * Extrae la macro-zona SOLO del diccionario de la ciudad del anuncio.
   * Evita colisiones BCN↔VLC (Eixample, Ciutat Vella, etc.).
   */
  protected parsearZona(texto: string, ciudad?: string): string | undefined {
    if (!texto || !ciudad) return undefined;
    return mapearAMacroZona(texto, ciudad);
  }

  // ------------------------------------------------------------
  // Utilidad de delay
  // ------------------------------------------------------------

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
