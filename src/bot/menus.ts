import { Telegraf, Context, Markup } from 'telegraf';
import { getUsuarioPorTelegramId, actualizarFiltrosUsuario, getZonasConStock } from '../db/queries';
import { scheduleDigestWarmup, resetDigestCadenceOnFilterApply } from '../services/redis.service';

/** Formato aproximado para botones: si hay 100+ pisos mostramos "~116", si no, el número exacto */
function formatearConteo(count: number): string {
  return count >= 100 ? `~${count}` : `${count}`;
}

// ------------------------------------------------------------
// Panel VIP — Filtros en borrador (draft)
// ------------------------------------------------------------
// Todo cambio en los submenús (ciudad, zonas, precio, tipo, habitaciones)
// se aplica primero a un borrador en memoria (FilterDraft). La base de
// datos SOLO se actualiza cuando el usuario pulsa "✅ Aplicar" en el
// panel principal (vip_aplicar). El botón "Aplicar" dentro de un
// submenú únicamente confirma el borrador y vuelve al panel; "Atrás"
// descarta los cambios del submenú restaurando la foto (snapshot)
// tomada al entrar.
// ------------------------------------------------------------

interface FilterDraft {
  ciudad: string | null;
  zonas: string[];
  precioMax: number | null;
  tipo: string | null; // 'Piso' | 'Habitacion' | null (=ambos/cualquiera)
  habitaciones: number | null;
}

const userDrafts = new Map<string, FilterDraft>();
const submenuSnapshots = new Map<string, FilterDraft>();
/** Página actual del submenú de zonas (por usuario). */
const zonasPageByUser = new Map<string, number>();

const ZONAS_POR_PAGINA = 5;

function draftVacio(): FilterDraft {
  return { ciudad: null, zonas: [], precioMax: null, tipo: null, habitaciones: null };
}

function clonarDraft(draft: FilterDraft): FilterDraft {
  return {
    ciudad: draft.ciudad,
    zonas: [...draft.zonas],
    precioMax: draft.precioMax,
    tipo: draft.tipo,
    habitaciones: draft.habitaciones,
  };
}

/** Carga el borrador desde memoria, o desde la BD si es la primera vez en esta sesión. */
async function obtenerOCargarDraft(telegramId: string, user: any): Promise<FilterDraft> {
  const existente = userDrafts.get(telegramId);
  if (existente) return existente;

  const draft: FilterDraft = {
    ciudad: user?.filtro_ciudad ?? null,
    zonas: Array.isArray(user?.filtro_zonas) ? [...user.filtro_zonas] : [],
    precioMax: user?.filtro_precio_max ?? null,
    tipo: user?.filtro_tipo ?? null,
    habitaciones: user?.filtro_habitaciones ?? null,
  };
  userDrafts.set(telegramId, draft);
  return draft;
}

/** Comprueba que el usuario tenga VIP activo. Responde con alerta/mensaje si no. */
async function requerirUsuarioVIP(ctx: Context): Promise<any | null> {
  const telegramId = String(ctx.from?.id ?? '');
  if (!telegramId) return null;

  const user = await getUsuarioPorTelegramId(telegramId) as any;
  if (!user || (user.estado !== 'Pagado' && user.estado !== 'Cancelando')) {
    const errorMsg = '⚠️ Debes tener una suscripción VIP activa para usar el panel de filtros.';
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(errorMsg, { show_alert: true });
    } else {
      await ctx.reply(errorMsg);
    }
    return null;
  }
  return user;
}

/** Atajo: obtiene usuario VIP + su borrador en un solo paso para los handlers de submenú. */
async function requerirDraftVIP(ctx: Context): Promise<{ telegramId: string; draft: FilterDraft } | null> {
  const user = await requerirUsuarioVIP(ctx);
  if (!user) return null;
  const telegramId = String(ctx.from?.id ?? '');
  const draft = await obtenerOCargarDraft(telegramId, user);
  return { telegramId, draft };
}

function footer(prefijo: string, cualquieraLabel = '🌐 Cualquiera'): any[][] {
  return [
    [Markup.button.callback(cualquieraLabel, `vip_${prefijo}_cualquiera`)],
    [Markup.button.callback('🔙 Atrás', 'vip_sub_atras'), Markup.button.callback('✅ Aplicar', 'vip_sub_aplicar')],
  ];
}

async function volverAlPanel(ctx: Context) {
  await mostrarMenuPrincipalVIP(ctx, true);
}

// ------------------------------------------------------------
// Lógica de menús interactivos VIP (Inline Keyboards)
// ------------------------------------------------------------

