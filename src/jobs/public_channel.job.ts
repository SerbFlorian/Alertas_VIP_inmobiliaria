import { 
  getCountPublicacionesSemanalesPublico, 
  getPisosParaCanalPublico, 
  marcarPisoComoPublicadoPublico,
  eliminarPiso
} from '../db/queries';
import { checkIfPisoIsDead } from './availability.job';
import { enviarMensaje } from '../services/telegram.service';
import { logger } from '../services/logger';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function etiquetaTipo(piso: {
  tipo?: string | null;
  titulo?: string | null;
  resumen?: string | null;
  habitaciones?: number | null;
  precio?: number | null;
}): string {
  const tipo = (piso.tipo || '').toLowerCase();
  if (tipo.includes('habitaci')) return 'Habitación';
  if (tipo.includes('piso') || tipo.includes('apart')) return 'Piso';

  const texto = `${piso.titulo || ''} ${piso.resumen || ''}`.toLowerCase();
  const keywordsHab = [
    'habitación en',
    'habitacion en',
    'alquiler de habitación',
    'alquiler habitación',
    'piso compartido',
    'room for rent',
  ];
  if (keywordsHab.some((kw) => texto.includes(kw))) return 'Habitación';
  if (piso.habitaciones != null && piso.habitaciones >= 5 && (piso.precio ?? 0) <= 800) {
    return 'Habitación';
  }
  if (piso.tipo) return escapeHtml(piso.tipo);
  return 'Piso';
}

function formatearFichaPublica(piso: any): string {
  const zona = piso.zona || piso.zonaNorm || null;
  const habs =
    piso.habitaciones === 0
      ? 'Estudio / 0 dormitorios'
      : piso.habitaciones != null
        ? `${piso.habitaciones} hab.`
        : null;

  const lineas = [
    `🆓 <b>Alerta gratuita (diferida 72h)</b>`,
    `<i>Anuncio real publicado con retraso frente a usuarios VIP.</i>`,
    ``,
    `🏠 <b>${escapeHtml(piso.titulo || 'Anuncio')}</b>`,
    ``,
    `📍 <b>Ciudad:</b> ${escapeHtml((piso.ciudad || '').toUpperCase())}`,
    zona ? `🗺️ <b>Zona:</b> ${escapeHtml(zona)}` : `🗺️ <b>Zona:</b> —`,
    `🏷️ <b>Tipo:</b> ${etiquetaTipo(piso)}`,
    habs ? `🛏️ <b>Habitaciones:</b> ${habs}` : null,
    `💰 <b>Precio:</b> ${piso.precio}€ / mes`,
    ``,
    `👉 <a href="https://t.me/VIP_managment_bot"><b>Pasarse a VIP</b></a>`,
  ].filter((l) => l !== null) as string[];

  return lineas.join('\n');
}

// ============================================================
// PUBLIC CHANNEL JOB — Envío diferido a canal gratuito
// ============================================================

export async function ejecutarPublicChannelJob(): Promise<void> {
  logger.info('-'.repeat(50));
  logger.info('📢 INICIO DEL CICLO DEL CANAL PÚBLICO (GRATUITO)');
  logger.info('-'.repeat(50));

  const publicChannelId = process.env['TELEGRAM_PUBLIC_CHANNEL_ID'];
  
  if (!publicChannelId) {
    logger.warn('⚠️ No se ha configurado TELEGRAM_PUBLIC_CHANNEL_ID.');
    return;
  }

  // Verificar límite semanal (5 anuncios máximo)
  const countSemanal = await getCountPublicacionesSemanalesPublico();
  if (countSemanal >= 5) {
    logger.info(`ℹ️ Límite semanal de 5 anuncios alcanzado (${countSemanal}/5). Saltando.`);
    return;
  }

  // Buscar 1 candidato (retraso de 3 días)
  const candidatos = await getPisosParaCanalPublico(3, 3); // Pedimos hasta 3 por si alguno está muerto

  if (candidatos.length === 0) {
    logger.info('ℹ️ No hay pisos candidatos (con 3 días de antigüedad) para el canal público.');
    return;
  }

  for (const piso of candidatos) {
    logger.info(`🔍 Verificando disponibilidad de candidato para canal público: ${piso.enlace}`);
    const isDead = await checkIfPisoIsDead(piso.enlace);

    if (isDead) {
      logger.info(`🗑️ Anuncio caído detectado (ID: ${piso.id}). Eliminando de BD y buscando el siguiente.`);
      await eliminarPiso(piso.id, piso.portal);
      continue; // Probar con el siguiente candidato
    }

    // Sin enlace al anuncio: ficha completa + CTA VIP
    const texto = formatearFichaPublica(piso);

    const response = await enviarMensaje(publicChannelId, texto, 'HTML', undefined, {
      disableWebPagePreview: true,
    });

    if (response) {
      await marcarPisoComoPublicadoPublico(piso.id, piso.portal, response.messageId);
      logger.info(`✅ Alerta pública enviada al canal ${publicChannelId} - ${piso.id}`);
      
      // Solo enviamos 1 anuncio por ciclo para no spamear, ya que el límite es 5 a la semana (casi 1 al día)
      break;
    } else {
      logger.error(`❌ Error publicando en el canal público - piso ${piso.id}`);
    }
  }

  logger.info('-'.repeat(50));
  logger.info('✅ CICLO DEL CANAL PÚBLICO COMPLETADO');
  logger.info('-'.repeat(50));
}
