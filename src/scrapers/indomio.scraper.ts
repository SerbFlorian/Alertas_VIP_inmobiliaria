import type { CheerioAPI } from 'cheerio';
import { BaseScraper } from './base.scraper';
import type { Piso, ScrapingTask } from '../types';

// ============================================================
// INDOMIO SCRAPER
// ============================================================
// Estructura HTML:
//   <div class="nd-list__item" id="12345">
//     <a href="/alquiler-casas/..." title="Piso en...">
//     <span class="Price_price__kHY5L"><span>950 €</span></span>
//   </div>
//
// Filtro anti-spam:
//   - URL NO debe contener '/agencia/' (perfiles de inmobiliaria)
//   - Debe tener enlace y precio
// ============================================================

export class IndominioScraper extends BaseScraper {
  private static readonly DOMINIO = 'https://www.indomio.es';

  protected parse(html: string, task: ScrapingTask): Piso[] {
    const $: CheerioAPI = this.loadHTML(html);
    const pisos: Piso[] = [];

    $('.nd-list__item').each((_i, el) => {
      try {
        // 1. ID del elemento (atributo id del div)
        const id = $(el).attr('id') ?? '';

        // 2. Enlace y título (del primer <a> con href y title)
        const linkEl = $(el).find('a[href][title]').first();
        const href = linkEl.attr('href') ?? '';
        const titulo = this.limpiarTexto(linkEl.attr('title') ?? linkEl.text());

        // ---- FILTRO ANTI-SPAM ----
        // Excluir perfiles de agencias inmobiliarias
        if (!href || href.includes('/agencia/')) return;

        const enlace = this.resolverURL(href, IndominioScraper.DOMINIO);

        // 3. Precio (selector de clase ofuscada de Indomio)
        // Intentamos varios selectores por si cambian las clases
        const precioTexto = $(el).find('[class*="price"] span').first().text()
          || $(el).find('[class*="Price"] span').first().text();
        const precio = this.parsearPrecio(precioTexto);

        // Descartamos precio 0 (tarjetas sin precio real)
        if (precio === 0) return;

        // ID fallback: extraer de la URL
        const idFinal = id || this.extraerIdDeURL(href);

        // Extraer toda la info de la tarjeta para parseo inteligente sin descartar nada
        const cardText = this.limpiarTexto($(el).text());
        const textoCombinado = `${titulo} ${cardText}`;

        const habitaciones = this.parsearHabitaciones(textoCombinado);
        const tipo = this.parsearTipo(textoCombinado);
        
        let zona = this.parsearZona(textoCombinado, task.ciudad);

        pisos.push({
          id: idFinal || `indomio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          titulo: titulo || `Inmueble en ${task.ciudad}`,
          precio,
          enlace,
          portal: 'indomio',
          ciudad: task.ciudad,
          habitaciones,
          tipo,
          zona
        });
      } catch {
        // Ignorar elementos que no se puedan parsear
      }
    });

    return this.deduplicar(pisos);
  }

  private extraerIdDeURL(href: string): string {
    // URLs de Indomio suelen terminar en /123456/ o similar
    const match = href.match(/\/(\d+)\/?$/);
    return match ? match[1] : '';
  }
}