export function configurarMenusVIP(bot: Telegraf) {
  // Handler del botón "Configurar Filtros VIP"
  bot.action('menu_filtros_vip', async (ctx) => {
    await ctx.answerCbQuery();
    await mostrarMenuPrincipalVIP(ctx);
  });

  // Handler para volver al menú principal de filtros
  bot.action('vip_main', async (ctx) => {
    await ctx.answerCbQuery();
    await mostrarMenuPrincipalVIP(ctx, true);
  });

  // --- Confirmación final del panel: aquí SÍ se escribe en la BD ---
  bot.action('vip_aplicar', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    await actualizarFiltrosUsuario(telegramId, {
      ciudad: resultado.draft.ciudad,
      zonas: resultado.draft.zonas,
      precioMax: resultado.draft.precioMax,
      tipo: resultado.draft.tipo,
      habitaciones: resultado.draft.habitaciones,
    });

    const warmupMin = parseInt(process.env['DIGEST_WARMUP_MIN_MINUTES'] ?? '5', 10);
    const warmupMax = parseInt(process.env['DIGEST_WARMUP_MAX_MINUTES'] ?? '15', 10);

    // Reinicia cadencia + agenda warmup (sin exponer knobs internos al VIP)
    await resetDigestCadenceOnFilterApply(telegramId);
    await scheduleDigestWarmup(telegramId, warmupMin, warmupMax);

    await ctx.answerCbQuery('Radar actualizado ✅');

    await ctx.editMessageText(
      [
        '✅ <b>Radar actualizado.</b>',
        '',
        'Tu radar VIP ya vigila el mercado con estos filtros (según tu /horario).',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[Markup.button.callback('⚙️ Volver al panel', 'vip_main')]],
        },
      }
    );
  });

  // --- Reset del borrador (no toca la BD hasta que se pulse Aplicar) ---
  bot.action('vip_reset', async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    const nuevo = draftVacio();
    userDrafts.set(resultado.telegramId, nuevo);

    await ctx.answerCbQuery('Borrador restaurado 🔄');
    await volverAlPanel(ctx);
  });

  // --- Botones comunes de pie de submenú: Atrás / Aplicar ---
  bot.action('vip_sub_atras', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const user = await requerirUsuarioVIP(ctx);
    if (!user) return;

    const snapshot = submenuSnapshots.get(telegramId);
    if (snapshot) {
      userDrafts.set(telegramId, snapshot);
      submenuSnapshots.delete(telegramId);
    }
    zonasPageByUser.delete(telegramId);

    await ctx.answerCbQuery();
    await volverAlPanel(ctx);
  });

  bot.action('vip_sub_aplicar', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const user = await requerirUsuarioVIP(ctx);
    if (!user) return;

    submenuSnapshots.delete(telegramId);
    zonasPageByUser.delete(telegramId);
    await ctx.answerCbQuery();
    await volverAlPanel(ctx);
  });

  // --- CIUDAD ---
  bot.action('vip_ciudad', async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    submenuSnapshots.set(resultado.telegramId, clonarDraft(resultado.draft));
    await ctx.answerCbQuery();
    await renderCiudadMenu(ctx, resultado.draft);
  });

  bot.action(/^draft_ciudad_(.+)$/, async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    const ciudad = ctx.match[1];
    // Nueva ciudad = otro inventario: reinicia el resto del borrador a «Cualquiera»
    if (resultado.draft.ciudad !== ciudad) {
      resultado.draft.ciudad = ciudad;
      resultado.draft.zonas = [];
      resultado.draft.precioMax = null;
      resultado.draft.tipo = null;
      resultado.draft.habitaciones = null;
    }

    await ctx.answerCbQuery(`Ciudad: ${ciudad}`);
    await renderCiudadMenu(ctx, resultado.draft);
  });

  bot.action('vip_ciudad_cualquiera', async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    resultado.draft.ciudad = null;
    resultado.draft.zonas = [];
    resultado.draft.precioMax = null;
    resultado.draft.tipo = null;
    resultado.draft.habitaciones = null;
    submenuSnapshots.delete(resultado.telegramId);

    await ctx.answerCbQuery('Ciudad: cualquiera 🌐');
    await volverAlPanel(ctx);
  });

  // --- ZONAS (inventory-aware + paginación 5/página) ---
  bot.action('vip_zonas', async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    if (!resultado.draft.ciudad) {
      await ctx.answerCbQuery('⚠️ Primero debes elegir una ciudad.', { show_alert: true });
      return;
    }

    const stock = await getZonasConStock(resultado.draft.ciudad.toLowerCase());
    if (stock.zonas.length === 0) {
      await ctx.answerCbQuery('⚠️ Todavía no tenemos suficiente inventario en esta ciudad. Vuelve a intentarlo en un rato.', { show_alert: true });
      return;
    }

    submenuSnapshots.set(resultado.telegramId, clonarDraft(resultado.draft));
    zonasPageByUser.set(resultado.telegramId, 0);
    await ctx.answerCbQuery();
    await renderZonasMenu(ctx, stock, resultado.draft.zonas, 0);
  });

  bot.action(/^draft_zonas_page_(\d+)$/, async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado || !resultado.draft.ciudad) {
      await ctx.answerCbQuery();
      return;
    }

    const page = parseInt(ctx.match[1], 10);
    const stock = await getZonasConStock(resultado.draft.ciudad.toLowerCase());
    zonasPageByUser.set(resultado.telegramId, page);
    await ctx.answerCbQuery();
    await renderZonasMenu(ctx, stock, resultado.draft.zonas, page);
  });

  bot.action('draft_zonas_noop', async (ctx) => {
    await ctx.answerCbQuery();
  });

  bot.action(/^draft_zona_(.+)$/, async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado || !resultado.draft.ciudad) {
      await ctx.answerCbQuery();
      return;
    }

    const zonaNorm = ctx.match[1];
    const stock = await getZonasConStock(resultado.draft.ciudad.toLowerCase());
    const zonaInfo = stock.zonas.find((z) => z.zonaNorm === zonaNorm);
    if (!zonaInfo) {
      await ctx.answerCbQuery('⚠️ Esa zona ya no tiene inventario disponible.', { show_alert: true });
      return;
    }

    if (resultado.draft.zonas.includes(zonaInfo.zona)) {
      resultado.draft.zonas = resultado.draft.zonas.filter((z) => z !== zonaInfo.zona);
    } else {
      resultado.draft.zonas.push(zonaInfo.zona);
    }

    const page = zonasPageByUser.get(resultado.telegramId) ?? 0;
    await ctx.answerCbQuery();
    await renderZonasMenu(ctx, stock, resultado.draft.zonas, page);
  });

  bot.action('vip_zonas_cualquiera', async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    resultado.draft.zonas = [];
    submenuSnapshots.delete(resultado.telegramId);
    zonasPageByUser.delete(resultado.telegramId);

    await ctx.answerCbQuery('Zonas: cualquiera 🌐');
    await volverAlPanel(ctx);
  });

  // --- PRECIO ---
  bot.action('vip_precio', async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    submenuSnapshots.set(resultado.telegramId, clonarDraft(resultado.draft));
    await ctx.answerCbQuery();
    await renderPrecioMenu(ctx, resultado.draft);
  });

  bot.action(/^draft_precio_(\d+)$/, async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    resultado.draft.precioMax = parseInt(ctx.match[1], 10);

    await ctx.answerCbQuery(`Precio máx: ${resultado.draft.precioMax}€`);
    await renderPrecioMenu(ctx, resultado.draft);
  });

  bot.action('vip_precio_cualquiera', async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    resultado.draft.precioMax = null;
    submenuSnapshots.delete(resultado.telegramId);

    await ctx.answerCbQuery('Precio: cualquiera 🌐');
    await volverAlPanel(ctx);
  });

  // --- TIPO ---
  bot.action('vip_tipo', async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    submenuSnapshots.set(resultado.telegramId, clonarDraft(resultado.draft));
    await ctx.answerCbQuery();
    await renderTipoMenu(ctx, resultado.draft);
  });

  bot.action(/^draft_tipo_(Piso|Habitacion)$/, async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    resultado.draft.tipo = ctx.match[1];

    await ctx.answerCbQuery('Tipo actualizado');
    await renderTipoMenu(ctx, resultado.draft);
  });

  bot.action('vip_tipo_cualquiera', async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    resultado.draft.tipo = null;
    submenuSnapshots.delete(resultado.telegramId);

    await ctx.answerCbQuery('Tipo: cualquiera 🌐');
    await volverAlPanel(ctx);
  });

  // --- HABITACIONES ---
  bot.action('vip_habitaciones', async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    submenuSnapshots.set(resultado.telegramId, clonarDraft(resultado.draft));
    await ctx.answerCbQuery();
    await renderHabitacionesMenu(ctx, resultado.draft);
  });

  bot.action(/^draft_habs_(\d)$/, async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    resultado.draft.habitaciones = parseInt(ctx.match[1], 10);
    const label =
      resultado.draft.habitaciones === 0
        ? '0'
        : `${resultado.draft.habitaciones}+`;

    await ctx.answerCbQuery(`Habitaciones: ${label}`);
    await renderHabitacionesMenu(ctx, resultado.draft);
  });

  bot.action('vip_habs_cualquiera', async (ctx) => {
    const resultado = await requerirDraftVIP(ctx);
    if (!resultado) return;

    resultado.draft.habitaciones = null;
    submenuSnapshots.delete(resultado.telegramId);

    await ctx.answerCbQuery('Habitaciones: cualquiera 🌐');
    await volverAlPanel(ctx);
  });
}

