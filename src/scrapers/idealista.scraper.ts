import type { CheerioAPI } from 'cheerio';
import { BaseScraper } from './base.scraper';
import type { Piso, ScrapingTask } from '../types';

// ============================================================
// IDEALISTA SCRAPER
// ============================================================
// Estructura HTML:
//   <article class="item ...">
//     <a class="item-link" href="/inmueble/12345678/" title="Piso en...">
//     <span class="item-price">950€</span>
//   </article>
//
// Filtro anti-spam:
//   - Solo URLs que contengan '/inmueble/'
//   - Excluir URLs con '/pro/' (perfiles de agencia)
//   - Precio > 0
// ============================================================

export class IdealistaScraper extends BaseScraper {
  private static readonly DOMINIO = 'https://www.idealista.com';

  protected parse(html: string, task: ScrapingTask): Piso[] {
    const $: CheerioAPI = this.loadHTML(html);
    const pisos: Piso[] = [];

    $('article.item').each((_i, el) => {
      try {
        // 1. ID del inmueble
        const idAttr = $(el).attr('data-element-id') ?? '';

        // 2. Enlace y título
        const linkEl = $(el).find('a.item-link').first();
        const href = linkEl.attr('href') ?? '';
        const titulo = this.limpiarTexto(linkEl.attr('title') ?? linkEl.text());

        // ---- FILTRO ANTI-SPAM ----
        // Solo procesamos enlaces a inmuebles reales
        if (!href.includes('/inmueble/') || href.includes('/pro/')) return;

        const enlace = this.resolverURL(href, IdealistaScraper.DOMINIO);

        // 3. Precio
        const precioTexto = $(el).find('.item-price').first().text();
        const precio = this.parsearPrecio(precioTexto);

        // Descartar precio 0
        if (precio === 0) return;

        // 4. ID: preferimos data-element-id, sino extraemos de la URL
        const id = idAttr || this.extraerIdDeURL(href) || this.hashURL(enlace);

        // 5. Detalles (habitaciones, m2, etc.) en lugar de ubicación
        const detalles = this.limpiarTexto(
          $(el).find('.item-detail-char').text()
        ) || undefined;

        // Extraer toda la info de la tarjeta para parseo inteligente
        const cardText = this.limpiarTexto($(el).text());
        const descText = this.limpiarTexto($(el).find('.item-description').text());
        const textoCombinado = `${titulo} ${detalles} ${descText} ${cardText}`;

        // Extraer Habitaciones y Tipo usando las nuevas utilidades
        const habitaciones = this.parsearHabitaciones(textoCombinado);
        const tipo = this.parsearTipo(textoCombinado);

        // Extraer Zona (solo macros de la ciudad del task)
        let zona = this.parsearZona(textoCombinado, task.ciudad);
        if (!zona && titulo) {
           const matchZona = titulo.match(/ en (.+?)(?:, |$)/i);
           if (matchZona) zona = this.parsearZona(matchZona[1], task.ciudad);
        }

        // 6. Descripción corta
        const descripcion = this.limpiarTexto(
          $(el).find('.item-description').text()
        ) || undefined;

        pisos.push({
          id,
          titulo,
          precio,
          enlace,
          portal: 'idealista',
          ciudad: task.ciudad,
          zona,
          habitaciones,
          tipo,
          resumen: (detalles ?? descripcion)?.slice(0, 120), // Detalles cortos o descripción como resumen
        });
      } catch {
        // Ignorar elementos que no se puedan parsear
      }
    });

    return this.deduplicar(pisos);
  }

  private extraerIdDeURL(href: string): string {
    const match = href.match(/\/inmueble\/(\d+)\//);
    return match ? match[1] : '';
  }

  /** Hash simple de URL como fallback de ID */
  private hashURL(url: string): string {
    let hash = 0;
    for (const char of url) {
      hash = ((hash << 5) - hash) + char.charCodeAt(0);
      hash |= 0; // Convertir a 32bit int
    }
    return Math.abs(hash).toString();
  }
}
