import type { ScrapingTask, Portal, Ciudad } from '../types';
import { PRECIO_MAX_POR_CIUDAD } from '../types';
import { IdealistaScraper } from '../scrapers/idealista.scraper';
import { IdealistaNewScraper } from '../scrapers/idealista-new.scraper';
import { PisoscomScraper } from '../scrapers/pisoscom.scraper';
import { HabitacliaScraper } from '../scrapers/habitaclia.scraper';
import { YaencontreScraper } from '../scrapers/yaencontre.scraper';
import { IndominioScraper } from '../scrapers/indomio.scraper';
import { RentolaScraper } from '../scrapers/rentola.scraper';
import { FotocasaScraper } from '../scrapers/fotocasa.scraper';
import { RentumoScraper } from '../scrapers/rentumo.scraper';
import { SpotahomeScraper } from '../scrapers/spotahome.scraper';
import { UniplacesScraper } from '../scrapers/uniplaces.scraper';
import { NuroaScraper } from '../scrapers/nuroa.scraper';
import { BaseScraper } from '../scrapers/base.scraper';
import { upsertPisos, logScraperEjecucion, getEstadisticasPisos, refreshInventoryStats } from '../db/queries';
import { logger } from '../services/logger';
import {
  getLastScrapedPage,
  setLastScrapedPage,
  isLockedToFront,
  setLockedToFront,
} from '../services/scraper-state.service';
import type { Piso } from '../types';

// ------------------------------------------------------------
// Rondas equilibradas (6 + 6). Ambas pueden usar Bright Data (directo → Unlocker).
// round_1: portales más ligeros · cada 2 h
// round_2: portales más duros (Idealista/Fotocasa/CF) · cada 4 h
// ------------------------------------------------------------

const PORTALES_ROUND_1: Portal[] = [
  'indomio', 'nuroa', 'rentola', 'rentumo', 'uniplaces', 'yaencontre',
];

const PORTALES_ROUND_2: Portal[] = [
  'idealista', 'idealista-new', 'fotocasa', 'pisoscom', 'habitaclia', 'spotahome',
];

// ------------------------------------------------------------
// Guard de horario — Lunes a Viernes, 08:00 a 20:00 (hora local, TZ=Europe/Madrid)
// ------------------------------------------------------------

export function shouldRunScrapers(): boolean {
  const ahora = new Date();
  const dia = ahora.getDay(); // 0=domingo, 1=lunes, ..., 6=sábado
  const hora = ahora.getHours();
  return dia >= 1 && dia <= 5 && hora >= 8 && hora <= 20;
}

// ============================================================
// SCRAPER JOB — 15 portales × 3 ciudades × N páginas
// ============================================================
// Portales cubiertos y su nivel de protección anti-bot:
//
// 🟢 Sin problema:
//   idealista      — Cloudflare (Web Unlocker + retry móvil lo pasa)
//   idealista-new  — Misma infra, filtrado por "publicado hoy"
//   pisoscom       — Cloudflare básico
//   habitaclia     — Cloudflare básico
//   yaencontre     — Mínima protección
//   indomio        — CDN estándar
//   rentumo        — Sin protección significativa
//   spotahome      — Sin protección significativa
//   uniplaces      — Sin protección significativa
//   milanuncios    — React + SSR, Cloudflare básico
//   wallapop       — API REST pública (JSON)
//   vibbo          — Portal clásico, mínima protección
//   nuroa          — Agregador SSR, mínima protección
//   rentola        — Next.js + SSR (datos en __NEXT_DATA__)
//
// 🔴 Protección agresiva (DataDome):
//   fotocasa       — DataDome ML. Intentamos con mobile+JS pero puede fallar.
//                   Sin proxy residencial dedicado, solo conseguimos ~20-30% éxito.
// ============================================================

