import type { CheerioAPI } from 'cheerio';
import { BaseScraper } from './base.scraper';
import type { Piso, ScrapingTask } from '../types';

// ============================================================
// NUROA SCRAPER
// ============================================================
// Nuroa es el mayor agregador inmobiliario de España e Italia.
// Indexa anuncios de Idealista, Pisos.com, Habitaclia y decenas
// de portales menores — incluyendo inmobiliarias pequeñas que
// no tienen presupuesto para los portales premium.
//
// VENTAJA: Captura pisos de agencias pequeñas y portales locales
// que no están en Idealista ni Fotocasa. Alta probabilidad de
// encontrar anuncios con precio subvalorado.
//
// URL: https://www.nuroa.es/alquiler-de-apartamentos/barcelona/
//      ?precio_max=1000&orden=fecha
//
// Estructura HTML (portal clásico SSR):
//   <li class="listing-card">
//     <a href="/detalle/pisos/barcelona/...">
//       <h2 class="listing-title">Piso en alquiler...</h2>
//       <span class="listing-price">800 €/mes</span>
//       <p class="listing-location">Eixample, Barcelona</p>
//     </a>
//   </li>
// ============================================================

export class NuroaScraper extends BaseScraper {
  private static readonly DOMINIO = 'https://www.nuroa.es';

  protected parse(html: string, task: ScrapingTask): Piso[] {
    const $: CheerioAPI = this.loadHTML(html);
    const pisos: Piso[] = [];

    // Nuroa usa un formato clásico de lista con li o article
    $('li.listing-card, article.listing-card, div.listing-card, [class*="property-card"], [class*="result-item"]').each((_i, el) => {
      try {
        // 1. Enlace principal
        const linkEl = $(el).find('a').first();
        const href = linkEl.attr('href') ?? '';
        if (!href) return;

        const enlace = this.resolverURL(href, NuroaScraper.DOMINIO);

        // 2. Título
        const titulo = this.limpiarTexto(
          $(el).find('h2, h3, [class*="title"]').first().text()
          || linkEl.attr('title') || ''
        );
        if (!titulo || titulo.length < 5) return;

        // 3. Precio
        const precioTexto = $(el).find(
          '[class*="price"], [class*="Price"], span[itemprop="price"]'
        ).first().text();
        const precio = this.parsearPrecio(precioTexto);
        if (precio === 0) return;

        // 4. ID desde la URL
        const idMatch = href.match(/(\d{4,})/);
        const id = idMatch ? `nr_${idMatch[1]}` : `nr_${this.hashURL(enlace)}`;

        // 5. Descripción y ubicación
        const descripcion = this.limpiarTexto(
          $(el).find('[class*="description"], [class*="summary"]').text()
        ) || undefined;

        const ubicacion = this.limpiarTexto(
          $(el).find('[class*="location"], [class*="address"], [class*="zone"]').first().text()
        ) || undefined;

        // 6. Extraer toda la info de la tarjeta para parseo inteligente sin descartar nada
        const cardText = this.limpiarTexto($(el).text());
        const textoCombinado = `${titulo} ${ubicacion || ''} ${descripcion || ''} ${cardText}`;

        const habitaciones = this.parsearHabitaciones(textoCombinado);
        const tipo = this.parsearTipo(textoCombinado);
        
        let zona = this.parsearZona(textoCombinado, task.ciudad);
        if (!zona && ubicacion) zona = this.parsearZona(ubicacion, task.ciudad);

        pisos.push({
          id,
          titulo,
          precio,
          enlace,
          portal: 'nuroa',
          ciudad: task.ciudad,
          zona,
          habitaciones,
          tipo,
          resumen: descripcion?.slice(0, 120),
        });
      } catch {
        // Ignorar elementos malformados
      }
    });

    return this.deduplicar(pisos);
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
