import { Telegraf, Context, Markup } from 'telegraf';
import {
  registrarUsuario,
  getUsuarioPorTelegramId,
  eliminarCuentaUsuario,
  contarUsuariosVip,
  AI_FREE_MAX,
  AI_VIP_DAILY_MAX,
  AI_VIP_WEEKLY_MAX,
  AI_BROKEN_LINK_DAILY_MAX,
  AI_AD_RECOVERY_DAILY_MAX,
} from '../db/queries';
import { generarEnlacePublicoPermanente } from '../services/telegram.service';
import { responderConsultaAsesor, type ChatMessage } from '../services/ai.service';
import {
  actualizarCajitaVip,
  construirTextoCajitaVip,
  programarCajitaVipAlArranque,
} from '../services/vipCounter.service';
import { logger } from '../services/logger';
import { configurarMenusVIP, mostrarMenuPrincipalVIP } from './menus';
import { abrirHorario, setupHorarioMenu } from './horario.menu';
import {
  formatDigestDays,
  formatHourRange,
  loadDigestPrefs,
} from '../services/digest-schedule.service';

// ============================================================
// TELEGRAM BOT — Bot de entrada para usuarios
// Estilo de UX inspirado en AutoBroker: bienvenida con <blockquote>
// (acento "azul claro" de Telegram — no configurable vía API, es el
// estilo visual que usa Telegram para blockquote), panel VIP con
// borrador de filtros, y Asesor IA siempre disponible al escribir.
// ============================================================

let bot: Telegraf | null = null;

// Rate limiting básico: mapa de última acción por usuario
const lastActionTime = new Map<string, number>();
const RATE_LIMIT_MS = 1000; // 1 segundo entre acciones

function isRateLimited(telegramId: string): boolean {
  const last = lastActionTime.get(telegramId) ?? 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_MS) return true;
  lastActionTime.set(telegramId, now);
  return false;
}

const LEGAL_URL = 'https://drive.google.com/file/d/1DTtZYysvRr2gzv3T7lskr5D87yeREJ6h/view?usp=sharing';

// ------------------------------------------------------------
// Asesor IA — historial de conversación por usuario.
//
// UX estilo AutoBroker: cualquier texto libre que no sea un comando se
// enruta automáticamente al Asesor IA. Si se agota la cuota, se pausa
// el enrutado hasta que el usuario escriba /asesor de nuevo.
// ------------------------------------------------------------

const MAX_HISTORIAL_MENSAJES = 6;
const historialAsesor = new Map<string, ChatMessage[]>();
const salidaManualAsesor = new Set<string>();

function agregarAlHistorial(telegramId: string, mensaje: ChatMessage): void {
  const historial = historialAsesor.get(telegramId) ?? [];
  historial.push(mensaje);
  while (historial.length > MAX_HISTORIAL_MENSAJES) {
    historial.shift();
  }
  historialAsesor.set(telegramId, historial);
}

export function getTelegramBot(): Telegraf {
  if (bot) return bot;

  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) {
    logger.error('TELEGRAM_BOT_TOKEN no configurado en .env');
    throw new Error('TELEGRAM_BOT_TOKEN no configurado en .env');
  }

  bot = new Telegraf(token);
  configurarHandlers(bot);
  return bot;
}

// ------------------------------------------------------------
// Handlers del bot
// ------------------------------------------------------------