const TAREAS_BASE: Array<{ portal: Portal; ciudad: Ciudad; url: string }> = [

  // ── IDEALISTA — Búsqueda estándar por precio ──────────────
  { portal: 'idealista', ciudad: 'barcelona', url: 'https://www.idealista.com/alquiler-viviendas/barcelona-barcelona/con-precio-hasta_1000/' },
  { portal: 'idealista', ciudad: 'madrid',    url: 'https://www.idealista.com/alquiler-viviendas/madrid-madrid/con-precio-hasta_950/' },
  { portal: 'idealista', ciudad: 'valencia',  url: 'https://www.idealista.com/alquiler-viviendas/valencia-valencia/con-precio-hasta_800/' },

  // ── IDEALISTA NEW — Pisos publicados hoy (los más frescos) ─
  { portal: 'idealista-new', ciudad: 'barcelona', url: 'https://www.idealista.com/alquiler-viviendas/barcelona-barcelona/con-precio-hasta_1000/fecha-publicacion-hoy/' },
  { portal: 'idealista-new', ciudad: 'madrid',    url: 'https://www.idealista.com/alquiler-viviendas/madrid-madrid/con-precio-hasta_950/fecha-publicacion-hoy/' },
  { portal: 'idealista-new', ciudad: 'valencia',  url: 'https://www.idealista.com/alquiler-viviendas/valencia-valencia/con-precio-hasta_800/fecha-publicacion-hoy/' },

  // ── PISOS.COM ───────────────────────────────────────────────
  { portal: 'pisoscom', ciudad: 'barcelona', url: 'https://www.pisos.com/alquiler/pisos-barcelona/hasta-1000/' },
  { portal: 'pisoscom', ciudad: 'madrid',    url: 'https://www.pisos.com/alquiler/pisos-madrid/hasta-950/' },
  { portal: 'pisoscom', ciudad: 'valencia',  url: 'https://www.pisos.com/alquiler/pisos-valencia/hasta-800/' },

  // ── HABITACLIA ─────────────────────────────────────────────
  { portal: 'habitaclia', ciudad: 'barcelona', url: 'https://www.habitaclia.com/alquiler-barcelona.htm?pmax=1000' },
  { portal: 'habitaclia', ciudad: 'madrid',    url: 'https://www.habitaclia.com/alquiler-pisos-madrid.htm?pmax=950' },
  { portal: 'habitaclia', ciudad: 'valencia',  url: 'https://www.habitaclia.com/alquiler-pisos-valencia.htm?pmax=800' },

  // ── YAENCONTRE ─────────────────────────────────────────────
  { portal: 'yaencontre', ciudad: 'barcelona', url: 'https://www.yaencontre.com/alquiler/pisos/barcelona/f--1000euros' },
  { portal: 'yaencontre', ciudad: 'madrid',    url: 'https://www.yaencontre.com/alquiler/pisos/madrid/f--950euros' },
  { portal: 'yaencontre', ciudad: 'valencia',  url: 'https://www.yaencontre.com/alquiler/pisos/valencia/f--800euros' },

  // ── INDOMIO ────────────────────────────────────────────────
  { portal: 'indomio', ciudad: 'barcelona', url: 'https://www.indomio.es/alquiler-casas/barcelona-capital/?criterio=rilevanza&prezzoMassimo=1000' },
  { portal: 'indomio', ciudad: 'madrid',    url: 'https://www.indomio.es/alquiler-casas/madrid-capital/?criterio=rilevanza&prezzoMassimo=950' },
  { portal: 'indomio', ciudad: 'valencia',  url: 'https://www.indomio.es/alquiler-casas/valencia-capital/?criterio=rilevanza&prezzoMassimo=800' },

  // ── NUROA — Agregador de portales pequeños ─────────────────
  { portal: 'nuroa', ciudad: 'barcelona', url: 'https://www.nuroa.es/alquiler-de-apartamentos/barcelona/?precio_max=1000&orden=fecha' },
  { portal: 'nuroa', ciudad: 'madrid',    url: 'https://www.nuroa.es/alquiler-de-apartamentos/madrid/?precio_max=950&orden=fecha' },
  { portal: 'nuroa', ciudad: 'valencia',  url: 'https://www.nuroa.es/alquiler-de-apartamentos/valencia/?precio_max=800&orden=fecha' },

  // ── RENTOLA ────────────────────────────────────────────────
  { portal: 'rentola', ciudad: 'barcelona', url: 'https://rentola.es/en/for-rent?location=barcelona&rent=0-1000' },
  { portal: 'rentola', ciudad: 'madrid',    url: 'https://rentola.es/en/for-rent?location=madrid&rent=0-950' },
  { portal: 'rentola', ciudad: 'valencia',  url: 'https://rentola.es/en/for-rent?location=valencia&rent=0-800' },

  // ── FOTOCASA — DataDome, tasa de éxito ~20-30% ─────────────
  { portal: 'fotocasa', ciudad: 'barcelona', url: 'https://www.fotocasa.es/es/alquiler/viviendas/barcelona-capital/todas-las-zonas/l?maxPrice=1000' },
  { portal: 'fotocasa', ciudad: 'madrid',    url: 'https://www.fotocasa.es/es/alquiler/viviendas/madrid-capital/todas-las-zonas/l?maxPrice=950' },
  { portal: 'fotocasa', ciudad: 'valencia',  url: 'https://www.fotocasa.es/es/alquiler/viviendas/valencia-capital/todas-las-zonas/l?maxPrice=800' },

  // ── RENTUMO ────────────────────────────────────────────────
  { portal: 'rentumo', ciudad: 'barcelona', url: 'https://rentumo.es/alquileres?location=barcelona&rent=1000&size=1' },
  { portal: 'rentumo', ciudad: 'madrid',    url: 'https://rentumo.es/alquileres?location=madrid&rent=1000&size=1' },
  { portal: 'rentumo', ciudad: 'valencia',  url: 'https://rentumo.es/alquileres?location=valencia&rent=800&size=1' },

  // ── SPOTAHOME ──────────────────────────────────────────────
  { portal: 'spotahome', ciudad: 'barcelona', url: 'https://www.spotahome.com/s/barcelona--spain?budget=0-1000' },
  { portal: 'spotahome', ciudad: 'madrid',    url: 'https://www.spotahome.com/s/madrid--spain?budget=0-950' },
  { portal: 'spotahome', ciudad: 'valencia',  url: 'https://www.spotahome.com/s/valencia--spain?budget=0-800' },

  // ── UNIPLACES ──────────────────────────────────────────────
  { portal: 'uniplaces', ciudad: 'barcelona', url: 'https://www.uniplaces.com/accommodation/barcelona?budget-max=100000' },
  { portal: 'uniplaces', ciudad: 'madrid',    url: 'https://www.uniplaces.com/accommodation/madrid?budget-max=95000' },
  { portal: 'uniplaces', ciudad: 'valencia',  url: 'https://www.uniplaces.com/accommodation/valencia?budget-max=80000' },
];

