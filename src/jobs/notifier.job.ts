import {
  getPisosRecientes,
  getUsuariosActivos,
  getUsuarioPorTelegramId,
  haRecibidoPiso,
  registrarNotificacionEnviada,
  marcarPisoComoPublicado,
  haPublicadoHoyEnCanalPublico,
  marcarPisoPublicadoCanalPublico,
} from '../db/queries';
import { enviarMensaje } from '../services/telegram.service';
import { logger } from '../services/logger';
import { normalizarZona } from '../utils/normalizer';
import {
  construirIndiceMedianas,
  calcularCholloScore,
  formatearLineaChollo,
  logCholloConfig,
  type CholloScore,
} from '../services/chollo.service';
import {
  withRedisLock,
  listDueDigestWarmups,
  clearDigestWarmup,
  deferWarmupOrGiveUp,
  hasDigestCooldown,
  isRegularDigestDue,
  markRegularDigestSent,
  markWarmupDigestSent,
  rescheduleDigestWarmupAt,
} from '../services/redis.service';
import {
  calcularDueWarmupEnVentana,
  hardEndHour,
  hardStartHour,
  isUserWithinDeliveryWindow,
  loadDigestPrefs,
  madridParts,
} from '../services/digest-schedule.service';

// ============================================================
// NOTIFIER — Digests VIP (estilo AutoBroker) + chollo % real
// ============================================================
// - 1 mensaje digest por usuario y ciclo
// - Hasta DIGEST_MAX_LISTINGS anuncios por digest (default 3)
// - Pool: DIGEST_POOL_DAYS (default = CLEANUP_DIAS_BD / 14). Prioridad:
//   1) frescos (≤ DIGEST_LOOKBACK_DAYS)  2) resto del pool aún no enviados
//   → el VIP no se queda a 0 si hay stock compatible sin notificar
// - Cadencia regular POR USUARIO (/horario); warmup 5–15 min tras Aplicar
// ============================================================

const TELEGRAM_DM_DELAY_MS = parseInt(process.env['NOTIF_SEND_DELAY_MS'] ?? '150', 10);
const DIGEST_MAX_LISTINGS = parseInt(process.env['DIGEST_MAX_LISTINGS'] ?? '3', 10);
/** Ventana “nuevo”: estos anuncios van primero en el digest. */
const DIGEST_LOOKBACK_DAYS = parseInt(process.env['DIGEST_LOOKBACK_DAYS'] ?? '3', 10);
/**
 * Pool completo elegible (nuevo + viejo). Default = retención BD para no
 * mandar anuncios que el cleanup ya debería haber borrado.
 */
const DIGEST_POOL_DAYS = Math.max(
  DIGEST_LOOKBACK_DAYS,
  parseInt(
    process.env['DIGEST_POOL_DAYS'] ?? process.env['CLEANUP_DIAS_BD'] ?? '14',
    10
  )
);
const MEDIANA_LOOKBACK_DAYS = parseInt(process.env['CHOLLO_MEDIANA_DAYS'] ?? '14', 10);
/** Si true, solo mete en el digest anuncios con esChollo (bajo mediana). Default false = todos los matches. */
const DIGEST_SOLO_CHOLLOS = process.env['DIGEST_SOLO_CHOLLOS'] === 'true';

function pisoCreatedAtMs(piso: any): number {
  return new Date(piso.created_at || piso.updated_at || 0).getTime();
}

function esPisoFresco(piso: any, ahora = Date.now()): boolean {
  const corte = ahora - DIGEST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return pisoCreatedAtMs(piso) >= corte;
}