function configurarHandlers(botInstance: Telegraf): void {

  // Middleware: Ignorar cualquier mensaje que venga de un grupo (para no hacer spam en el VIP)
  botInstance.use(async (ctx, next) => {
    const adminChatId = String(process.env['TELEGRAM_ADMIN_ID'] ?? '').trim();
    const chatId = String(ctx.chat?.id ?? '');
    const esChatAdmins = !!adminChatId && chatId === adminChatId;

    if (ctx.chat?.type !== 'private' && !esChatAdmins) return;
    await next();
  });

  // Configurar los menús interactivos del VIP
  configurarMenusVIP(botInstance);
  setupHorarioMenu(botInstance);

  // /start — Bienvenida
  botInstance.start(enviarMensajeBienvenida);

  // /filtros — Atajo directo al panel de radar VIP
  botInstance.command('filtros', abrirFiltros);

  // /horario · /schedule — Días / horas / intervalo de alertas VIP
  botInstance.command('horario', abrirHorario);
  botInstance.command('schedule', abrirHorario);

  // /estado — Información de suscripción
  botInstance.command('estado', mostrarEstado);

  // /vip_count — Solo admin: contador de VIP actuales
  botInstance.command('vip_count', mostrarContadorVipAdmin);

  // /eliminar_cuenta (RGPD) — /borrar_datos se mantiene como alias
  botInstance.command('eliminar_cuenta', eliminarCuenta);
  botInstance.command('borrar_datos', eliminarCuenta);

  // /asesor — Muestra la ayuda del Asesor Inmobiliario IA y lo activa
  botInstance.command('asesor', iniciarModoAsesor);

  // ── Botón "Ver mi Estado" desde mensaje de bienvenida ──────
  botInstance.action('ver_estado', async (ctx) => {
    await ctx.answerCbQuery();
    await mostrarEstado(ctx);
  });

  // Cualquier otro mensaje de texto que no sea un comando se enruta al
  // Asesor IA automáticamente (estilo AutoBroker), salvo si la cuota
  // se agotó (entonces se muestra la bienvenida hasta /asesor).
  botInstance.on('message', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const textoMensaje = (ctx.message as any)?.text as string | undefined;

    if (textoMensaje && !textoMensaje.startsWith('/')) {
      if (salidaManualAsesor.has(telegramId)) {
        if (isRateLimited(telegramId)) return;
        await enviarMensajeBienvenida(ctx);
        return;
      }
      await manejarMensajeAsesor(ctx, telegramId, textoMensaje);
      return;
    }

    if (isRateLimited(telegramId)) return;
    await enviarMensajeBienvenida(ctx);
  });

  botInstance.catch((err: unknown, ctx: Context) => {
    logger.error(`❌ Error en bot para update ${ctx.updateType}:`, { err });
  });
}

// ------------------------------------------------------------
// Comando /filtros — Atajo al panel de radar VIP
// ------------------------------------------------------------

async function abrirFiltros(ctx: Context) {
  const telegramId = String(ctx.from?.id ?? '');
  if (!telegramId) return;

  const user = await getUsuarioPorTelegramId(telegramId);
  const esVIP = user && (user.estado === 'Pagado' || user.estado === 'Cancelando');

  if (!esVIP) {
    await ctx.reply('⚠️ El radar de filtros es solo para usuarios VIP. Usa /start para ver cómo suscribirte.');
    return;
  }

  await mostrarMenuPrincipalVIP(ctx);
}

// ------------------------------------------------------------
// Comando /estado — Información de suscripción
// ------------------------------------------------------------