// ------------------------------------------------------------
// Paginación por portal
// ------------------------------------------------------------

function generarURLPaginada(base: { portal: Portal; url: string }, pagina: number): string {
  if (pagina === 1) return base.url;

  switch (base.portal) {
    case 'idealista':
    case 'idealista-new': {
      const baseUrl = base.url.endsWith('/') ? base.url : base.url + '/';
      return baseUrl + `pagina-${pagina}.htm`;
    }
    case 'pisoscom':
      return base.url.replace(/\/$/, '') + `/${pagina}/`;
    case 'habitaclia':
      return base.url.replace('.htm', `-${pagina}.htm`);
    case 'yaencontre':
      return base.url.replace(/\/$/, '') + `/pag-${pagina}`;
    case 'indomio':
      return base.url + `&pag=${pagina}`;
    case 'fotocasa':
      return base.url.replace('/l?', `/l/${pagina}?`);
    case 'rentola':
      return base.url + `&page=${pagina}`;
    case 'rentumo':
      return base.url + `&page=${pagina}`;
    case 'spotahome':
      return base.url.replace('?', `/page:${pagina}?`);
    case 'uniplaces':
      return base.url + `&page=${pagina}`;
    case 'nuroa':
      return base.url + `&pagina=${pagina}`;
    default:
      return base.url;
  }
}