async function enviarConThrottle(fn: () => Promise<void>): Promise<void> {
  await fn();
  await new Promise((r) => setTimeout(r, TELEGRAM_DM_DELAY_MS));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function esHabitacionReal(piso: any): boolean {
  if (piso.tipo && piso.tipo.toLowerCase().includes('habitaci')) return true;

  const texto = `${piso.titulo || ''} ${piso.resumen || ''}`.toLowerCase();
  const keywords = [
    'habitación en', 'habitacion en',
    'alquiler de habitación', 'alquiler de habitacion',
    'alquiler habitación', 'alquiler habitacion',
    'piso compartido', 'compartir piso', 'apartamento compartido',
    'se alquila habitación', 'se alquila habitacion',
    'room for rent', 'single room', 'double room',
  ];
  if (keywords.some((kw) => texto.includes(kw))) return true;
  if (piso.habitaciones && piso.habitaciones >= 5 && piso.precio <= 800) return true;
  return false;
}

function pisoCoincideConUsuario(piso: any, user: any): boolean {
  if (user.filtro_ciudad && piso.ciudad.toLowerCase() !== user.filtro_ciudad.toLowerCase()) {
    return false;
  }
  if (user.filtro_precio_max && piso.precio > user.filtro_precio_max) {
    return false;
  }
  if (user.filtro_zonas && user.filtro_zonas.length > 0) {
    if (!piso.zona && !piso.zonaNorm) return false;
    const pisoNorm = (piso.zonaNorm || normalizarZona(piso.zona || '')).toLowerCase();
    const zonaEncontrada = user.filtro_zonas.some((z: string) => {
      const userNorm = normalizarZona(z);
      return (
        (pisoNorm && userNorm && pisoNorm === userNorm) ||
        (piso.zona && piso.zona.toLowerCase().includes(z.toLowerCase())) ||
        (z.toLowerCase().includes((piso.zona || '').toLowerCase()) && !!piso.zona)
      );
    });
    if (!zonaEncontrada) return false;
  }
  if (user.filtro_habitaciones != null) {
    if (piso.habitaciones === null || piso.habitaciones === undefined) return false;
    // 0 = exacto (estudio / sin dormitorio). 1+ = mínimo.
    if (user.filtro_habitaciones === 0) {
      if (piso.habitaciones !== 0) return false;
    } else if (piso.habitaciones < user.filtro_habitaciones) {
      return false;
    }
  }
  if (user.filtro_tipo && user.filtro_tipo !== 'Ambos') {
    const esHab = esHabitacionReal(piso);
    const filtroTipo = user.filtro_tipo.toLowerCase();
    if (filtroTipo.includes('piso') && esHab) return false;
    if (filtroTipo.includes('habitaci') && !esHab) return false;
  }
  return true;
}

type MatchItem = { piso: any; score: CholloScore };

/** Firma visual: mismo inmueble / lote aunque cambie portal o id. */
function firmaApariencia(piso: any): string {
  return [
    String(piso.titulo || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' '),
    String(piso.precio ?? ''),
    String(piso.ciudad || '').toLowerCase(),
    String(piso.zonaNorm || piso.zona || '')
      .trim()
      .toLowerCase(),
    String(piso.habitaciones ?? ''),
  ].join('|');
}

/** Elige hasta N anuncios sin repetir el mismo piso (lotes / publicaciones). */
function seleccionarLoteSinDuplicados(candidatos: MatchItem[], max: number): MatchItem[] {
  const lote: MatchItem[] = [];
  const firmas = new Set<string>();
  for (const c of candidatos) {
    if (lote.length >= max) break;
    const f = firmaApariencia(c.piso);
    if (firmas.has(f)) continue;
    firmas.add(f);
    lote.push(c);
  }
  return lote;
}

function formatearBloquePiso(item: MatchItem, indice: number): string {
  const { piso, score } = item;
  const cholloLine = formatearLineaChollo(score);
  const num = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'][indice] ?? `${indice + 1}.`;

  const meta = [
    `💰 <b>${piso.precio}€</b>/mes`,
    piso.zona ? `🗺️ ${escapeHtml(piso.zona)}` : null,
    piso.habitaciones != null ? `🛏️ ${piso.habitaciones}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const partes: string[] = [
    `${num} <b>${escapeHtml(piso.titulo || 'Anuncio')}</b>`,
    meta,
  ];
  if (cholloLine) partes.push(cholloLine);
  if (score.esChollo) partes.push(`✨ <b>Chollo</b> respecto a la mediana de zona`);
  partes.push(`👉 <a href="${piso.enlace}"><b>Anuncio encontrado</b></a>`);

  return partes.join('\n\n');
}

function formatearDigest(items: MatchItem[]): string {
  const n = items.length;
  const cabecera =
    n === 1
      ? `📬 <b>Digest VIP — 1 anuncio</b>`
      : `📬 <b>Digest VIP — ${n} anuncios</b>`;

  const partes: string[] = [cabecera, ``];
  const bloques = items.map((it, i) => formatearBloquePiso(it, i));
  partes.push(bloques.join('\n\n────────\n\n'));
  partes.push(``, `<i>Próximo resumen según tu radar · /filtros · /horario</i>`);

  return partes.join('\n');
}

type IndiceMedianas = ReturnType<typeof construirIndiceMedianas>;

async function construirContextoMatching(): Promise<{
  indice: IndiceMedianas;
  pisosMatch: any[];
}> {
  const lookbackFetch = Math.max(MEDIANA_LOOKBACK_DAYS, DIGEST_POOL_DAYS);
  const todosParaStats = await getPisosRecientes(lookbackFetch);
  const indice = construirIndiceMedianas(todosParaStats);
  const cortePool = Date.now() - DIGEST_POOL_DAYS * 24 * 60 * 60 * 1000;
  const pisosMatch = todosParaStats.filter((p: any) => pisoCreatedAtMs(p) >= cortePool);
  return { indice, pisosMatch };
}

/**
 * Envía un digest (≤ DIGEST_MAX_LISTINGS) a un VIP.
 * @returns nº de anuncios enviados (0 si no había candidatos / no due / fallo)
 */
export async function enviarDigestParaUsuario(
  user: any,
  opts?: {
    indice?: IndiceMedianas;
    pisosMatch?: any[];
    /** 'regular' = respeta cadencia 2h; 'warmup' = ignora cadencia y no la avanza */
    modo?: 'regular' | 'warmup';
  }
): Promise<number> {
  if (!user?.telegram_id) return 0;

  const modo = opts?.modo ?? 'regular';

  if (await hasDigestCooldown(user.telegram_id)) {
    logger.info(`⏭️  Digest debounce activo → VIP ${user.telegram_id}`);
    return 0;
  }

  const prefs = await loadDigestPrefs(user.telegram_id);
  if (!isUserWithinDeliveryWindow(prefs)) {
    return 0;
  }

  if (modo === 'regular' && !(await isRegularDigestDue(user.telegram_id))) {
    return 0;
  }

  let indice = opts?.indice;
  let pisosMatch = opts?.pisosMatch;
  if (!indice || !pisosMatch) {
    const ctx = await construirContextoMatching();
    indice = ctx.indice;
    pisosMatch = ctx.pisosMatch;
  }

  const candidatos: MatchItem[] = [];

  for (const piso of pisosMatch) {
    if (!pisoCoincideConUsuario(piso, user)) continue;
    const yaRecibido = await haRecibidoPiso(
      user.telegram_id,
      piso.id_piso || piso.id,
      piso.portal
    );
    if (yaRecibido) continue;

    const score = calcularCholloScore(piso, indice);
    if (DIGEST_SOLO_CHOLLOS && !score.esChollo) continue;

    candidatos.push({ piso, score });
  }

  // 1) Frescos (lookback) primero · 2) dentro del tier: más nuevo → chollo % → precio
  const ahora = Date.now();
  candidatos.sort((a, b) => {
    const aNew = esPisoFresco(a.piso, ahora) ? 1 : 0;
    const bNew = esPisoFresco(b.piso, ahora) ? 1 : 0;
    if (bNew !== aNew) return bNew - aNew;

    const ta = pisoCreatedAtMs(a.piso);
    const tb = pisoCreatedAtMs(b.piso);
    if (tb !== ta) return tb - ta;

    const pa = a.score.pctBajoMediana ?? -999;
    const pb = b.score.pctBajoMediana ?? -999;
    if (pb !== pa) return pb - pa;
    return a.piso.precio - b.piso.precio;
  });

  const lote = seleccionarLoteSinDuplicados(candidatos, DIGEST_MAX_LISTINGS);
  if (lote.length === 0) return 0;

  const texto = formatearDigest(lote);
  let enviados = 0;

  await enviarConThrottle(async () => {
    const response = await enviarMensaje(user.telegram_id, texto, 'HTML', undefined, {
      disableWebPagePreview: true,
    });
    if (!response) return;

    enviados = lote.length;
    for (const { piso } of lote) {
      await registrarNotificacionEnviada(
        user.telegram_id,
        piso.id_piso || piso.id,
        piso.portal
      );
      await marcarPisoComoPublicado(
        piso.id_piso || piso.id,
        piso.portal,
        response.messageId,
        user.telegram_id
      );
    }
    if (modo === 'warmup') {
      await markWarmupDigestSent(user.telegram_id);
    } else {
      await markRegularDigestSent(user.telegram_id);
    }
    logger.info(`🎯 Digest ${lote.length} anuncio(s) [${modo}] → VIP ${user.telegram_id}`);
  });

  return enviados;
}

/** Hard floor sistema (NOTIF_HARD_* Europe/Madrid). */
export function enVentanaHardFloor(): boolean {
  const { hour } = madridParts();
  const start = hardStartHour();
  const end = hardEndHour();
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/** Procesa warmups vencidos (cola tras Aplicar filtros). Respeta /horario por VIP. */
export async function procesarWarmupsDue(): Promise<void> {
  if (!enVentanaHardFloor()) {
    return;
  }

  const dueIds = await listDueDigestWarmups();
  if (dueIds.length === 0) return;

  logger.info(`🔥 Warmup due: ${dueIds.length} usuario(s)`);

  for (const telegramId of dueIds) {
    try {
      const prefs = await loadDigestPrefs(telegramId);
      if (!isUserWithinDeliveryWindow(prefs)) {
        const nextDue = calcularDueWarmupEnVentana(prefs, 0);
        await rescheduleDigestWarmupAt(telegramId, nextDue);
        logger.info(`⏭️  Warmup fuera de /horario → VIP ${telegramId}; reprogramado`);
        continue;
      }

      const user = await getUsuarioPorTelegramId(telegramId);
      if (!user || (user.estado !== 'Pagado' && user.estado !== 'Cancelando')) {
        await clearDigestWarmup(telegramId);
        continue;
      }

      const n = await enviarDigestParaUsuario(user, { modo: 'warmup' });
      if (n > 0) {
        await clearDigestWarmup(telegramId);
        logger.info(`✅ Warmup enviado → VIP ${telegramId} (${n} anuncio(s))`);
        continue;
      }

      const outcome = await deferWarmupOrGiveUp(telegramId, 15, 3);
      if (outcome === 'deferred') {
        logger.info(`ℹ️  Warmup sin envío → VIP ${telegramId}; reintento en ~15 min`);
      } else {
        logger.info(
          `ℹ️  Warmup sin candidatos tras reintentos → VIP ${telegramId} (esperará ciclo regular)`
        );
      }
    } catch (error) {
      logger.error(`❌ Warmup falló para ${telegramId}:`, { error });
      try {
        await deferWarmupOrGiveUp(telegramId, 15, 3);
      } catch {
        /* ignore */
      }
    }
  }
}

export async function ejecutarNotifierJob(): Promise<void> {
  const lockTtl = parseInt(process.env['DIGEST_LOCK_TTL_MS'] ?? '600000', 10);
  const locked = await withRedisLock('digest:notifier', lockTtl, () => ejecutarNotifierJobInner());
  if (!locked.ran) {
    logger.warn('⏭️  Digest omitido: otro worker ya tiene el lock Redis');
  }
}

async function ejecutarNotifierJobInner(): Promise<void> {
  if (!enVentanaHardFloor()) {
    logger.info('⏭️  Notifier fuera del hard floor NOTIF_HARD_* — skip');
    return;
  }

  logger.info('-'.repeat(50));
  logger.info('📣 INICIO NOTIFIER VIP (digests ≤' + DIGEST_MAX_LISTINGS + ')');
  logCholloConfig();
  logger.info('-'.repeat(50));

  const usuariosActivos = await getUsuariosActivos();
  if (usuariosActivos.length === 0) {
    logger.info('ℹ️  No hay usuarios VIP activos.');
    return;
  }

  const { indice, pisosMatch } = await construirContextoMatching();
  const lookbackMediana = Math.max(MEDIANA_LOOKBACK_DAYS, DIGEST_POOL_DAYS);
  const frescos = pisosMatch.filter((p) => esPisoFresco(p)).length;

  logger.info(
    `📦 Medianas (${lookbackMediana}d) · pool ${pisosMatch.length} (${DIGEST_POOL_DAYS}d; frescos ${frescos} ≤${DIGEST_LOOKBACK_DAYS}d) · ${usuariosActivos.length} VIP`
  );

  let digestsEnviados = 0;
  let anunciosEnDigests = 0;

  let publicadoEnPublicoHoy = await haPublicadoHoyEnCanalPublico();
  const publicChannelId = process.env['TELEGRAM_PUBLIC_CHANNEL_ID'];

  for (const user of usuariosActivos) {
    if (!user.telegram_id) continue;

    const n = await enviarDigestParaUsuario(user, { indice, pisosMatch, modo: 'regular' });
    if (n > 0) {
      digestsEnviados++;
      anunciosEnDigests += n;
    }
  }

  // Muestra canal público (1/día) — con chollo % si hay datos
  if (!publicadoEnPublicoHoy && publicChannelId && pisosMatch.length > 0) {
    const conScore = pisosMatch.map((piso: any) => ({
      piso,
      score: calcularCholloScore(piso, indice),
    }));
    conScore.sort((a, b) => (b.score.pctBajoMediana ?? -999) - (a.score.pctBajoMediana ?? -999));
    const mejor = conScore[0]!;
    const lineaChollo = formatearLineaChollo(mejor.score);

    const textoPublico = [
      `🚨 <b>Chollo de muestra del día</b>`,
      `<i>Publicación de referencia del radar.</i>`,
      ``,
      `🏠 <b>${escapeHtml(mejor.piso.titulo)}</b>`,
      ``,
      `💰 <b>${mejor.piso.precio}€</b> / mes`,
      `📍 ${escapeHtml((mejor.piso.ciudad || '').toUpperCase())}`,
      lineaChollo,
      ``,
      `<i>Muestra del sistema. VIP: digests con hasta ${DIGEST_MAX_LISTINGS} anuncios y enlace directo en cuanto lo detectamos.</i>`,
      ``,
      `────────`,
      `👉 <a href="https://t.me/VIP_managment_bot"><b>Pasarse a VIP</b></a>`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const response = await enviarMensaje(publicChannelId, textoPublico, 'HTML');
      if (response?.messageId) {
        await marcarPisoPublicadoCanalPublico(
          mejor.piso.id_piso || mejor.piso.id,
          mejor.piso.portal,
          response.messageId
        );
        publicadoEnPublicoHoy = true;
        logger.info(`📢 Muestra del día → canal público (${mejor.piso.id_piso})`);
      }
    } catch (e) {
      logger.error('No se pudo enviar al canal público:', e);
    }
  }

  logger.info('-'.repeat(50));
  logger.info('✅ NOTIFIER VIP COMPLETADO');
  logger.info(`   Digests enviados: ${digestsEnviados} · Anuncios empaquetados: ${anunciosEnDigests}`);
  logger.info('-'.repeat(50));
}
