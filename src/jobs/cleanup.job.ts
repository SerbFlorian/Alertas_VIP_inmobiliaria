import { getPisosParaBorrarTelegramPublico, marcarMensajeTelegramPublicoBorrado, eliminarPisosBD, getUsuariosExpiradosParaBorrar, actualizarEstadoUsuarioPorTelegramId } from '../db/queries';
import { eliminarMensaje, enviarMensaje } from '../services/telegram.service';
import { actualizarCajitaVip } from '../services/vipCounter.service';
import { logger } from '../services/logger';

// ============================================================
// CLEANUP JOB — Mantenimiento de Telegram y Base de Datos
// ============================================================
// Este script se ejecuta diariamente (idealmente de madrugada).
// Su objetivo es doble:
// 1. Borrar de Telegram los pisos antiguos para mantener el canal "limpio" y sin spam anticuado.
// 2. Borrar de la BD los pisos muy antiguos para evitar que el archivo SQLite crezca infinitamente.

export async function ejecutarCleanupJob(): Promise<void> {
  logger.info('-'.repeat(50));
  logger.info('🧹 INICIO DEL CICLO DE LIMPIEZA (CLEANUP)');
  logger.info('-'.repeat(50));

  // Tiempos configurables (por defecto: 7 días Telegram, 14 días BD)
  const DIAS_TELEGRAM = parseInt(process.env['CLEANUP_DIAS_TELEGRAM'] ?? '7', 10);
  const DIAS_BD = parseInt(process.env['CLEANUP_DIAS_BD'] ?? '14', 10);

  // FASE 1: Limpieza de Telegram (VIP) - ELIMINADA
  // Los mensajes VIP ahora son directos (DMs), por lo que el bot no los borra.
  // El usuario gestiona el historial de su chat.
  let mensajesBorrados = 0;
  let mensajesFallidos = 0;

  // ------------------------------------------------------------
  // FASE 1.5: Limpieza de Telegram (Canal Público)
  // ------------------------------------------------------------
  const publicChannelId = process.env['TELEGRAM_PUBLIC_CHANNEL_ID'];
  if (publicChannelId) {
    logger.info(`🔍 Buscando pisos con más de ${DIAS_TELEGRAM} días inactivos en Canal Público...`);
    const pisosPublicosParaBorrar = await getPisosParaBorrarTelegramPublico(DIAS_TELEGRAM);
    
    for (const piso of pisosPublicosParaBorrar) {
      if (!piso.telegram_public_message_id) continue;
      
      const exito = await eliminarMensaje(publicChannelId, piso.telegram_public_message_id);
      
      if (exito) {
        mensajesBorrados++;
        await marcarMensajeTelegramPublicoBorrado(piso.id_piso);
      } else {
        mensajesFallidos++;
        await marcarMensajeTelegramPublicoBorrado(piso.id_piso);
      }
      
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // ------------------------------------------------------------
  // FASE 2: Limpieza Física de la Base de Datos
  // ------------------------------------------------------------
  logger.info(`🗑️  Eliminando pisos con más de ${DIAS_BD} días de antigüedad en la BD...`);
  const registrosBorrados = await eliminarPisosBD(DIAS_BD);

  // ------------------------------------------------------------
  // FASE 3: Expulsión de Usuarios con Suscripción Finalizada
  // ------------------------------------------------------------
  logger.info(`👥 Comprobando usuarios cuya suscripción ha llegado a su fin hoy...`);
  const usuariosExpirados = await getUsuariosExpiradosParaBorrar();
  let usuariosExpulsados = 0;

  for (const usuario of usuariosExpirados) {
    logger.info(`🚫 Suscripción de ${usuario.telegram_id} ha expirado hoy. Procediendo a expulsar.`);
    
    // 1. Marcar como Cancelado definitivo
    await actualizarEstadoUsuarioPorTelegramId(usuario.telegram_id, 'Cancelado');

    // 2. Avisar al usuario
    await enviarMensaje(
      usuario.telegram_id,
      [
        `<b>🚫 Acceso finalizado</b>`,
        ``,
        `Tu tiempo de acceso VIP ha concluido de acuerdo a tu solicitud de cancelación. A partir de ahora dejarás de recibir chollos inmobiliarios.`,
        ``,
        `¡Gracias por habernos acompañado! Si alguna vez decides volver, puedes reanudar tu suscripción desde /start sin problema.`
      ].join('\n')
    );
    
    usuariosExpulsados++;
  }

  if (usuariosExpulsados > 0) {
    await actualizarCajitaVip();
  }

  // ------------------------------------------------------------
  // Resumen
  // ------------------------------------------------------------
  logger.info('-'.repeat(50));
  logger.info('✅ CICLO DE LIMPIEZA COMPLETADO');
  logger.info(`   Canales: ${mensajesBorrados} mensajes borrados (${mensajesFallidos} ya no existían)`);
  logger.info(`   Base de Datos: ${registrosBorrados} registros físicos eliminados`);
  logger.info(`   Usuarios: ${usuariosExpulsados} suscripciones finalizadas y expulsadas`);
  logger.info('-'.repeat(50));
}

// ------------------------------------------------------------
// Ejecución directa (npm run cleanup)
// ------------------------------------------------------------
if (require.main === module) {
  import('dotenv').then(({ config }) => {
    config();
    return ejecutarCleanupJob();
  }).catch(console.error);
}