// ------------------------------------------------------------
// Cache de scrapers
// ------------------------------------------------------------

const scraperCache = new Map<Portal, BaseScraper>();

export function getScraper(portal: Portal): BaseScraper {
  const cached = scraperCache.get(portal);
  if (cached) return cached;

  // Ambos rounds: Bright Data ON por defecto (directo primero; Unlocker si bloqueo)
  const useBrightData = process.env['BRIGHTDATA_ENABLED'] !== 'false';
  const opts = { useBrightData };

  let scraper: BaseScraper;
  switch (portal) {
    case 'idealista':     scraper = new IdealistaScraper(opts); break;
    case 'idealista-new': scraper = new IdealistaNewScraper(opts); break;
    case 'pisoscom':      scraper = new PisoscomScraper(opts); break;
    case 'habitaclia':    scraper = new HabitacliaScraper(opts); break;
    case 'yaencontre':    scraper = new YaencontreScraper(opts); break;
    case 'indomio':       scraper = new IndominioScraper(opts); break;
    case 'rentola':       scraper = new RentolaScraper(opts); break;
    case 'fotocasa':      scraper = new FotocasaScraper(opts); break;
    case 'rentumo':       scraper = new RentumoScraper(opts); break;
    case 'spotahome':     scraper = new SpotahomeScraper(opts); break;
    case 'uniplaces':     scraper = new UniplacesScraper(opts); break;
    case 'nuroa':         scraper = new NuroaScraper(opts); break;
    default: throw new Error(`Portal no soportado o eliminado: ${portal}`);
  }

  scraperCache.set(portal, scraper);
  return scraper;
}

// ------------------------------------------------------------
// Filtro de precio por ciudad
// ------------------------------------------------------------

function filtrarPorPrecio(pisos: Piso[]): Piso[] {
  return pisos.filter((piso) => {
    const precioMax = PRECIO_MAX_POR_CIUDAD[piso.ciudad];
    return piso.precio > 0 && piso.precio <= precioMax;
  });
}

// ------------------------------------------------------------
// Concurrencia controlada
// ------------------------------------------------------------

async function ejecutarConLimite<T>(
  tareas: Array<() => Promise<T>>,
  concurrencia: number
): Promise<T[]> {
  const resultados: T[] = [];
  let indice = 0;

  async function worker(): Promise<void> {
    while (indice < tareas.length) {
      const tareaActual = tareas[indice++];
      if (tareaActual) {
        resultados.push(await tareaActual());
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrencia, tareas.length) },
    () => worker()
  );

  await Promise.all(workers);
  return resultados;
}

// ------------------------------------------------------------
// Scraping de un portal completo
// ------------------------------------------------------------

interface PortalStats {
  portal: Portal;
  pisosEncontrados: number;
  pisosNuevos: number;
  errores: number;
}

// Tamaño de lote de páginas por ejecución (1 = una sola página por ciudad)
const PAGE_BATCH_SIZE = parseInt(process.env['SCRAPER_PAGES'] ?? '1', 10);
const MAX_PAGE_LIMIT = 100;

