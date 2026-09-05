import type { CheerioAPI } from 'cheerio';
import { BaseScraper } from './base.scraper';
import type { Piso, ScrapingTask } from '../types';

// ============================================================
// SPOTAHOME SCRAPER
// ============================================================
// Estructura HTML:
//   <li class="l-list__item">
//     <div data-homecard-scroll="12345678">
//     <a href="/rooms/12345678-...">
//     <span class="_homecard-content__title_...">Título</span>
//     <span class="_price__amount_...">950</span> €
//   </li>
//
// NOTA: Las clases de Spotahome tienen sufijos hash (ej: _13q19_202)
//       que pueden cambiar entre deployments. Usamos selectores
//       que buscan por prefijo de clase con [class*="..."]
//
// Filtro anti-spam:
//   - Debe tener data-homecard-scroll (ID real del portal)
//   - Precio > 0
// ============================================================

export class SpotahomeScraper extends BaseScraper {
  private static readonly DOMINIO = 'https://www.spotahome.com';

  protected parse(html: string, task: ScrapingTask): Piso[] {
    const $: CheerioAPI = this.loadHTML(html);
    const pisos: Piso[] = [];

    $('li.l-list__item').each((_i, el) => {
      try {
        // 1. ID del inmueble (atributo data-homecard-scroll)
        const id = $(el).find('[data-homecard-scroll]').attr('data-homecard-scroll') ?? '';
        if (!id) return;

        // 2. URL
        const href = $(el).find('a[href]').first().attr('href') ?? '';
        if (!href) return;
        const enlace = this.resolverURL(href, SpotahomeScraper.DOMINIO);

        // 3. Título (clase con prefijo _homecard-content__title_)
        const titulo = this.limpiarTexto(
          $(el).find('[class*="_homecard-content__title_"]').first().text()
          || $(el).find('[class*="homecard-title"]').first().text()
          || $(el).find('[class*="card-title"]').first().text()
        );

        // 4. Precio (clase con prefijo _price__amount_)
        const precioTexto = $(el).find('[class*="_price__amount_"]').first().text()
          || $(el).find('[class*="price-amount"]').first().text()
          || $(el).find('[class*="price__amount"]').first().text();
        const precio = this.parsearPrecio(precioTexto);

        // ---- FILTRO ANTI-SPAM ----
        if (precio === 0) return;

        pisos.push({
          id,
          titulo: titulo || `Habitación/Piso en ${task.ciudad}`,
          precio,
          enlace,
          portal: 'spotahome',
          ciudad: task.ciudad,
        });
      } catch {
        // Ignorar elementos que no se puedan parsear
      }
    });

    return this.deduplicar(pisos);
  }
}
