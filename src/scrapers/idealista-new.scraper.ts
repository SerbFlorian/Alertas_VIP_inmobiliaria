// ============================================================
// IDEALISTA NEW SCRAPER (alias de IdealistaScraper)
// ============================================================
// Usa las mismas URLs de Idealista pero con el filtro
// "fecha-publicacion-hoy" — captura los pisos más frescos
// antes de que aparezcan en el ranking general.
//
// Hereda toda la lógica de parseo de IdealistaScraper.
// Solo cambia las URLs configuradas en scraper.job.ts.
// ============================================================

export { IdealistaScraper as IdealistaNewScraper } from './idealista.scraper';
