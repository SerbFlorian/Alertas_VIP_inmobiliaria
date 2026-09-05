import axios from 'axios';
import { getPisosPublicadosRecientes, getPisosPublicados, eliminarPiso } from '../db/queries';
import { eliminarMensaje } from '../services/telegram.service';
import { logger } from '../services/logger';

// ============================================================
// AVAILABILITY JOB — Limpieza activa de anuncios muertos
// ============================================================

// Constantes de las frases que indican que un piso ya no existe
const PHRASES_DEAD_LISTING = [
  'ha sido desactivado',
  'ya no está publicado',
  'dio de baja el',
  'inmueble no disponible',
  'vendido, alquilado o retirado',
  'no se ha encontrado' // comodín por si acaso
];

export async function checkIfPisoIsDead(enlace: string): Promise<boolean> {
  let response;
  let html = '';

  // Intento único: Petición directa normal (0% coste, sin usar BrightData/proxy de pago)
  try {
    response = await axios.get(enlace, {
      timeout: 8000,
      validateStatus: () => true, // Aceptamos cualquier código de respuesta HTTP
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      }
    });
    html = String(response.data).toLowerCase();
  } catch (e) {
    // Si hay timeout o error de conexión, asumimos que no está muerto por precaución
    return false;
  }

  // Si nos bloquea un WAF (403) o detecta Cloudflare/DataDome/Captcha, simplemente omitimos la comprobación
  // y lo conservamos en la BD para evitar falsos positivos (y evitar gastar créditos de BrightData)
  if (
    response.status === 403 || 
    html.includes('datadome') || 
    html.includes('cloudflare') || 
    html.includes('captcha') || 
    html.includes('access denied')
  ) {
    return false;
  }

  // Comprobación de error 404 o 410 (anuncio borrado del servidor)
  if (response?.status === 404 || response?.status === 410) {
    return true;
  }
  
  // Buscar frases clave en el HTML
  for (const phrase of PHRASES_DEAD_LISTING) {
    if (html.includes(phrase.toLowerCase())) {
      return true;
    }
  }

  return false;
}

export async function ejecutarAvailabilityJob(forceAll: boolean = false): Promise<void> {
  logger.info('-'.repeat(50));
  logger.info(`🧹 INICIO DEL CICLO DE LIMPIEZA DE ANUNCIOS CAÍDOS ${forceAll ? '(TODOS)' : '(Últimas 48h)'}`);
  logger.info('-'.repeat(50));

  const pisos = forceAll 
    ? await getPisosPublicados() 
    : await getPisosPublicadosRecientes(48);
  
  if (pisos.length === 0) {
    logger.info('ℹ️  No hay pisos publicados que comprobar.');
    return;
  }

  logger.info(`🔍 Comprobando disponibilidad de ${pisos.length} anuncios...`);

  let eliminados = 0;

  for (const piso of pisos) {
    try {
      const isDead = await checkIfPisoIsDead(piso.enlace);

      if (isDead) {
        logger.info(`🗑️ Anuncio caído detectado: ${piso.enlace} (Piso ID: ${piso.id})`);
        
        // 1. Borrar de Telegram
        if (piso.telegram_chat_id && piso.telegram_message_id) {
          const borradoOk = await eliminarMensaje(piso.telegram_chat_id, piso.telegram_message_id);
          if (borradoOk) {
            logger.info(`   💬 Mensaje borrado del chat ${piso.telegram_chat_id}`);
          }
        }

        // 2. Borrar de la Base de Datos
        await eliminarPiso(piso.id, piso.portal);
        logger.info(`   🗄️ Registro borrado de la BD`);
        
        eliminados++;
      }
      
      // Pequeña pausa para no saturar los portales ni ser baneado
      await new Promise(r => setTimeout(r, 1000));

    } catch (error: any) {
      logger.warn(`⚠️ Error comprobando disponibilidad de ${piso.enlace}: ${error.message}`);
    }
  }

  logger.info('-'.repeat(50));
  logger.info('✅ CICLO DE LIMPIEZA COMPLETADO');
  logger.info(`   Anuncios verificados: ${pisos.length}`);
  logger.info(`   Anuncios caídos eliminados: ${eliminados}`);
  logger.info('-'.repeat(50));
}

if (require.main === module) {
  import('dotenv/config').then(() => {
    ejecutarAvailabilityJob().catch(console.error);
  });
}