async function mostrarEstado(ctx: Context) {
  const telegramId = String(ctx.from?.id ?? '');
  if (!telegramId) return;

  const user = await getUsuarioPorTelegramId(telegramId);

  if (!user) {
    await ctx.reply('No estás registrado. Usa /start para comenzar.');
    return;
  }

  const esVIP = user.estado === 'Pagado' || user.estado === 'Cancelando';

  let emoji = '⏳';
  let estadoDisplay = 'Pendiente (Esperando activación)';

  if (user.estado === 'Pagado') {
    emoji = '✅';
    estadoDisplay = 'VIP Activo';
  } else if (user.estado === 'Cancelando') {
    emoji = '⚠️';
    const fechaCancel = user.cancel_at ? new Date(user.cancel_at).toLocaleDateString('es-ES') : 'próximamente';
    estadoDisplay = `Cancelada (Activa hasta el ${fechaCancel})`;
  }

  const fechaRegistro = user.created_at ? new Date(user.created_at).toLocaleDateString('es-ES') : 'Desconocida';
  const texto = [
    `📋 <b>Tu estado en Alertas VIP</b>`,
    ``,
    `${emoji} <b>Suscripción:</b> ${estadoDisplay}`,
  ];

  if (esVIP) {
    texto.push(`📅 <b>Miembro VIP desde:</b> ${fechaRegistro}`);
    try {
      const prefs = await loadDigestPrefs(telegramId);
      texto.push(
        `⏰ <b>Horario alertas:</b> ${formatDigestDays(prefs.days)} · ${formatHourRange(prefs.startHour, prefs.endHour)} · cada ${prefs.intervalH} h`
      );
    } catch {
      /* ignore */
    }
  }

  texto.push(
    ``,
    esVIP
      ? `✨ Tu radar vigila según tu /horario. Te avisamos cuando hay algo para ti.`
      : `👇 Suscríbete al plan VIP para activar tu radar personalizado.`
  );

  await ctx.reply(texto.join('\n'), {
    parse_mode: 'HTML'
  });
}

function esChatAdmins(ctx: Context): boolean {
  const adminChatId = String(process.env['TELEGRAM_ADMIN_ID'] ?? '').trim();
  const chatId = String(ctx.chat?.id ?? '');
  return !!adminChatId && chatId === adminChatId;
}

async function mostrarContadorVipAdmin(ctx: Context) {
  // Permitido solo dentro del chat de admins configurado.
  if (!esChatAdmins(ctx)) {
    await ctx.reply('⛔ Este comando es solo para administradores.');
    return;
  }

  const vipCount = await contarUsuariosVip();
  // Mismo diseño que el panel vivo (cajita ASCII + tier + hora)
  await ctx.reply(construirTextoCajitaVip(vipCount), { parse_mode: 'HTML' });
  // Sincroniza también el mensaje único que se edita in situ
  void actualizarCajitaVip();
}

// ------------------------------------------------------------
// Comando /asesor — Asesor Inmobiliario IA
// ------------------------------------------------------------

