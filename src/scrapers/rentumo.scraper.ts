import type { CheerioAPI } from 'cheerio';
import { BaseScraper } from './base.scraper';
import type { Piso, ScrapingTask } from '../types';
import { recuperarMacroDesdeCodigoPostal } from '../utils/codigos-postales';

// ============================================================
// RENTUMO SCRAPER
// ============================================================
// Estructura HTML:
//   <div class="listing-item ..." data-listing-id="12345">
//     <a href="/anuncios/...">
//     <p class="font-normal">Dirección del piso</p>
//     <span class="text-2xl">€ 950</span>
//     <ul class="flex items-center ...">Detalles</ul>
//   </div>
//
// Filtro anti-spam:
//   - Debe tener data-listing-id y href válido
//   - Precio > 0
//
// Zona: Rentumo casi nunca publica barrio — solo calle + CP.
//   1) parsearZona (diccionario) si hay barrio en texto
//   2) CP → macro (codigos-postales.json)
//   3) si no → zona undefined (NUNCA guardar la calle)
// ============================================================

export class RentumoScraper extends BaseScraper {
  private static readonly DOMINIO = 'https://rentumo.es';

  protected parse(html: string, task: ScrapingTask): Piso[] {
    const $: CheerioAPI = this.loadHTML(html);
    const pisos: Piso[] = [];

    $('.listing-item').each((_i, el) => {
      try {
        // 1. ID del listing
        const id = $(el).attr('data-listing-id') ?? '';
        if (!id) return;

        // 2. URL
        const href = $(el).find('a[href*="/anuncios/"]').first().attr('href') ?? '';
        if (!href) return;
        const enlace = this.resolverURL(href, RentumoScraper.DOMINIO);

        // 3. Título real (se puede extraer del title de la imagen o del href)
        let tituloStr = $(el).find('img').first().attr('title') || '';
        tituloStr = tituloStr.replace(/\s*-\s*Foto.*$/i, '').trim();
        const titulo = tituloStr || `Inmueble en ${task.ciudad}`;

        // 4. Precio (€ está antes del número)
        const precioTexto = $(el).find('[class*="text-2xl"]').first().text();
        const precio = this.parsearPrecio(precioTexto);

        // ---- FILTRO ANTI-SPAM ----
        if (precio === 0) return;

        // 5. Detalles (habitaciones, m², etc.) + Descripción / Ubicación
        const detalles = this.limpiarTexto($(el).find('ul').first().text());
        const address = this.limpiarTexto($(el).find('#address').text());
        const descripcion = this.limpiarTexto($(el).find('p.font-normal, [class*="font-normal"]').first().text());

        const ubicacion = address || descripcion || undefined;

        // 6. Extraer toda la info de la tarjeta para parseo inteligente sin descartar nada
        const cardText = this.limpiarTexto($(el).text());
        const textoCombinado = `${titulo} ${ubicacion || ''} ${detalles || ''} ${cardText}`;

        const habitaciones = this.parsearHabitaciones(textoCombinado);
        const tipo = this.parsearTipo(textoCombinado);

        // Zona: barrio en texto → CP → undefined (nunca calle)
        let zona = this.parsearZona(textoCombinado, task.ciudad);
        if (!zona && address) zona = this.parsearZona(address, task.ciudad);
        if (!zona) {
          zona = recuperarMacroDesdeCodigoPostal(
            task.ciudad,
            address,
            titulo,
            enlace,
            descripcion,
            cardText
          );
        }

        const resumenFinal = [detalles, descripcion].filter(Boolean).join(' | ');

        pisos.push({
          id,
          titulo,
          precio,
          enlace,
          portal: 'rentumo',
          ciudad: task.ciudad,
          zona,
          habitaciones,
          tipo,
          resumen: (resumenFinal || undefined)?.slice(0, 120),
        });
      } catch {
        // Ignorar elementos que no se puedan parsear
      }
    });

    return this.deduplicar(pisos);
  }

  protected override parseDetalle(html: string, piso: Piso): void {
    super.parseDetalle(html, piso);
    if (piso.zona) return;

    const $ = this.loadHTML(html);
    const address = this.limpiarTexto($('#address').text());
    const bodyText = this.limpiarTexto($('body').text()).slice(0, 2000);
    piso.zona = recuperarMacroDesdeCodigoPostal(
      piso.ciudad,
      address,
      piso.titulo,
      piso.enlace,
      bodyText
    );
  }
}
