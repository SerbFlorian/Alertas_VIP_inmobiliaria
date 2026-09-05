import type { CheerioAPI } from 'cheerio';
import { BaseScraper } from './base.scraper';
import type { Piso, ScrapingTask } from '../types';

// ============================================================
// RENTOLA SCRAPER (REVISADO)
// ============================================================
// Rentola es un portal de alquiler europeo con presencia en España.
//
// PROBLEMA ANTERIOR: El selector [data-testid="propertyTile"] no
// existe en el HTML actual. Rentola usa Next.js y sus listados
// están embebidos en el script __NEXT_DATA__ como JSON.
//
// SOLUCIÓN: Extraer los datos directamente del JSON de __NEXT_DATA__
// que Next.js inyecta en la página — esto es más robusto que
// parsear el HTML renderizado con clases hash que cambian.
//
// Estructura JSON (__NEXT_DATA__):
//   props.pageProps.initialState.search.results[*] {
//     id, title, price, url, description, city, address
//   }
// ============================================================

export class RentolaScraper extends BaseScraper {
  private static readonly DOMINIO = 'https://rentola.es';

  protected parse(html: string, task: ScrapingTask): Piso[] {
    const $: CheerioAPI = this.loadHTML(html);
    const pisos: Piso[] = [];

    // ── Estrategia 1: Extraer del script __NEXT_DATA__ (más robusto) ──────
    const nextDataScript = $('script#__NEXT_DATA__').html()
      || $('script[type="application/json"]').first().html();

    if (nextDataScript) {
      try {
        const nextData = JSON.parse(nextDataScript);

        // Diferentes rutas posibles según la versión del deploy
        const resultados: Array<Record<string, unknown>> =
          nextData?.props?.pageProps?.initialState?.search?.results ||
          nextData?.props?.pageProps?.results ||
          nextData?.props?.pageProps?.listings ||
          nextData?.props?.pageProps?.properties ||
          [];

        for (const item of resultados) {
          try {
            const titulo = String(item['title'] ?? '').trim();
            if (!titulo || titulo.toLowerCase().includes('rentola')) continue;

            const precioRaw = Number(item['price'] ?? item['rent'] ?? item['monthly_rent'] ?? 0);
            const precio = precioRaw > 0 ? Math.round(precioRaw) : 0;
            if (precio === 0) continue;

            const idRaw = String(item['id'] ?? item['listing_id'] ?? '');
            if (!idRaw) continue;

            const hrefRaw = String(item['url'] ?? item['link'] ?? item['slug'] ?? '');
            const enlace = hrefRaw.startsWith('http')
              ? hrefRaw
              : this.resolverURL(hrefRaw || `/listing/${idRaw}`, RentolaScraper.DOMINIO);

            const descripcion = this.limpiarTexto(String(item['description'] ?? '')) || undefined;
            const ubicacion = this.limpiarTexto(
              String(item['address'] ?? item['neighborhood'] ?? item['city'] ?? '')
            ) || undefined;

            const textoCombinado = `${titulo} ${ubicacion || ''} ${descripcion || ''}`;
            const habitaciones = this.parsearHabitaciones(textoCombinado);
            const tipo = this.parsearTipo(textoCombinado);
            let zona = this.parsearZona(textoCombinado, task.ciudad);
            if (!zona && ubicacion) zona = this.parsearZona(ubicacion, task.ciudad);

            pisos.push({
              id: `rt_${idRaw}`,
              titulo,
              precio,
              enlace,
              portal: 'rentola',
              ciudad: task.ciudad,
              zona,
              habitaciones,
              tipo,
              resumen: descripcion?.slice(0, 120),
            });
          } catch {
            // Ignorar items malformados
          }
        }

        if (pisos.length > 0) return this.deduplicar(pisos);
      } catch {
        // JSON malformado — caer al fallback HTML
      }
    }

    // ── Estrategia 2: Fallback HTML (por si cambió la estructura Next.js) ──
    $('[class*="PropertyCard"], [class*="property-card"], [class*="listing"], article').each((_i, el) => {
      try {
        const linkEl = $(el).find('a[href]').first();
        const href = linkEl.attr('href') ?? '';
        if (!href || href === '#') return;

        const enlace = this.resolverURL(href, RentolaScraper.DOMINIO);

        const titulo = this.limpiarTexto(
          $(el).find('h2, h3, [class*="title"]').first().text()
        );
        if (!titulo || titulo.toLowerCase().includes('rentola')) return;

        const precioTexto = $(el).find('[class*="price"], [class*="rent"]').first().text();
        const precio = this.parsearPrecio(precioTexto);
        if (precio === 0) return;

        const idMatch = href.match(/listing\/([a-zA-Z0-9-]+)/);
        const id = idMatch ? `rt_${idMatch[1]}` : `rt_${this.hashURL(enlace)}`;

        const ubicacion = this.limpiarTexto(
          $(el).find('[class*="location"], [class*="address"]').first().text()
        ) || undefined;

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
          portal: 'rentola',
          ciudad: task.ciudad,
          zona,
          habitaciones,
          tipo
        });
      } catch {
        // Ignorar
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