async function scrapePortalCompleto(
  portal: Portal,
  tareasBase: Array<{ ciudad: Ciudad; url: string }>,
  _paginas: number,
  baseDelayMs: number
): Promise<PortalStats> {
  // Ajuste de delay por portal (Anti-DataDome / Cloudflare avanzado)
  let delayMs = baseDelayMs;
  if (portal === 'fotocasa' || portal === 'idealista' || portal === 'idealista-new') {
    // Retardo dinámico de 15 a 30 segundos
    delayMs = Math.floor(Math.random() * (30000 - 15000 + 1)) + 15000;
  }

  const scraper = getScraper(portal);
  const stats: PortalStats = { portal, pisosEncontrados: 0, pisosNuevos: 0, errores: 0 };
  const inicio = Date.now();

  let isFirstRequest = true;

  for (const base of tareasBase) {
    // Máquina de estados de paginación:
    // - Si está lockedToFront (fin de catálogo alcanzado alguna vez), siempre repetimos páginas 1..PAGE_BATCH_SIZE.
    // - Si no, avanzamos por lotes de PAGE_BATCH_SIZE páginas a partir de la última procesada.
    const lockedToFront = isLockedToFront(portal, base.ciudad);
    const lastScrapedPage = getLastScrapedPage(portal, base.ciudad);
    const startPage = lockedToFront ? 1 : lastScrapedPage + 1;
    const endPage = lockedToFront ? PAGE_BATCH_SIZE : lastScrapedPage + PAGE_BATCH_SIZE;

    if (lockedToFront) {
      logger.info(`🔒 [${portal}] ${base.ciudad} — Bloqueado en frente de catálogo. Escrapeando siempre páginas 1 a ${PAGE_BATCH_SIZE}.`);
    } else {
      logger.info(`📦 [${portal}] ${base.ciudad} — Escrapeando lote de páginas ${startPage} a ${endPage} (Última procesada anterior: ${lastScrapedPage})`);
    }

    for (let p = startPage; p <= endPage; p++) {
      if (p > MAX_PAGE_LIMIT) {
        logger.info(`📈 [${portal}] ${base.ciudad} — Alcanzado límite máximo de páginas (${MAX_PAGE_LIMIT}). Bloqueando en frente de catálogo.`);
        setLockedToFront(portal, base.ciudad, true);
        setLastScrapedPage(portal, base.ciudad, 0);
        break;
      }

      if (!isFirstRequest) {
        // Delay dinámico entre cualquier petición (paginación o cambio de ciudad)
        await new Promise(r => setTimeout(r, delayMs));
      }
      isFirstRequest = false;

      const url = generarURLPaginada({ portal, url: base.url }, p);
      const task: ScrapingTask = { portal, ciudad: base.ciudad, url, pagina: p };

      const resultado = await scraper.scrape(task);
      const pisosFiltrados = filtrarPorPrecio(resultado.pisos);
      const dbStats = await upsertPisos(pisosFiltrados);

      logScraperEjecucion({
        portal,
        ciudad: base.ciudad,
        url,
        pisosEncontrados: pisosFiltrados.length,
        pisosNuevos: dbStats.inserted,
        error: resultado.error,
        duracionMs: Date.now() - inicio,
      });

      stats.pisosEncontrados += pisosFiltrados.length;
      stats.pisosNuevos += dbStats.inserted;
      if (resultado.error) stats.errores++;

      if (resultado.pisos.length === 0 && !resultado.error) {
        if (lockedToFront) {
          logger.info(`📄 [${portal}] ${base.ciudad}: Página ${p} vacía (0 resultados). Sigue bloqueado en frente de catálogo.`);
        } else {
          logger.info(`📄 [${portal}] ${base.ciudad}: Página ${p} vacía (0 resultados). Fin de catálogo. Bloqueando en frente de catálogo.`);
          setLockedToFront(portal, base.ciudad, true);
        }
        setLastScrapedPage(portal, base.ciudad, 0);
        break;
      }

      // Guardar el progreso incremental de la página actual (solo tiene sentido si no está bloqueado)
      if (!lockedToFront) {
        setLastScrapedPage(portal, base.ciudad, p);
      }
    }
  }

  return stats;
}

// ------------------------------------------------------------
// Timestamp del último scrape
// ------------------------------------------------------------

export let lastScraperTimestamp: string | null = null;

// ------------------------------------------------------------
// FUNCIÓN PRINCIPAL
// ------------------------------------------------------------

