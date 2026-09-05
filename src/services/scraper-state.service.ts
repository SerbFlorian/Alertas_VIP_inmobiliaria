import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

const STATE_FILE_PATH = path.join(process.cwd(), 'data', 'scraper_state.json');

interface CiudadState {
  lastScrapedPage?: number;
  lockedToFront?: boolean;
}

interface ScraperState {
  [portal: string]: {
    lastScrapedAt?: string;
    [ciudad: string]: CiudadState | string | undefined; // Para soportar la fecha en el portal y las páginas por ciudad
  };
}

let cachedState: ScraperState | null = null;

function loadState(): ScraperState {
  if (cachedState) return cachedState;

  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const data = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
      cachedState = JSON.parse(data);
      return cachedState!;
    }
  } catch (error) {
    logger.error('⚠️ Error al cargar scraper_state.json, se usará un estado vacío:', { error });
  }

  cachedState = {};
  return cachedState;
}

function saveState(state: ScraperState): void {
  try {
    const dir = path.dirname(STATE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    logger.error('⚠️ Error al guardar scraper_state.json:', { error });
  }
}

function getCiudadState(state: ScraperState, portal: string, ciudad: string): CiudadState {
  const raw = state[portal]?.[ciudad];
  return typeof raw === 'object' && raw !== null ? raw : {};
}

function ensureCiudadState(state: ScraperState, portal: string, ciudad: string): CiudadState {
  if (!state[portal]) {
    state[portal] = {};
  }
  const existing = state[portal][ciudad];
  if (typeof existing !== 'object' || existing === null) {
    state[portal][ciudad] = {};
  }
  return state[portal][ciudad] as CiudadState;
}

export function getLastScrapedPage(portal: string, ciudad: string): number {
  const state = loadState();
  return getCiudadState(state, portal, ciudad).lastScrapedPage ?? 0;
}

export function setLastScrapedPage(portal: string, ciudad: string, page: number): void {
  const state = loadState();
  const ciudadState = ensureCiudadState(state, portal, ciudad);
  ciudadState.lastScrapedPage = page;
  saveState(state);
}

export function isLockedToFront(portal: string, ciudad: string): boolean {
  const state = loadState();
  return getCiudadState(state, portal, ciudad).lockedToFront ?? false;
}

export function setLockedToFront(portal: string, ciudad: string, locked: boolean): void {
  const state = loadState();
  const ciudadState = ensureCiudadState(state, portal, ciudad);
  ciudadState.lockedToFront = locked;
  saveState(state);
}

export function getLastScraped(portal: string): number {
  const state = loadState();
  const dateStr = state[portal]?.lastScrapedAt;
  return dateStr ? new Date(dateStr).getTime() : 0;
}

export function setLastScraped(portal: string): void {
  const state = loadState();
  if (!state[portal]) {
    state[portal] = {};
  }
  state[portal].lastScrapedAt = new Date().toISOString();
  saveState(state);
}
