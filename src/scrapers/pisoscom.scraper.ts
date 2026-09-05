import type { CheerioAPI } from 'cheerio';
import { BaseScraper } from './base.scraper';
import type { Piso, ScrapingTask } from '../types';

// ============================================================
// PISOS.COM SCRAPER
// ============================================================
// Estructura HTML:
//   <div class="ad-preview ..." data-lnk-href="/alquilar/...">
//     <h3 class="ad-preview__title">Piso en...</h3>
//     <span class="ad-preview__price">950 €</span>
//     <p class="p-sm ad-preview__subtitle">Eixample, Barcelona</p>
//   </div>
//
// Filtro anti-spam:
//   - URL debe contener '-6' (patrón de pisos de alquiler en pisos.com)
//   - Debe tener título y precio
//   - Precio > 0
// ============================================================

export class PisoscomScraper extends BaseScraper {
  private static readonly DOMINIO = 'https://www.pisos.com';

  protected parse(html: string, task: ScrapingTask): Piso[] {
    const $: CheerioAPI = this.loadHTML(html);
    const pisos: Piso[] = [];

    // Pisos.com usa .ad-preview como selector principal
    $('.ad-preview').each((_i, el) => {
      try {
        // 1. URL del anuncio (está en data-lnk-href)
        const href = $(el).attr('data-lnk-href') ?? '';

        // ---- FILTRO ANTI-SPAM ----
        // Los anuncios reales de alquiler en pisos.com contienen '-6' en la URL
        if (!href || !href.includes('-6')) return;

        const enlace = this.resolverURL(href, PisoscomScraper.DOMINIO);

        // 2. Título
        const titulo = this.limpiarTexto($(el).find('.ad-preview__title').first().text());
        if (!titulo) return;

        // 3. Precio
        const precioTexto = $(el).find('.ad-preview__price').first().text();
        const precio = this.parsearPrecio(precioTexto);
        if (precio === 0) return;

        // 4. ID: extraer del patrón numérico en la URL (ej: 123456_789)
        const idMatch = href.match(/(\d+_\d+)/);
        const id = idMatch ? idMatch[1] : this.extraerIdFallback(href);

        // 5. Ubicación
        const ubicacion = this.limpiarTexto(
          $(el).find('.ad-preview__subtitle').first().text()
        ) || undefined;
        
        // 6. Extraer toda la info de la tarjeta para parseo inteligente sin descartar nada
        const cardText = this.limpiarTexto($(el).text());
        const textoCombinado = `${titulo} ${ubicacion || ''} ${cardText}`;

        const habitaciones = this.parsearHabitaciones(textoCombinado);
        const tipo = this.parsearTipo(textoCombinado);
        
        let zona = this.parsearZona(textoCombinado, task.ciudad);
        if (!zona && ubicacion) zona = this.parsearZona(ubicacion, task.ciudad);

        pisos.push({
          id,
          titulo,
          precio,
          enlace,
          portal: 'pisoscom',
          ciudad: task.ciudad,
          zona,
          habitaciones,
          tipo
        });
      } catch {
        // Ignorar elementos que no se puedan parsear
      }
    });

    return this.deduplicar(pisos);
  }

  private extraerIdFallback(href: string): string {
    // Extraer cualquier secuencia numérica larga de la URL
    const match = href.match(/(\d{5,})/);
    return match ? match[1] : Math.random().toString(36).slice(2, 11);
  }
}