async function ejecutarScraperParaPortales(portalesAEjecutar: Portal[], etiqueta: string): Promise<void> {
  const inicio = Date.now();
  const delayEntreTareas = parseInt(process.env['REQUEST_DELAY_MS'] ?? '2000', 10);
  const concurrenciaPortales = parseInt(process.env['SCRAPER_CONCURRENCY'] ?? '3', 10);

  const portales = [...new Set(TAREAS_BASE.map(t => t.portal))].filter(p => portalesAEjecutar.includes(p));

  logger.info('='.repeat(60));
  logger.info(`🚀 INICIO DEL CICLO DE SCRAPING [${etiqueta}]`);
  logger.info(`   Portales: ${portales.length} | Ciudades: 3 | Páginas por lote: ${PAGE_BATCH_SIZE} | Concurrencia: ${concurrenciaPortales}`);
  logger.info('='.repeat(60));

  const tareasPortal = portales.map(portal => {
    const tareasDelPortal = TAREAS_BASE
      .filter(t => t.portal === portal)
      .map(t => ({ ciudad: t.ciudad, url: t.url }));

    return async () => scrapePortalCompleto(portal, tareasDelPortal, PAGE_BATCH_SIZE, delayEntreTareas);
  });

  const resultados = await ejecutarConLimite(tareasPortal, concurrenciaPortales);

  let totalPisosEncontrados = 0;
  let totalPisosNuevos = 0;
  let totalErrores = 0;

  for (const r of resultados) {
    if (!r) continue;
    totalPisosEncontrados += r.pisosEncontrados;
    totalPisosNuevos += r.pisosNuevos;
    totalErrores += r.errores;
  }

  lastScraperTimestamp = new Date().toISOString();

  // Recalcular inventario por zona (alimenta los menús VIP inventory-aware)
  await refreshInventoryStats().catch((error) => {
    logger.error('❌ Error recalculando InventoryStats:', { error });
  });

  const duracionTotal = Math.round((Date.now() - inicio) / 1000);
  const statsDB = await getEstadisticasPisos();

  logger.info('='.repeat(60));
  logger.info(`✅ CICLO DE SCRAPING COMPLETADO [${etiqueta}]`);
  logger.info(`   Duración: ${duracionTotal}s`);
  logger.info(`   Pisos encontrados: ${totalPisosEncontrados}`);
  logger.info(`   Pisos nuevos en BD: ${totalPisosNuevos}`);
  logger.info(`   Errores: ${totalErrores}`);
  logger.info(`   Total en BD: ${statsDB.total} (${statsDB.pendientes} pendientes)`);
  logger.info('='.repeat(60));
}

// ------------------------------------------------------------
// ROUND_1 — Portales más ligeros (cron cada 2 h)
// ------------------------------------------------------------

export async function ejecutarScraperJobRound1(): Promise<void> {
  await ejecutarScraperParaPortales(PORTALES_ROUND_1, 'ROUND_1');
}

/** @deprecated alias */
export async function ejecutarScraperJobFast(): Promise<void> {
  await ejecutarScraperJobRound1();
}

// ------------------------------------------------------------
// ROUND_2 — Portales más duros (cron cada 4 h)
// ------------------------------------------------------------

export async function ejecutarScraperJobRound2(): Promise<void> {
  await ejecutarScraperParaPortales(PORTALES_ROUND_2, 'ROUND_2');
}

/** @deprecated alias */
export async function ejecutarScraperJobSlow(): Promise<void> {
  await ejecutarScraperJobRound2();
}

// ------------------------------------------------------------
// AMBOS — Para pruebas manuales (npm run scraper:test)
// ------------------------------------------------------------

export async function ejecutarScraperJob(): Promise<void> {
  await ejecutarScraperJobRound1();
  await ejecutarScraperJobRound2();
}

// ------------------------------------------------------------
// Ejecución directa (npm run scraper:test)
// ------------------------------------------------------------

if (require.main === module) {
  import('dotenv').then(({ config }) => {
    config();
    return ejecutarScraperJob();
  }).catch(console.error);
}
