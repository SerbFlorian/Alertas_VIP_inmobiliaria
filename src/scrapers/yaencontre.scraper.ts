import type { CheerioAPI } from 'cheerio';
import { BaseScraper } from './base.scraper';
import type { Piso, ScrapingTask } from '../types';

// ============================================================
// YAENCONTRE SCRAPER
// ============================================================
// Estructura HTML:
//   <article class="real-estate-card ...">
//     <div class="title-wrapper">
//       <a href="/alquiler/piso/inmueble-123-456">Título</a>
//     </div>
//     <div class="price-wrapper">...<p>950</p></div>
//     <p class="media-info">Barrio</p>
//   </article>
//
// Filtro anti-spam:
//   - URL debe contener '/alquiler/piso/inmueble-'
//   - Excluir anuncios con texto "Encuentra tu vivienda con tranquilidad"
//   - Precio > 0
// ============================================================

export class YaencontreScraper extends BaseScraper {
  private static readonly DOMINIO = 'https://www.yaencontre.com';

  protected parse(html: string, task: ScrapingTask): Piso[] {
    const $: CheerioAPI = this.loadHTML(html);
    const pisos: Piso[] = [];

    $('article').each((_i, el) => {
      try {
        // ---- FILTRO ANTI-SPAM ----
        // Excluimos anuncios de servicios (certificados energéticos, etc.)
        const textoCard = $(el).text();
        if (textoCard.includes('Encuentra tu vivienda con tranquilidad')) return;

        // 1. URL del anuncio
        const href = $(el).find('.title-wrapper a').attr('href') ?? '';

        // Solo URLs de inmuebles reales
        if (!href.includes('/inmueble-')) return;

        const enlace = this.resolverURL(href, YaencontreScraper.DOMINIO);

        // 2. Título
        const titulo = this.limpiarTexto(
          $(el).find('.title-wrapper a').first().text()
        );
        if (!titulo) return;

        // 3. Precio
        const precioTexto = $(el).find('.price-wrapper p').first().text()
          || $(el).find('[class*="price"]').first().text();
        const precio = this.parsearPrecio(precioTexto);
        if (precio === 0) return;

        // 4. ID extraído de la URL (patrón: inmueble-123-456)
        const idMatch = href.match(/inmueble-(\d+-\d+)/);
        const id = idMatch ? idMatch[1] : this.hashURL(enlace);

        // 5. Ubicación y textos
        const mediaInfo = this.limpiarTexto($(el).find('.media-info p').first().text());
        const subtitleInfo = this.limpiarTexto($(el).find('.subtitle').text());
        const locationInfo = this.limpiarTexto($(el).find('.location').text());
        const ubicacion = mediaInfo || subtitleInfo || locationInfo || undefined;

        // 6. Extraer toda la info de la tarjeta para parseo inteligente sin descartar nada
        const cardText = this.limpiarTexto($(el).text());
        const textoCombinado = `${titulo} ${mediaInfo} ${subtitleInfo} ${locationInfo} ${cardText}`;

        const habitaciones = this.parsearHabitaciones(textoCombinado);
        const tipo = this.parsearTipo(textoCombinado);
        
        let zona = this.parsearZona(textoCombinado, task.ciudad);
        if (!zona && ubicacion) zona = this.parsearZona(ubicacion, task.ciudad);

        pisos.push({
          id,
          titulo,
          precio,
          enlace,
          portal: 'yaencontre',
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

  // --- DEEP SCRAPING ---
  protected override parseDetalle(html: string, piso: Piso): void {
    const $ = this.loadHTML(html);
    const descripcion = this.limpiarTexto($('#details-description .readMoreText, .description-text, [class*="description"]').text());
    if (descripcion && descripcion.length > 20 && !piso.resumen) {
      piso.resumen = descripcion.slice(0, 120);
    }

    // Ubicación específica de Yaencontre reportada por el usuario (puede estar en un <p>, en un <h4> o en .details-address)
    const zonaUbicacion = this.limpiarTexto($('.details-address p, .details-location h4, p.body-text-s.c-content-primary, .details-location').first().text());

    const infoGeneral = this.limpiarTexto($('[class*="details"], [class*="features"], [class*="characteristics"], #details-description').text());
    
    const textoCombinado = `${piso.titulo} ${zonaUbicacion} ${descripcion} ${infoGeneral}`;
    
    if (!piso.zona) piso.zona = this.parsearZona(textoCombinado, piso.ciudad);
    if (piso.habitaciones === undefined) piso.habitaciones = this.parsearHabitaciones(textoCombinado);
    if (!piso.tipo) piso.tipo = this.parsearTipo(textoCombinado);
  }

  private hashURL(url: string): string {
    let hash = 0;
    for (const char of url) {
      hash = ((hash << 5) - hash) + char.charCodeAt(0);
      hash |= 0;
    }
    return Math.abs(hash).toString();
  }
}
