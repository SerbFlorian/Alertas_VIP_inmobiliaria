import express, { type Request, type Response } from 'express';
import Stripe from 'stripe';
import {
  actualizarEstadoUsuarioPorTelegramId,
  actualizarEstadoUsuarioPorCustomerId,
  programarCancelacionUsuarioPorCustomerId,
  reactivarUsuarioPorCustomerId,
  getUsuarioPorCustomerId,
  getUsuarioPorTelegramId,
} from '../db/queries';
import { enviarMensaje } from '../services/telegram.service';
import { actualizarCajitaVip } from '../services/vipCounter.service';
import { logger } from '../services/logger';
import { isRateLimited } from '../middlewares/ratelimit';

// ============================================================
// STRIPE WEBHOOKS — Gestión de pagos y suscripciones
// Equivalente a Automatización_Pagos.json + Cancela_suscripcion.json
// ============================================================

export function crearStripeRouter(): express.Router {
  const router = express.Router();
  const stripeSecretKey = process.env['STRIPE_SECRET_KEY'] ?? '';
  const webhookSecret = process.env['STRIPE_WEBHOOK_SECRET'] ?? '';

  if (!stripeSecretKey) {
    logger.warn('⚠️  STRIPE_SECRET_KEY no configurada. Los webhooks de Stripe no funcionarán.');
    return router;
  }

  const stripe = new Stripe(stripeSecretKey);

  // ── IMPORTANTE: necesitamos el body como Buffer RAW para verificar la firma ──
  router.use(express.raw({ type: 'application/json' }));

  // ----------------------------------------------------------
  // POST /webhook/stripe — Procesa todos los eventos de Stripe
  // ----------------------------------------------------------
  router.post('/', async (req: Request, res: Response) => {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
    if (isRateLimited(`stripe:${ip}`, 120, 60_000)) {
      logger.warn(`⏭️ Rate-limit webhook Stripe IP=${ip}`);
      res.status(429).send('Too many requests');
      return;
    }

    const sig = req.headers['stripe-signature'];

    let event: Stripe.Event;

    try {
      if (!sig || !webhookSecret) {
        logger.error('❌ Petición a webhook de Stripe rechazada: Falta firma o STRIPE_WEBHOOK_SECRET no está configurada.');
        res.status(400).send('Webhook signature verification failed');
        return;
      }
      
      // Verificación de firma (obligatoria en producción)
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      logger.error('❌ Error verificando firma de Stripe:', { err });
      res.status(400).send('Webhook signature verification failed');
      return;
    }

    logger.info(`📦 Stripe evento recibido: ${event.type}`);

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await manejarPagoCompletado(event.data.object as Stripe.Checkout.Session);
          break;

        case 'customer.subscription.deleted':
          await manejarCancelacionSuscripcion(event.data.object as Stripe.Subscription);
          break;

        case 'customer.subscription.updated':
          await manejarActualizacionSuscripcion(event.data.object as Stripe.Subscription);
          break;

        default:
          logger.info(`ℹ️  Evento ignorado: ${event.type}`);
      }
    } catch (error) {
      logger.error(`❌ Error procesando evento ${event.type}:`, { error });
      // Devolvemos 200 a Stripe de todos modos para evitar reintentos
    }

    res.status(200).json({ received: true });
  });

  return router;
}

// ----------------------------------------------------------
// Handler: checkout.session.completed
// Equivalente a Automatización_Pagos.json
// ----------------------------------------------------------

async function manejarPagoCompletado(session: Stripe.Checkout.Session): Promise<void> {
  const telegramId = session.client_reference_id;
  const email = session.customer_details?.email ?? undefined;
  const customerId = session.customer as string | undefined;

  if (!telegramId) {
    logger.warn('⚠️  checkout.session.completed sin client_reference_id (telegram_id)');
    return;
  }

  const usuarioExistente = await getUsuarioPorTelegramId(telegramId);
  if (usuarioExistente && usuarioExistente.estado === 'Pagado') {
    logger.info(`ℹ️ El usuario ${telegramId} ya es VIP. Ignorando evento checkout.session.completed duplicado o reintento de Stripe.`);
    return;
  }

  logger.info(`💳 Pago completado para telegram_id: ${telegramId}, email: ${email}`);

  // 1. Actualizar estado en BD
  await actualizarEstadoUsuarioPorTelegramId(telegramId, 'Pagado', email, customerId);

  // 2. Enviar mensaje de confirmación con Panel de Control VIP
  const texto = [
    `🎉 <b>¡Suscripción VIP Activada!</b>`,
    ``,
    `Hola, ya he procesado tu pago correctamente${email ? ` (<code>${email}</code>)` : ''}.`,
    ``,
    `💎 <b>Ya eres miembro VIP</b>`,
    `A partir de ahora, el bot funciona como tu Personal Shopper Inmobiliario.`,
    `Te enviaré mensajes directos en cuanto detecte, en el ciclo de vigilancia, un chollo que encaje con tus preferencias.`,
    ``,
    `👇 <b>Usa el botón de abajo para configurar tus filtros VIP ahora mismo:</b>`
  ].join('\n');

  const portalUrl = process.env['STRIPE_BILLING_PORTAL_URL'];
  
  const botones: any[] = [
    [{ text: '⚙️ Configurar Filtros VIP', callback_data: 'menu_filtros_vip' }]
  ];

  if (portalUrl) {
    botones.push([{ text: '💳 Gestionar mi Suscripción', url: portalUrl }]);
  }

  const payload = {
    chat_id: telegramId,
    text: texto,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: botones }
  };

  try {
    const axios = require('axios');
    await axios.post(`https://api.telegram.org/bot${process.env['TELEGRAM_BOT_TOKEN']}/sendMessage`, payload);
  } catch (error) {
    logger.error('Error de red al enviar panel VIP:', { error });
  }

  logger.info(`✅ Panel VIP enviado a telegram_id: ${telegramId}`);
  await actualizarCajitaVip();
}