function textoAyudaAsesor(esVIP: boolean): string {
  return [
    `🤖 <b>Asesor inmobiliario IA</b>`,
    ``,
    `Escribe aquí cuando quieras comparar zonas, pedir consejo profesional, o evaluar qué barrio te encaja mejor.`,
    `También para recuperar un anuncio perdido o pedir alternativa si un enlace está caído. Enfocado en alquiler en Barcelona, Madrid y Valencia.`,
    ``,
    `🆓 <b>Versión gratuita</b>`,
    `<blockquote>«${AI_FREE_MAX} interacciones»\n• Consejo de zonas sin anuncio\n• Al recuperar: 1 ficha (sin enlace)</blockquote>`,
    ``,
    `💎 <b>VIP</b>`,
    `<blockquote>«Chat: hasta ${AI_VIP_DAILY_MAX}/día y ${AI_VIP_WEEKLY_MAX}/semana»\n• Consejo de zonas sin anuncio\n• Recuperar anuncio perdido: hasta ${AI_AD_RECOVERY_DAILY_MAX} enlaces/día (solo cuenta si hay anuncio)\n• Enlace roto → alternativa: ${AI_BROKEN_LINK_DAILY_MAX}/día (solo si hay anuncio)\n• Digests del radar: hasta 3 anuncios con enlace</blockquote>`,
    ``,
    `💬 <b>Ejemplos de consejo (sin anuncio ni enlace)</b>`,
    `<blockquote>¿Qué barrios de Barcelona son mejores en cuanto a calidad-precio bajo 900€?\n\n¿Gràcia o Eixample para alguien que teletrabaja y quiere metro cerca?\n\n¿Cómo escribir al casero para que me respondan el primero?</blockquote>`,
    ``,
    `🎁 <b>Recompensa si hay un enlace roto</b> <i>(${AI_BROKEN_LINK_DAILY_MAX}/día VIP)</i>`,
    esVIP
      ? `Si un «Anuncio encontrado» ya no funciona, dile al asesor <b>«el enlace está caído»</b> o <b>«dame una alternativa»</b> y descríbele ciudad/zona/precio (o el piso que buscabas). Te buscará <b>1 anuncio real</b> de la BD lo más parecido posible — no usa automáticamente los filtros de tu radar VIP.`
      : `Solo VIP: enlaces clicables y 1 alternativa/día si un anuncio cae. En prueba gratuita, al recuperar ves la ficha completa pero sin enlace.`,
    ``,
    `🔄 <b>Recuperar un anuncio</b> <i>(hasta ${AI_AD_RECOVERY_DAILY_MAX}/día VIP con enlace)</i>`,
    `Si perdiste un piso que viste (o solo recuerdas parte), descríbemelo y te ayudo a recuperarlo o a encontrar uno parecido. Cuantos más datos, más cerca. Los cupos se reinician cada día.`,
    ``,
    `📝 <b>Ejemplos para recuperar (aquí sí hay ficha + enlace VIP)</b>`,
    `<blockquote>Piso en Gràcia (Barcelona), menos de 900€, 1 habitación. <b>Dame el link del anuncio.</b>\n👉 <b>Anuncio encontrado</b>\n\nChamberí (Madrid), aprox. 800€, 2 hab. <b>Dame el link del anuncio.</b>\n👉 <b>Anuncio encontrado</b>\n\nHabitación en Ruzafa (Valencia), menos de 400€. <b>Dame el link del anuncio.</b>\n👉 <b>Anuncio encontrado</b></blockquote>`,
    ``,
    `<i>Tip: la ficha y el enlace «Anuncio encontrado» solo aparecen al recuperar un anuncio o por enlace caído — no al comparar zonas.</i>`,
  ].join('\n');
}

async function iniciarModoAsesor(ctx: Context) {
  const telegramId = String(ctx.from?.id ?? '');
  if (!telegramId) return;

  const user = await getUsuarioPorTelegramId(telegramId);
  if (!user) {
    await ctx.reply('No estás registrado todavía. Usa /start para comenzar.');
    return;
  }

  const esVIP = user.estado === 'Pagado' || user.estado === 'Cancelando';

  // Si ya estaba conversando con el asesor, mantenemos su historial:
  // solo mostramos la ayuda de nuevo.
  const yaActivo = !salidaManualAsesor.has(telegramId) && historialAsesor.has(telegramId);
  salidaManualAsesor.delete(telegramId);
  if (!yaActivo) {
    historialAsesor.set(telegramId, []);
  }

  await ctx.reply(textoAyudaAsesor(esVIP), { parse_mode: 'HTML' });
}

