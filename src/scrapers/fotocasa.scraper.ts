import { BaseScraper } from './base.scraper';
import type { Piso, ScrapingTask, ScraperOptions } from '../types';

// ============================================================
// FOTOCASA SCRAPER — JSON embed strategy
// ============================================================
// Fotocasa NO usa HTML estándar para sus listings.
// Los datos están embebidos en un <script> JSON dentro del HTML:
//
//   <script type="application/json" id="__initial_props__">
//     { "initialSearch": { "result": { "realEstates": [...] } } }
//   </script>
//
// Ruta de datos:
//   data.initialSearch.result.realEstates[].{id, price, detail, location, buildingSubtype}
//
// NO usamos cheerio aquí: parseamos el JSON directamente.
// ============================================================

interface FotocasaRealEstate {
  id: string;
  price?: string | number;
  detail?: Record<string, string>;
  location?: string;
  buildingSubtype?: string;
  url?: string;
}

interface FotocasaInitialProps {
  initialSearch?: {
    result?: {
      realEstates?: FotocasaRealEstate[];
    };
  };
}

export class FotocasaScraper extends BaseScraper {
  constructor(options?: Partial<ScraperOptions>) {
    super({ maxRetries: 2, ...options });
  }

  private static readonly DOMINIO = 'https://www.fotocasa.es';

  private static readonly TIPOS_INMUEBLE: Record<string, string> = {
    Flat: 'Piso',
    House_Chalet: 'Casa o chalet',
    Attic: 'Ático',
    Duplex: 'Dúplex',
    Studio: 'Estudio',
    Room: 'Habitación',
  };

  protected parse(html: string, task: ScrapingTask): Piso[] {
    const pisos: Piso[] = [];

    // 1. Extraer el bloque JSON embebido en el HTML
    const scriptMatch = html.match(
      /<script[^>]*type="application\/json"[^>]*id="__initial_props__"[^>]*>([\s\S]*?)<\/script>/i
    );

    if (!scriptMatch || !scriptMatch[1]) {
      console.warn('[fotocasa] No se encontró el script __initial_props__ en el HTML');
      return pisos;
    }

    let data: FotocasaInitialProps;
    try {
      data = JSON.parse(scriptMatch[1]) as FotocasaInitialProps;
    } catch {
      console.warn('[fotocasa] Error al parsear el JSON de __initial_props__');
      return pisos;
    }

    // 2. Navegar a la ruta de los inmuebles
    const realEstates = data?.initialSearch?.result?.realEstates ?? [];

    if (realEstates.length === 0) {
      console.warn('[fotocasa] realEstates vacío o ruta de datos incorrecta');
      return pisos;
    }

    for (const piso of realEstates) {
      try {
        // 3. Precio
        const precio = typeof piso.price === 'number'
          ? piso.price
          : this.parsearPrecio(String(piso.price ?? ''));

        // ---- FILTRO ANTI-SPAM ----
        if (precio === 0) continue;

        // 4. Enlace (viene como ruta en 'es-ES')
        const enlaceRelativo = piso.detail?.['es-ES'] ?? '';
        if (!enlaceRelativo) continue;

        const enlace = enlaceRelativo.startsWith('http')
          ? enlaceRelativo
          : `${FotocasaScraper.DOMINIO}${enlaceRelativo}`;

        // 5. Título basado en tipo de inmueble y ubicación
        const tipoInmueble = FotocasaScraper.TIPOS_INMUEBLE[piso.buildingSubtype ?? ''] ?? 'Inmueble';
        const ubicacion = piso.location ?? task.ciudad;
        const titulo = `${tipoInmueble} en ${ubicacion}`;

        // Intentar parsear el tipo exacto usando la utilidad
        const tipo = this.parsearTipo(tipoInmueble) || tipoInmueble;

        // Extraer Zona: location → macro de la ciudad (sin guardar texto libre).
        const zona = this.parsearZona(ubicacion, task.ciudad);

        // 6. ID: preferimos el id del portal, sino extraemos de la URL
        const id = piso.id
          ? String(piso.id)
          : this.extraerIdDeURL(enlaceRelativo);

        pisos.push({
          id,
          titulo,
          precio,
          enlace,
          portal: 'fotocasa',
          ciudad: task.ciudad,
          zona,
          tipo,
          // habitaciones: no está disponible directo en initialSearch de forma trivial sin mirar el array features. Lo dejamos como undefined por defecto, o el webhook intentará buscar "X habitaciones"
        });
      } catch {
        // Ignorar inmuebles que no se puedan parsear
      }
    }

    return this.deduplicar(pisos);
  }

  private extraerIdDeURL(href: string): string {
    // URLs de Fotocasa: /es/alquiler/viviendas/.../12345678/d
    const match = href.match(/\/(\d{6,})(?:\/[a-z])?$/);
    if (match) return match[1];

    // Fallback: hash de la URL
    let hash = 0;
    for (const char of href) {
      hash = ((hash << 5) - hash) + char.charCodeAt(0);
      hash |= 0;
    }
    return Math.abs(hash).toString();
  }
}