// ----------------------------------------------------------
// Handler: customer.subscription.deleted
// ----------------------------------------------------------

async function manejarCancelacionSuscripcion(
  subscription: Stripe.Subscription
): Promise<void> {
  const customerId = subscription.customer as string;
  logger.info(`🚫 Cancelación inmediata de suscripción para Customer ID: ${customerId}`);

  // 1. Buscar usuario en BD y actualizar a Cancelado
  const usuario = await actualizarEstadoUsuarioPorCustomerId(customerId, 'Cancelado');

  if (!usuario) {
    logger.warn(`⚠️  No se encontró usuario con Customer ID: ${customerId}`);
    return;
  }

  // 2. Notificar al usuario (Ya no hay que banearlo de grupos, solo el Notifier dejará de enviarle mensajes)
  if (usuario.telegram_id) {
    await enviarMensaje(
      usuario.telegram_id,
      [
        `<b>🚫 Acceso finalizado</b>`,
        ``,
        `Tu tiempo de acceso VIP ha concluido de acuerdo a tu solicitud de cancelación. Ya no recibirás más notificaciones de inmuebles.`,
        ``,
        `¡Gracias por habernos acompañado! Si alguna vez decides volver, puedes reanudar tu suscripción desde el comando /start.`
      ].join('\n')
    );
  }
  await actualizarCajitaVip();
}

// ----------------------------------------------------------
// Handler: customer.subscription.updated
// Se lanza cuando el usuario pausa o programa cancelación
// ----------------------------------------------------------

async function manejarActualizacionSuscripcion(
  subscription: Stripe.Subscription
): Promise<void> {
  logger.info(`🔍 Debug Updated: ID=${subscription.customer}, status=${subscription.status}, cancel_at_period_end=${subscription.cancel_at_period_end}, cancel_at=${subscription.cancel_at}`);

  const customerId = subscription.customer as string;

  // Caso 1: El usuario programa la cancelación para el final del período
  if (subscription.cancel_at_period_end || subscription.cancel_at) {
    const cancelTimestamp = subscription.cancel_at || subscription.current_period_end;
    const fechaFin = new Date(cancelTimestamp * 1000).toLocaleDateString('es-ES');
    const isoDate = new Date(cancelTimestamp * 1000).toISOString();

    logger.info(`⏳ Suscripción de Customer ID ${customerId} programada para cancelar el ${fechaFin}`);

    const usuarioPrevio = await getUsuarioPorCustomerId(customerId);
    const yaEstabaCancelando = usuarioPrevio?.estado === 'Cancelando';

    // Programar en BD (estado = 'Cancelando', cancel_at) usando stripe_customer_id
    const usuario = await programarCancelacionUsuarioPorCustomerId(customerId, isoDate);

    // Enviar notificación a Telegram de que se cancelará a fin de mes
    // Solo enviamos el mensaje si el estado anterior NO era 'Cancelando'
    if (usuario && usuario.telegram_id && !yaEstabaCancelando) {
      await enviarMensaje(
        usuario.telegram_id,
        [
          `<b>⚠️ Suscripción cancelada</b>`,
          ``,
          `Has cancelado tu suscripción VIP. No te preocupes, <b>seguirás teniendo acceso completo hasta el ${fechaFin}</b> (fecha en la que termina tu ciclo actual).`,
          ``,
          `Una vez llegada esa fecha, dejarás de recibir alertas. ¡Aprovecha estos días!`
        ].join('\n')
      );
      await actualizarCajitaVip();
    } else if (!usuario) {
      logger.warn(`⚠️ No se encontró en la BD el usuario con stripe_customer_id: ${customerId}`);
    }
  } 
  // Caso 2: El usuario reactiva la suscripción o se renueva
  else if (!subscription.cancel_at_period_end) {
    logger.info(`🔄 Suscripción activa/reactivada para Customer ID ${customerId}`);
    
    const usuarioPrevio = await getUsuarioPorCustomerId(customerId);
    const estabaCancelando = usuarioPrevio?.estado === 'Cancelando';

    // Devolvemos el estado a 'Pagado' y quitamos 'cancel_at'
    const usuario = await reactivarUsuarioPorCustomerId(customerId);
    
    // Solo enviamos mensaje si antes estaba "Cancelando" y ahora vuelve a "Pagado"
    if (usuario && usuario.telegram_id && estabaCancelando) {
      await enviarMensaje(
        usuario.telegram_id,
        [
          `<b>🎉 ¡Suscripción Reactivada!</b>`,
          ``,
          `Has reactivado tu suscripción VIP con éxito. Seguirás recibiendo las alertas sin interrupción.`,
          ``,
          `¡Gracias por quedarte con nosotros! 🚀`
        ].join('\n')
      );
      await actualizarCajitaVip();
    }
  }
}