async function manejarMensajeAsesor(ctx: Context, telegramId: string, mensaje: string) {
  if (isRateLimited(telegramId)) return;

  try {
    await ctx.sendChatAction('typing');
  } catch {
    // Ignorar si Telegram rechaza el chat action (no crítico)
  }

  const historial = historialAsesor.get(telegramId) ?? [];
  const resultado = await responderConsultaAsesor(telegramId, mensaje, historial);

  if (resultado.permitido) {
    agregarAlHistorial(telegramId, { role: 'user', content: mensaje });
    agregarAlHistorial(telegramId, { role: 'assistant', content: resultado.texto });
  } else {
    // Cuota agotada: pausamos el enrutado automático para no repetir el
    // aviso de cuota en cada mensaje; el usuario puede volver con /asesor.
    salidaManualAsesor.add(telegramId);
  }

  await ctx.reply(resultado.texto, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

// ------------------------------------------------------------
// Comando /eliminar_cuenta — Eliminación RGPD (borrado suave)
// ------------------------------------------------------------
async function eliminarCuenta(ctx: Context) {
  const telegramId = String(ctx.from?.id ?? '');
  if (!telegramId) return;

  const user = await getUsuarioPorTelegramId(telegramId);
  if (!user) {
    await ctx.reply('No tenemos ningún dato tuyo registrado en nuestro sistema.');
    return;
  }

  if (user.estado === 'Pagado') {
    await ctx.reply(
      '⚠️ <b>Tu VIP está activo ahora mismo.</b>\n\n' +
      'Antes de eliminar tu cuenta, cancela tu suscripción desde el botón de gestión (Stripe) para evitar cobros futuros. ' +
      'Cuando la cancelación se haga efectiva, podrás usar /eliminar_cuenta o el sistema limpiará tus filtros, mensajes con enlaces y datos personales automáticamente 48 h después.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (user.estado === 'Cancelando') {
    const fechaCancel = user.cancel_at ? new Date(user.cancel_at).toLocaleDateString('es-ES') : 'próximamente';
    await ctx.reply(
      `⚠️ Tu VIP sigue activo hasta ${fechaCancel}.\n\n` +
      'Cuando termine pasarás a plan gratuito y podrás usar /eliminar_cuenta, o el sistema limpiará filtros, mensajes con enlaces y datos personales tras 48 h.\n\n' +
      'Tu ID de Telegram se conserva para que las 3 pruebas gratis del Asesor IA no se reinicien.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const exito = await eliminarCuentaUsuario(telegramId);
  if (exito) {
    logger.info(`🗑️ Usuario ${telegramId} ha eliminado sus datos mediante /eliminar_cuenta`);
    await ctx.reply(
      '✅ <b>Tus datos personales han sido eliminados.</b>\n\n' +
      'Hemos borrado tu email, filtros, historial de notificaciones y cualquier vínculo con Stripe.\n\n' +
      '<i>Tu ID de Telegram se conserva para que tus 3 pruebas gratis del Asesor IA no se reinicien si vuelves a escribirnos.</i>',
      { parse_mode: 'HTML' }
    );
  } else {
    await ctx.reply('❌ Ha ocurrido un error al intentar eliminar tus datos. Por favor, contacta con soporte.');
  }
}


// ------------------------------------------------------------
// Mensaje de bienvenida
// ------------------------------------------------------------

async function enviarMensajeBienvenida(ctx: Context) {
  const telegramId = String(ctx.from?.id ?? '');
  if (!telegramId) return;

  const resultado = await registrarUsuario(telegramId);
  const esNuevo = resultado === 'nuevo';

  const user = await getUsuarioPorTelegramId(telegramId);
  const esVIP = user && (user.estado === 'Pagado' || user.estado === 'Cancelando');

  if (esNuevo) {
    logger.info(`👤 Usuario ${telegramId} registrado (nuevo)`);
  }

  const vipCount = await contarUsuariosVip();
  let paymentLink = '';

  if (vipCount < 200) {
    paymentLink = process.env['STRIPE_PAYMENT_LINK'] ?? '';
  } else if (vipCount < 300) {
    paymentLink = process.env['STRIPE_PAYMENT_LINK_TIER2'] ?? process.env['STRIPE_PAYMENT_LINK'] ?? '';
  } else {
    paymentLink = process.env['STRIPE_PAYMENT_LINK_TIER3'] ?? process.env['STRIPE_PAYMENT_LINK_TIER2'] ?? process.env['STRIPE_PAYMENT_LINK'] ?? '';
  }

  const urlPago = paymentLink
    ? `${paymentLink}?client_reference_id=${telegramId}`
    : '#';

  // El botón gratuito necesita ser un link HTTP válido para que Telegram no tire Error 400.
  let publicChannelLink = process.env['TELEGRAM_PUBLIC_CHANNEL_ID'];

  if (publicChannelLink && !publicChannelLink.startsWith('http')) {
    // Es un ID numérico (-5587915940) o un username.
    // Le pedimos a Telegram que nos dé el link público oficial para que cualquier persona pueda unirse libremente.
    const link = await generarEnlacePublicoPermanente(publicChannelLink);
    if (link) {
      publicChannelLink = link;
    } else {
      // Si falla la generación por permisos, ponemos un link de texto para no crashear
      publicChannelLink = `https://t.me/${publicChannelLink.replace('@', '')}`;
    }
  }

  const texto = esVIP
    ? textoBienvenidaVIP()
    : textoBienvenidaFree();

  const botones: any[] = [];

  if (esVIP) {
    botones.push([Markup.button.callback('📋 Ver mi Estado', 'ver_estado'), Markup.button.url('⚖️ Privacidad', LEGAL_URL)]);
    botones.push([Markup.button.callback('⚙️ Configurar filtros VIP', 'menu_filtros_vip')]);
    botones.push([Markup.button.callback('⏰ Horario de alertas', 'vip_horario')]);
    const portalUrl = process.env['STRIPE_BILLING_PORTAL_URL'];
    if (portalUrl) {
      botones.push([Markup.button.url('💳 Gestionar mi suscripción', portalUrl)]);
    }
  } else {
    if (publicChannelLink) {
      botones.push([Markup.button.url('🆓 Canal gratuito', publicChannelLink)]);
    }
    botones.push([Markup.button.url('💎 Suscribirse VIP', urlPago)]);
    botones.push([Markup.button.callback('📋 Ver estado', 'ver_estado'), Markup.button.url('⚖️ Privacidad', LEGAL_URL)]);
  }

  try {
    await ctx.reply(texto, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: botones },
    });
  } catch (error) {
    logger.error('❌ Error enviando mensaje de bienvenida:', { error });
  }
}

function textoBienvenidaVIP(): string {
  return [
    `👑 <b>Bienvenido a Alertas VIP — VIP activo</b>`,
    ``,
    `Tu suscripción está activa. Vigilamos portales de alquiler en Barcelona, Madrid y Valencia para cazar chollos y avisarte sin spam.`,
    ``,
    `🆓 <b>Plan gratuito</b>`,
    `<blockquote>El canal público publica solo 1 chollo de muestra al día, para que cualquiera vea la potencia del sistema.</blockquote>`,
    ``,
    `🤖 <b>Asesor IA</b>`,
    `<blockquote>Escribe aquí cuando quieras comparar alquileres, cuando necesites un punto de vista profesional, o cuando quieras evaluar qué zona te encaja mejor para vivir.\n\nVersión gratuita: ${AI_FREE_MAX} interacciones · 1 anuncio por mensaje · sin enlace.</blockquote>`,
    ``,
    `💎 <b>VIP</b>`,
    `<blockquote>Configura tu radar (ciudad, zonas, precio, tipo, habitaciones) y el /horario (días, horas e intervalo) y recibe alertas con enlace. Más uso del asesor IA.</blockquote>`,
    ``,
    `⌨️ <b>Comandos útiles</b>`,
    `<blockquote>/start — este menú\n/filtros — radar VIP\n/horario — días, horas e intervalo de alertas\n/asesor — cómo usar la IA\n/estado — tu suscripción\n/eliminar_cuenta — borrar datos personales (solo cuando el VIP haya terminado)</blockquote>`,
    ``,
    `👇 <i>Elige una opción, un comando, o escribe al asesor:</i>`,
  ].join('\n');
}

function textoBienvenidaFree(): string {
  return [
    `👋 <b>Bienvenido a Alertas VIP Inmobiliarias</b>`,
    ``,
    `¿Qué puede hacer este bot?`,
    `<blockquote>🔎 Escanea múltiples portales de alquiler 24/7 en Barcelona, Madrid y Valencia.\n📡 Radar personalizado VIP: eliges ciudad, zonas, precio, tipo y habitaciones.\n🤖 Asesor IA experto en barrios: zonas, precios justos, cómo contactar rápido.\n🚫 Sin spam: solo alertas filtradas a tu medida.</blockquote>`,
    ``,
    `🆓 <b>Plan gratuito</b>`,
    `<blockquote>Canal público con 1 chollo de muestra al día, para que veas la potencia del sistema antes de suscribirte.</blockquote>`,
    ``,
    `🤖 <b>Asesor IA</b>`,
    `<blockquote>Escribe aquí cuando quieras comparar alquileres, cuando necesites un punto de vista profesional, o cuando quieras evaluar qué zona te encaja mejor para vivir.\n\nVersión gratuita: ${AI_FREE_MAX} interacciones · 1 anuncio por mensaje · sin enlace.</blockquote>`,
    ``,
    `💎 <b>Hazte VIP</b>`,
    `<blockquote>Activa tu radar 24/7 con alertas y enlace directo en cuanto lo detectamos en el ciclo de vigilancia. Sé de los primeros en enterarte.</blockquote>`,
    ``,
    `⌨️ <b>Comandos útiles</b>`,
    `<blockquote>/start — este menú\n/asesor — habla con la IA\n/estado — tu suscripción\n/eliminar_cuenta — borrar tus datos</blockquote>`,
    ``,
    `👇 <i>Elige una opción, un comando, o escribe al asesor:</i>`,
  ].join('\n');
}

// ------------------------------------------------------------
// Inicialización y cierre
// ------------------------------------------------------------

const COMANDOS_USUARIO = [
  { command: 'start', description: '🏠 Inicio y bienvenida' },
  { command: 'filtros', description: '⚙️ Configurar tu radar VIP' },
  { command: 'horario', description: '⏰ Días, horas e intervalo de alertas' },
  { command: 'asesor', description: '🤖 Hablar con el Asesor Inmobiliario IA' },
  { command: 'estado', description: '📋 Ver mi estado de suscripción' },
  { command: 'eliminar_cuenta', description: '🗑️ Eliminar mis datos (RGPD)' },
] as const;

const COMANDOS_ADMIN_EXTRA = [
  { command: 'vip_count', description: '📊 Consulta puntual VIP (admin)' },
] as const;

async function configurarComandosBot(botInstance: Telegraf): Promise<void> {
  // Menú público (chats privados / por defecto): sin comandos admin
  await botInstance.telegram.setMyCommands([...COMANDOS_USUARIO]);

  const adminChatId = String(process.env['TELEGRAM_ADMIN_ID'] ?? '').trim();
  if (!adminChatId) {
    logger.warn('⚠️ TELEGRAM_ADMIN_ID no definido — menú admin no registrado');
    return;
  }

  // Menú del grupo/chat admin: comandos de usuario + privados de admin
  try {
    await botInstance.telegram.setMyCommands(
      [...COMANDOS_USUARIO, ...COMANDOS_ADMIN_EXTRA],
      { scope: { type: 'chat', chat_id: adminChatId } }
    );
    logger.info(`✅ Comandos admin registrados en chat ${adminChatId}`);
  } catch (error) {
    logger.warn('⚠️ No se pudo registrar menú de comandos en el chat admin', { error });
  }
}

export async function iniciarBot(): Promise<void> {
  const botInstance = getTelegramBot();

  await configurarComandosBot(botInstance);

  logger.info('🤖 Iniciando bot de Telegram (long polling)...');
  await botInstance.launch();
  logger.info('✅ Bot de Telegram activo.');

  // Panel vivo VIP en chat admin (edit in-place); ~12 s tras arrancar.
  programarCajitaVipAlArranque(12_000);
}

export async function detenerBot(): Promise<void> {
  if (bot) {
    bot.stop('SIGTERM');
    logger.info('🛑 Bot de Telegram detenido.');
  }
}