// ------------------------------------------------------------
// Renderizado de submenús
// ------------------------------------------------------------

async function renderCiudadMenu(ctx: Context, draft: FilterDraft) {
  const marca = (c: string) => (draft.ciudad === c ? '✅ ' : '');
  const botones = [
    [
      Markup.button.callback(`${marca('Barcelona')}Barcelona`, 'draft_ciudad_Barcelona'),
      Markup.button.callback(`${marca('Madrid')}Madrid`, 'draft_ciudad_Madrid'),
    ],
    [Markup.button.callback(`${marca('Valencia')}Valencia`, 'draft_ciudad_Valencia')],
    ...footer('ciudad'),
  ];

  await editarMensaje(ctx, '🏙️ <b>Ciudad</b>\n\nElige la ciudad en la que buscas:', botones);
}

async function renderZonasMenu(
  ctx: Context,
  stock: { zonas: { zona: string; zonaNorm: string; count: number }[]; totalCiudad: number; sinClasificar: number },
  zonasActuales: string[],
  page = 0
) {
  const { zonas, totalCiudad, sinClasificar } = stock;
  const totalPages = Math.max(1, Math.ceil(zonas.length / ZONAS_POR_PAGINA));
  const pageSafe = Math.min(Math.max(0, page), totalPages - 1);
  const inicio = pageSafe * ZONAS_POR_PAGINA;
  const slice = zonas.slice(inicio, inicio + ZONAS_POR_PAGINA);

  const botones = slice.map((z) => {
    const isSelected = zonasActuales.includes(z.zona);
    const nombre = z.zona.replace(/\s*\((BCN|MAD|VLC)\)\s*$/i, '');
    const etiqueta = `${isSelected ? '✅' : '⬜'} ${nombre} (${formatearConteo(z.count)})`;
    return [Markup.button.callback(etiqueta, `draft_zona_${z.zonaNorm}`)];
  });

  if (totalPages > 1) {
    const nav: ReturnType<typeof Markup.button.callback>[] = [];
    if (pageSafe > 0) {
      nav.push(Markup.button.callback('⬅️ Ant.', `draft_zonas_page_${pageSafe - 1}`));
    }
    nav.push(Markup.button.callback(`📄 ${pageSafe + 1}/${totalPages}`, 'draft_zonas_noop'));
    if (pageSafe < totalPages - 1) {
      nav.push(Markup.button.callback('Sig. ➡️', `draft_zonas_page_${pageSafe + 1}`));
    }
    botones.push(nav);
  }

  botones.push(...footer('zonas', `🌐 Cualquiera (${formatearConteo(totalCiudad)})`));

  const seleccionadas =
    zonasActuales.length > 0 ? `\nSeleccionadas: <b>${zonasActuales.length}</b>` : '';

  const aviso =
    `ℹ️ Con <b>Cualquiera</b> entran todos (${formatearConteo(totalCiudad)}), ` +
    `incluidos los que el sistema no pudo asignar a un distrito (${formatearConteo(sinClasificar)}).\n\n`;

  await editarMensaje(
    ctx,
    `📍 <b>Zonas</b> <i>(${inicio + 1}–${inicio + slice.length} de ${zonas.length})</i>\n\n` +
      aviso +
      `Selecciona las zonas que te interesan (entre paréntesis, los pisos disponibles ahora mismo):` +
      seleccionadas,
    botones
  );
}

