import type { CheerioAPI } from 'cheerio';
import { BaseScraper } from './base.scraper';
import type { Piso, ScrapingTask } from '../types';

// ============================================================
// UNIPLACES SCRAPER
// ============================================================
// Uniplaces usa microdata Schema.org (itemprop) en su HTML,
// lo que lo hace uno de los más fiables:
//
//   <li itemprop="itemListElement">
//     <link itemprop="url" content="https://..."/>
//     <meta itemprop="name" content="Piso en..."/>
//     <meta itemprop="price" content="950"/>
//     <meta itemprop="areaServed" content="Eixample"/>
//     <div data-element-id="12345678">
//   </li>
//
// NOTA: Los precios en Uniplaces están en centavos de Euro (x100)
//       Ej: budget-max=100000 → 1000€
// ============================================================

export class UniplacesScraper extends BaseScraper {
  protected parse(html: string, task: ScrapingTask): Piso[] {
    const $: CheerioAPI = this.loadHTML(html);
    const pisos: Piso[] = [];

    $('[itemprop="itemListElement"]').each((_i, el) => {
      try {
        // 1. URL (itemprop=url, atributo content o href)
        const enlace = $(el).find('[itemprop="url"]').attr('content')
          ?? $(el).find('[itemprop="url"]').attr('href')
          ?? '';
        if (!enlace) return;

        // 2. ID real del portal (data-element-id)
        const id = $(el).find('[data-element-id]').attr('data-element-id') ?? '';
        if (!id) return; // Sin ID = tarjeta inválida

        // 3. Título
        const titulo = this.limpiarTexto(
          $(el).find('[itemprop="name"]').attr('content')
          ?? $(el).find('[itemprop="name"]').text()
        );

        // 4. Precio
        // IMPORTANTE: Uniplaces usa centavos → dividir por 100
        const precioRaw = $(el).find('[itemprop="price"]').attr('content')
          ?? $(el).find('[itemprop="price"]').text()
          ?? '0';
        const precioCentavos = parseInt(precioRaw.replace(/\D/g, ''), 10);
        const precio = isNaN(precioCentavos) ? 0 : Math.round(precioCentavos / 100);

        // ---- FILTRO ANTI-SPAM ----
        if (precio === 0) return;

        // 5. Ubicación
        const ubicacion = this.limpiarTexto(
          $(el).find('[itemprop="areaServed"]').attr('content')
          ?? $(el).find('[itemprop="areaServed"]').text()
        ) || undefined;

        // 6. Extraer toda la info de la tarjeta para parseo inteligente sin descartar nada
        const cardText = this.limpiarTexto($(el).text());
        const tituloSeguro = titulo || `Alojamiento en ${task.ciudad}`;
        const textoCombinado = `${tituloSeguro} ${ubicacion || ''} ${cardText}`;

        const habitaciones = this.parsearHabitaciones(textoCombinado);
        const tipo = this.parsearTipo(textoCombinado);
        
        let zona = this.parsearZona(textoCombinado, task.ciudad);
        if (!zona && ubicacion) zona = this.parsearZona(ubicacion, task.ciudad);

        pisos.push({
          id,
          titulo: tituloSeguro,
          precio,
          enlace,
          portal: 'uniplaces',
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
}
