import axios from 'axios';

import { logger } from './logger';

// ============================================================
// TELEGRAM SERVICE — Envío de mensajes al grupo VIP
// ============================================================

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Devuelve la URL base del bot de Telegram.
 */
function getBotURL(): string {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN no configurado en .env');
  return `${TELEGRAM_API_BASE}/bot${token}`;
}

// ------------------------------------------------------------
// Envío de mensajes
// ------------------------------------------------------------

/**
 * Envía un mensaje de texto a un chat de Telegram.
 * Retorna el message_id y el chat_id devuelto por Telegram si fue exitoso.
 */
export async function enviarMensaje(
  chatId: string,
  texto: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML',
  messageThreadId?: string,
  opts?: { disableWebPagePreview?: boolean }
): Promise<{ messageId: number; chatId: string } | null> {
  try {
    const payload: any = {
      chat_id: chatId,
      text: texto,
      parse_mode: parseMode,
      disable_web_page_preview: opts?.disableWebPagePreview ?? false,
    };

    if (messageThreadId) {
      payload.message_thread_id = messageThreadId;
    }

    const res = await axios.post(`${getBotURL()}/sendMessage`, payload);
    
    const messageId = res.data?.result?.message_id;
    const finalChatId = res.data?.result?.chat?.id?.toString() ?? chatId;
    
    if (messageId) {
      return { messageId, chatId: finalChatId };
    }
    return null;
  } catch (error) {
    logger.error(`❌ Error enviando mensaje a ${chatId}:`, { error });
    return null;
  }
}

/**
 * Edita el texto de un mensaje existente (cajita admin, etc.).
 * Retorna false si el mensaje no existe / no se pudo editar.
 */
export async function editarMensaje(
  chatId: string,
  messageId: number,
  texto: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML',
  opts?: { disableWebPagePreview?: boolean }
): Promise<boolean> {
  try {
    await axios.post(`${getBotURL()}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text: texto,
      parse_mode: parseMode,
      disable_web_page_preview: opts?.disableWebPagePreview ?? true,
    });
    return true;
  } catch (error: any) {
    const desc = String(error?.response?.data?.description ?? error?.message ?? '');
    // Mismo contenido → Telegram lo trata como error; para nosotros es OK.
    if (desc.toLowerCase().includes('message is not modified')) {
      return true;
    }
    logger.warn(`⚠️ editMessageText falló chat=${chatId} msg=${messageId}: ${desc}`);
    return false;
  }
}

/**
 * Elimina un mensaje de Telegram de forma invisible.
 */
export async function eliminarMensaje(chatId: string, messageId: number): Promise<boolean> {
  try {
    await axios.post(`${getBotURL()}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    });
    return true;
  } catch (error) {
    // Es posible que el mensaje ya haya sido eliminado manualmente, lo ignoramos para no ensuciar logs
    return false;
  }
}

/**
 * Envía un mensaje con teclado inline (botones).
 */
export async function enviarMensajeConBotones(
  chatId: string,
  texto: string,
  botones: Array<{ text: string; url: string }>,
  parseMode: 'HTML' | 'Markdown' = 'HTML'
): Promise<boolean> {
  try {
    await axios.post(`${getBotURL()}/sendMessage`, {
      chat_id: chatId,
      text: texto,
      parse_mode: parseMode,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: botones.map((b) => [{ text: b.text, url: b.url }]),
      },
    });
    return true;
  } catch (error) {
    logger.error(`❌ Error enviando mensaje con botones a ${chatId}:`, { error });
    return false;
  }
}


// ------------------------------------------------------------
// Gestión del grupo VIP y Canales Públicos
// ------------------------------------------------------------

/**
 * Obtiene o genera el enlace de invitación permanente (infinito) de un chat.
 * Esto soluciona el problema de usar IDs numéricos para canales gratuitos.
 */
export async function generarEnlacePublicoPermanente(chatId: string): Promise<string | null> {
  if (!chatId) return null;
  try {
    const response = await axios.post<{ result: string }>(
      `${getBotURL()}/exportChatInviteLink`,
      { chat_id: chatId }
    );
    return response.data.result;
  } catch (error) {
    logger.error(`❌ Error obteniendo enlace público para ${chatId}:`, { error });
    return null;
  }
}

/**
 * Genera un enlace de invitación de un solo uso para el grupo VIP.
 * Equivalente al HTTP Request "createChatInviteLink" de n8n.
 */
export async function generarInviteLink(chatId: string): Promise<string | null> {
  if (!chatId) throw new Error('Se requiere un chatId para generar el invite link');

  try {
    // expire_date: Unix timestamp de ahora + 1 hora
    // Junto con member_limit:1, este link se destruye en cuanto es usado
    // o caduca en 60 min — evita la fuga de accesos VIP compartidos.
    const expireDate = Math.floor(Date.now() / 1000) + 3600;

    const response = await axios.post<{ result: { invite_link: string } }>(
      `${getBotURL()}/createChatInviteLink`,
      {
        chat_id: chatId,
        member_limit: 1,           // Solo puede usarlo 1 persona
        expire_date: expireDate,   // Caduca en 1 hora
        creates_join_request: false,
      }
    );

    return response.data.result.invite_link;
  } catch (error) {
    logger.error('❌ Error generando invite link:', { error });
    return null;
  }
}

/**
 * Banea a un usuario del grupo VIP.
 * Se usa cuando se cancela la suscripción.
 * Equivalente al "banChatMember" de Cancela_suscripcion.json
 */
export async function banearUsuario(telegramId: string, chatId: string): Promise<boolean> {
  if (!chatId) throw new Error('Se requiere un chatId para banear');

  try {
    await axios.post(`${getBotURL()}/banChatMember`, {
      chat_id: chatId,
      user_id: telegramId,
    });
    logger.info(`🚫 Usuario ${telegramId} baneado del grupo VIP ${chatId}.`);
    return true;
  } catch (error: any) {
    if (error.response && error.response.status === 400) {
      logger.info(`ℹ️  Usuario ${telegramId} no estaba en el grupo ${chatId} o ya fue baneado.`);
    } else {
      logger.error(`❌ Error baneando usuario ${telegramId}: ${error.message}`);
    }
    return false;
  }
}
