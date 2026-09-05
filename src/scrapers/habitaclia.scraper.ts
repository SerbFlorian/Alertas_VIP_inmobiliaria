import type { CheerioAPI } from 'cheerio';
import { BaseScraper } from './base.scraper';
import type { Piso, ScrapingTask } from '../types';

// ============================================================
// HABITACLIA SCRAPER
// ============================================================
// Estructura HTML:
//   <article class="js-list-item ..." data-id="12345678">
//     <h3 class="list-item-title"><a href="/...">Título</a></h3>
//     <span class="list-item-price">
//       <span itemprop="price">950</span>
//     </span>
//     <span class="list-item-location"><span>Eixample</span></span>
//   </article>
//
// Filtro anti-spam:
//   - Debe tener data-id (ID real del portal)
//   - Precio > 0 (descarta tarjetas de agencia sin precio)
// ============================================================

export class HabitacliaScraper extends BaseScraper {
  protected parse(html: string, task: ScrapingTask): Piso[] {
    const $: CheerioAPI = this.loadHTML(html);
    const pisos: Piso[] = [];

    $('article.js-list-item').each((_i, el) => {
      try {
        // 1. ID del inmueble (atributo data-id)
        const id = $(el).attr('data-id') ?? '';
        if (!id) return; // Sin ID = tarjeta basura

        // 2. URL (de data-href o del link interno)
        const href = $(el).attr('data-href')
          ?? $(el).find('.list-item-title a').attr('href')
          ?? '';
        if (!href) return;

        const enlace = href.startsWith('http')
          ? href
          : `https://www.habitaclia.com${href}`;

        // 3. Título
        const titulo = this.limpiarTexto(
          $(el).find('.list-item-title a').first().text()
        );

        // 4. Precio (itemprop=price es el selector más confiable)
        const precioAttr = $(el).find('[itemprop="price"]').attr('content')
          ?? $(el).find('[itemprop="price"]').text();
        const precio = this.parsearPrecio(precioAttr);

        // ---- FILTRO ANTI-SPAM ----
        // Descartamos si precio es 0 (tarjetas sin precio real)
        if (precio === 0) return;

        // 5. Ubicación y textos
        const locationSpanInfo = this.limpiarTexto($(el).find('.list-item-location span').first().text());
        const locationInfo = this.limpiarTexto($(el).find('.list-item-location').text());
        const ubicacion = locationSpanInfo || locationInfo || undefined;

        // 6. Extraer toda la info de la tarjeta para parseo inteligente sin descartar nada
        const cardText = this.limpiarTexto($(el).text());
        const tituloSeguro = titulo || `Inmueble en ${task.ciudad}`;
        const textoCombinado = `${tituloSeguro} ${locationSpanInfo} ${locationInfo} ${cardText}`;

        const habitaciones = this.parsearHabitaciones(textoCombinado);
        const tipo = this.parsearTipo(textoCombinado);
        
        let zona = this.parsearZona(textoCombinado, task.ciudad);
        if (!zona && ubicacion) zona = this.parsearZona(ubicacion, task.ciudad);

        pisos.push({
          id,
          titulo: tituloSeguro,
          precio,
          enlace,
          portal: 'habitaclia',
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

    // Habitaclia puede cambiar ligeramente el HTML según el tipo de anuncio (agencia vs particular)
    let descripcion = '';
    
    // 1. Buscamos todas las posibles cajas de descripción
    const descNodes = $('#js-detail-description, .detail-description, #js-translate p');
    
    // 2. Extraemos el texto de la que tenga más contenido (evita atrapar divs vacíos ocultos)
    descNodes.each((_i, el) => {
      const txt = this.limpiarTexto($(el).text());
      if (txt.length > descripcion.length) {
        descripcion = txt;
      }
    });

    if (descripcion && descripcion.length > 20 && !piso.resumen) {
      piso.resumen = descripcion.slice(0, 120);
    }

    // Ubicación detallada en el anuncio interior (suele estar en los breadcrumbs o location-map)
    const infoGeneral = this.limpiarTexto($('.detail-features, .location, .location-info').text());
    const textoCombinado = `${piso.titulo} ${descripcion} ${infoGeneral}`;

    if (!piso.zona) piso.zona = this.parsearZona(textoCombinado, piso.ciudad);
    if (piso.habitaciones === undefined) piso.habitaciones = this.parsearHabitaciones(textoCombinado);
    if (!piso.tipo) piso.tipo = this.parsearTipo(textoCombinado);
  }
}