async function renderPrecioMenu(ctx: Context, draft: FilterDraft) {
  const marca = (p: number | null) => (draft.precioMax === p ? '✅ ' : '');
  const cualquiera = draft.precioMax == null ? '✅ ' : '';
  const botones = [
    [
      Markup.button.callback(`${marca(600)}Menos de 600€`, 'draft_precio_600'),
      Markup.button.callback(`${marca(900)}Menos de 900€`, 'draft_precio_900'),
    ],
    [
      Markup.button.callback(`${marca(1200)}Menos de 1200€`, 'draft_precio_1200'),
      Markup.button.callback(`${cualquiera}🌐 Cualquiera`, 'vip_precio_cualquiera'),
    ],
    [Markup.button.callback('🔙 Atrás', 'vip_sub_atras'), Markup.button.callback('✅ Aplicar', 'vip_sub_aplicar')],
  ];

  await editarMensaje(ctx, '💰 <b>Precio máximo</b>\n\nElige tu presupuesto:', botones);
}

async function renderTipoMenu(ctx: Context, draft: FilterDraft) {
  const marca = (t: string) => (draft.tipo === t ? '✅ ' : '');
  const botones = [
    [Markup.button.callback(`${marca('Piso')}Piso / Casa`, 'draft_tipo_Piso')],
    [Markup.button.callback(`${marca('Habitacion')}Habitación`, 'draft_tipo_Habitacion')],
    ...footer('tipo'),
  ];

  await editarMensaje(ctx, '🏠 <b>Tipo de inmueble</b>\n\n¿Qué buscas?', botones);
}

async function renderHabitacionesMenu(ctx: Context, draft: FilterDraft) {
  const marca = (h: number) => (draft.habitaciones === h ? '✅ ' : '');
  const botones = [
    [
      Markup.button.callback(`${marca(0)}0`, 'draft_habs_0'),
      Markup.button.callback(`${marca(1)}1+`, 'draft_habs_1'),
      Markup.button.callback(`${marca(2)}2+`, 'draft_habs_2'),
    ],
    [
      Markup.button.callback(`${marca(3)}3+`, 'draft_habs_3'),
      Markup.button.callback(`${marca(4)}4+`, 'draft_habs_4'),
    ],
    ...footer('habs'),
  ];

  await editarMensaje(
    ctx,
    '🛏️ <b>Habitaciones</b>\n\n' +
      '<b>0</b> = sin habitación (estudio / todo en el salón).\n' +
      '<b>1+</b>, <b>2+</b>… = mínimo de habitaciones.',
    botones
  );
}

async function editarMensaje(ctx: Context, texto: string, botones: any[][]) {
  if (ctx.callbackQuery) {
    await ctx.editMessageText(texto, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: botones },
    }).catch(() => {});
  } else {
    await ctx.reply(texto, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: botones },
    });
  }
}

// ------------------------------------------------------------
// Panel principal (dashboard) de filtros VIP
// ------------------------------------------------------------

export async function mostrarMenuPrincipalVIP(ctx: Context, editMessage = false) {
  const user = await requerirUsuarioVIP(ctx);
  if (!user) return;

  const telegramId = String(ctx.from?.id ?? '');
  const draft = await obtenerOCargarDraft(telegramId, user);

  const ciudadStr = draft.ciudad ?? 'Cualquiera';
  const zonasStr = draft.zonas.length > 0 ? draft.zonas.join(', ') : 'Cualquiera';
  const precioStr = draft.precioMax ? `${draft.precioMax}€` : 'Cualquiera';
  const tipoStr = draft.tipo === 'Piso' ? 'Piso / Casa' : draft.tipo === 'Habitacion' ? 'Habitación' : 'Cualquiera';
  const habsStr =
    draft.habitaciones === 0
      ? '0'
      : draft.habitaciones
        ? `${draft.habitaciones}+`
        : 'Cualquiera';

  const texto = [
    `⚙️ <b>Panel VIP — Tu radar</b>`,
    ``,
    `🏙️ <b>Ciudad:</b> ${ciudadStr}`,
    `📍 <b>Zonas:</b> ${zonasStr}`,
    `💰 <b>Precio máx:</b> ${precioStr}`,
    `🏠 <b>Tipo:</b> ${tipoStr}`,
    `🛏️ <b>Habitaciones:</b> ${habsStr}`,
    ``,
    `<i>Cada submenú → Aplicar actualiza el borrador. Aplicar del panel guarda el radar.</i>`,
  ].join('\n');

  const botones = [
    [Markup.button.callback('🏙️ Ciudad', 'vip_ciudad'), Markup.button.callback('📍 Zonas', 'vip_zonas')],
    [Markup.button.callback('💰 Precio', 'vip_precio'), Markup.button.callback('🏠 Tipo', 'vip_tipo')],
    [Markup.button.callback('🛏️ Habitaciones', 'vip_habitaciones')],
    [Markup.button.callback('🔄 Reset', 'vip_reset'), Markup.button.callback('✅ Aplicar', 'vip_aplicar')],
  ];

  if (editMessage && ctx.callbackQuery) {
    await ctx.editMessageText(texto, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: botones },
    }).catch(() => {});
  } else {
    await ctx.reply(texto, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: botones },
    });
  }
}
