# Alertas VIP Inmobiliarias — Manual de arquitectura y operaciones

> **Fuente única de verdad** del producto, diseño, scrapers, filtros, matching, Stripe, IA, Docker, Redis, R2 y cómo cambiar cosas con seguridad.  
> Idioma: **castellano**. Mercado: **solo España** (Barcelona · Madrid · Valencia).  
> Actualiza este fichero cuando cambies arquitectura u ops.

---

## 1. Qué es este producto

**Alertas VIP Inmobiliarias** es un Telegram Micro-SaaS que:

1. Scrapea anuncios de alquiler (España) hacia Postgres.
2. Deja a los VIP configurar un **radar** (filtros) + **`/horario`** (días · horas · intervalo).
3. Empareja inventario nuevo y entrega **digests en lote** (sin spam). Cada VIP elige entrega: defaults **cada 2 h**, **08:00–21:00** Madrid; hard floor **07–23**.
4. Ofrece un **asesor inmobiliario IA** (`/asesor`, GPT-4o-mini) con ámbito cerrado y herramientas de stock.
5. Monetiza con **Stripe Payment Links** (tiers por nº de VIP).

**Deploy hoy:** dos roles Node en Compose — **`app`** (bot Telegram + webhook Stripe + digests + R2 + IA) y **`scraper`** (ingest HTTP/Cheerio + Bright Data). Local: `APP_ROLE=all` / `WORKER_MODE=all`. Postgres + Redis al lado. Ambos con **`TZ=Europe/Madrid`**.

**Schedule split:**

| Lane | When |
|------|------|
| **Scrapers** | **Mon–Fri** 08–20 (ROUND_1 / ROUND_2) |
| **Digests VIP** | **Per VIP** vía `/horario` (días + horas + intervalo 1–4 h). Defaults: **L–D**, **08:00–21:00**, cada **2 h**. Hard floor **07–23** |
| Matching | Corre en el tick; la ventana del usuario solo retrasa **envíos Telegram** |

**Host objetivo (T0):** VPS compartido; este stack ~2 vCPU / ~2.5 GB de límites. Soft-launch / cientos–miles VIP / decenas de miles de pisos — no millones concurrentes en esta caja.

**Postura soft-launch (app hardenida + host con Tailscale/UFW/fail2ban + Cloudflare + secretos fuertes + R2 IP-restrict + `/health` slim + audit 0):** ~**96/100**.  
**No es “100 % protegido”** (nada lo es): residual típico = `.env` en el host, ops humanas (NPM, Stripe live), deps futuras. Ver §21.

---

## Portfolio — qué poner y cómo explicarlo

> Bloque listo para web / LinkedIn / CV. Habla de **producto**, no de “botito”. Sustituye métricas cuando tengas datos reales (usuarios, VIP, MRR).

### Elevator pitch (1–2 frases)

**Alertas VIP Inmobiliarias** es un micro-SaaS en Telegram que agrega anuncios públicos de alquiler en Barcelona, Madrid y Valencia, avisa a suscriptores VIP según filtros personalizados y ofrece un Asesor IA para buscar y recuperar anuncios — con pagos Stripe, privacidad (RGPD) y despliegue Docker en VPS.

### One-liner (tarjeta de proyecto)

> Micro-SaaS de alertas de alquiler en Telegram (ES): radar VIP 24/7, multi-portal, Stripe, Asesor IA y canal público de muestra.

### Qué es el producto

| Aspecto | Descripción |
|---------|-------------|
| **Tipo** | Micro-SaaS B2C (Telegram), no app nativa ni web SPA |
| **Mercado** | Personas buscando **alquiler** en **Barcelona · Madrid · Valencia** |
| **Propuesta** | Llegar antes / con menos fricción a anuncios relevantes sin refrescar portales a mano |
| **Planes** | **Gratis:** Asesor IA limitado + canal público (1 anuncio de muestra/día). **VIP:** radar con filtros + alertas por DM (hasta 3 anuncios/mensaje) + más cupos de IA y recuperación con enlace |
| **Qué no es** | Agencia, intermediario ni parte del contrato de alquiler; solo agrega y notifica información pública |

### Qué aporta / qué problema resuelve

- **Tiempo:** el usuario no tiene que revisar Idealista/Fotocasa/etc. cada hora.
- **Señal vs ruido:** filtros (ciudad, zonas, precio, tipo, habitaciones — incl. estudios con filtro `0`).
- **Velocidad de aviso:** alertas VIP periódicas con enlace al anuncio original.
- **Ayuda contextual:** Asesor IA entiende pedidos en lenguaje natural y puede devolver ficha + link (según plan/cupo).
- **Transparencia de precio:** etiqueta de “chollo” relativa a la mediana de zona×habitaciones cuando hay muestra suficiente.
- **Demo sin pagar:** canal público con 1 muestra/día para enseñar el sistema (FOMO → VIP).

### Qué mejora respecto al “buscar a mano” o a un bot simple

| Antes (usuario) | Con este producto |
|-----------------|-------------------|
| Abrir 4–5 portales y filtrar a mano | Un radar con preferencias guardadas |
| Perder anuncios entre refrescos | Alertas en lote por Telegram |
| ChatGPT genérico sin stock real | IA acotada al inventario indexado + cuotas anti-abuso |
| Bot “aviso suelto” sin negocio | Suscripción Stripe, estados VIP, cancelación con acceso hasta fin de periodo |
| Sin borrado / privacidad clara | Soft-purge RGPD (`/eliminar_cuenta`), retención mínima, docs legales |

### UI / UX (Telegram)

No hay frontend web: la **UI es el chat + teclados inline** (Telegraf).

| Pieza | Experiencia |
|-------|-------------|
| **Bienvenida** | Mensaje HTML claro Free vs VIP, comandos y CTA |
| **Privacidad** | Botón a PDF legal (Drive) desde el menú de estado |
| **`/filtros`** | Flujo por pasos (ciudad → zonas → precio → tipo → habs); borrador hasta **Aplicar**; cambiar ciudad resetea el resto a «Cualquiera» |
| **`/horario`** | Días · horas · intervalo 1–4 h (defaults 08–21 · cada 2 h; hard floor 7–23) |
| **Zonas** | Botones con stock real; **Cualquiera** = toda la ciudad; nota si hay anuncios sin barrio clasificado |
| **Alertas VIP** | Hasta 3 anuncios por mensaje, enlace «Anuncio encontrado»; warmup + cadencia según `/horario` |
| **`/asesor`** | Ayuda + ejemplos en castellano; respuestas en ficha HTML; cuota visible; recuperación solo cuenta si hay link |
| **`/estado`** | Suscripción + resumen de horario de alertas |
| **Canal público** | 1 chollo de muestra/día (retrasado); no sustituye el radar VIP |
| **Idioma** | 100 % castellano, tono directo |
| **Admin** | Cajita VIP viva + `/vip_count`; menú de comandos admin solo en el grupo admins |

### Stack / tecnología utilizada

| Capa | Tecnología |
|------|------------|
| Runtime | Node.js 22, TypeScript |
| Bot | Telegraf (long polling, inline keyboards) |
| API | Express (`/health`, webhook Stripe) |
| Datos | PostgreSQL 15 + Prisma |
| Cache / locks | Redis 7 |
| Scraping | Axios + Cheerio; Bright Data Unlocker como fallback |
| Enrichment zonas | Nominatim (OSM), códigos postales (Rentumo), jobs cron |
| IA | OpenAI (`gpt-4o-mini`), ámbito cerrado inmobiliario |
| Pagos | Stripe Payment Links + webhooks |
| Backups | Cloudflare R2 (S3-compatible) |
| Jobs | node-cron (scrapers, alertas, cleanup, privacy purge, canal público, enrich) |
| Deploy | Docker Compose: contenedores **`app`** + **`scraper`** aislados, Postgres, Redis |
| Ops / seguridad | TZ Europe/Madrid, logs redactados, soft-purge, Tailscale/UFW en host, secretos por contenedor |

### Arquitectura (cómo contarlo en 30 s)

1. **Scraper** indexa anuncios públicos → Postgres.  
2. **App** corre el bot, Stripe, IA y jobs de notificación.  
3. VIP guarda filtros → el notifier empareja inventario y envía alertas.  
4. Redis para locks/caché de inventario; R2 para backups offsite.  
5. Separación app/scraper para reducir superficie de secretos.

### Puntos fuertes para entrevista / portfolio

1. Producto **end-to-end** en producción (no solo CRUD demo).
2. **Monetización real** (Stripe: alta, cancelación, estados `Pagado` / `Cancelando` / `Cancelado`).
3. **Diseño de producto:** free funnel (canal + IA limitada) → VIP.
4. **Matching + anti-duplicados** de anuncios ya enviados.
5. **IA con límites** (free/VIP, recuperación solo si entrega link).
6. **Scraping resiliente** multi-portal + unlocker + horarios.
7. **Calidad de datos:** zonas inventory-aware, enrich Nominatim/CP.
8. **Privacidad by design:** no historial de chat en BD; soft-purge documentado.
9. **Ops:** Docker split roles, backups R2, health mínimo, crons.
10. **Documentación:** README de arquitectura + textos legales alineados al código.

### Texto largo (página de proyecto / LinkedIn)

Puedes pegar/adaptar:

> Desarrollé **Alertas VIP Inmobiliarias**, un micro-SaaS en Telegram para el mercado de alquiler en Barcelona, Madrid y Valencia. El sistema scrapea e indexa anuncios públicos de varios portales, permite a los usuarios VIP configurar un radar (ciudad, zonas, precio, tipo y habitaciones) y les envía alertas por mensaje con hasta tres anuncios y enlace a la fuente. Incluye un Asesor IA con cuotas, un canal público de muestra diaria, suscripciones vía Stripe y un flujo de borrado de datos (soft-purge) coherente con RGPD. Stack: TypeScript/Node, Telegraf, PostgreSQL/Prisma, Redis, OpenAI, Stripe, Docker Compose (app + scraper) y backups en Cloudflare R2. El foco de UX está en Telegram: menús por pasos, filtros con stock real y mensajes claros en castellano, sin necesidad de una app web.

### Checklist al publicar en el portfolio

- [ ] Título + one-liner  
- [ ] 3–5 bullets de impacto (problema → solución → stack)  
- [ ] Capturas o **vídeo demo** (filtros + alerta + `/asesor` + canal)  
- [ ] Link al bot / canal público (si quieres tráfico)  
- [ ] Link a florianserb.com o PDF legal (confianza)  
- [ ] **No** publicar `.env`, tokens ni detalles de bypass anti-bot  
- [ ] Cuando existan: usuarios activos, % conversión free→VIP, MRR  

### Etiquetas (skills)

`TypeScript` · `Node.js` · `Telegram Bot` · `Telegraf` · `PostgreSQL` · `Prisma` · `Redis` · `Stripe` · `OpenAI` · `Web Scraping` · `Docker` · `Micro-SaaS` · `RGPD` · `Cron Jobs` · `Cloudflare R2`

---

## Soft-launch — seguridad, UX, scrapers

### Seguridad e aislamiento

| Ítem | Detalle |
|------|---------|
| **Dual containers** | `app` ≠ `scraper` (`APP_ROLE` / `WORKER_MODE`) |
| **Secret surface (scraper)** | **Sin** `env_file` · **sin** Stripe / OpenAI / R2 / Payment Links · **sin** `TELEGRAM_BOT_TOKEN` ni admin Telegram — solo DB, Redis, Bright Data y knobs de scrape |
| **Secret surface (app)** | `env_file: .env` (`chmod 600`) — bot, Stripe, OpenAI, R2 |
| **Non-root + caps** | uid `1001` / redis `999`; `no-new-privileges`; Redis `read_only`+`cap_drop`; app/scraper **FS escribible** (Prisma Studio/tooling); límites CPU/RAM/**PIDs** |
| **Network** | App bind `127.0.0.1:3001` + red `npm_proxy` (`nginx-proxy_default`); db/redis/scraper solo `backend` |
| **Redis auth** | `requirepass` vía `REDIS_PASSWORD` en `.env` |
| **DB password** | `POSTGRES_PASSWORD` en `.env` (Compose → Postgres; no hardcode en YAML) |
| **HTTP** | `GET /health` → **solo** `{ "status": "ok" }` (sin inventario ni jobs); Stripe `POST /webhook/stripe` (firma + rate-limit); resto **404** |
| **Logs / CRITICAL** | `installRedactedConsole()` + Winston redact + `redactSecrets` en admin |
| **Privacy** | `/eliminar_cuenta` soft-purge; auto-purge tras `PRIVACY_PURGE_HOURS` (48 h); conserva `telegram_id` + `freeAiUsed` |
| **Migraciones** | `prisma migrate deploy` **sin** `--accept-data-loss` (solo app) |
| **R2** | Token API **restringido a la IP del VPS**; backups solo en app |
| **Supply chain** | Sin `better-sqlite3` (no se usaba); `overrides.uuid` ≥11.1.1; objetivo `npm audit` = **0** vulns |
| **Timezone** | `TZ=Europe/Madrid` en app + scraper |

### Producto y UX

| Ítem | Detalle |
|------|---------|
| **Bienvenida** | HTML + `<blockquote>` Free / IA / VIP / comandos (castellano) |
| **Comandos usuario** | `/start`, `/filtros`, `/horario` · `/schedule`, `/asesor`, `/estado`, `/eliminar_cuenta` (+ alias `/borrar_datos`) |
| **Comandos admin** | `/vip_count` solo en chat `TELEGRAM_ADMIN_ID` (menú scope `chat`) |
| **`/asesor`** | Free 3× · VIP 20/día · 140/sem · recuperar anuncio · recompensa enlace roto (por descripción en chat, **no** por filtros del radar) · ejemplos · Tip · cupo solo si se entrega link |
| **Filtros** | Borrador → **Aplicar** escribe BD; zonas **inventory-aware** + botón **Cualquiera**; **cambiar de ciudad reinicia** zonas/precio/tipo/habs; filtro habs **`0`** = estudio exacto |
| **`/horario`** | VIP: días · inicio/fin · intervalo 1–4 h. Defaults **L–D · 08–21 · cada 2 h**. Hard floor **07–23**. Prefs en `UsuarioVIP.digest_*` (sobreviven Reset del radar) |
| **Alertas VIP** | ≤3 / msg; warmup 5–15 min (**máx. 1 / 24 h**); cadencia **por usuario** vía `/horario` (seed 2 h); enlace «Anuncio encontrado» |
| **Lotes mismo piso** | Si ≥2 anuncios del digest tienen la misma ficha visible → aviso en negrita |
| **Chollo %** | % real bajo mediana ciudad×zona×hab (mín. n=5; chollo si ≥5 %) |
| **Canal público** | Ficha completa **sin** link al anuncio; solo CTA «Pasarse a VIP»; muestra del día + alertas diferidas 72 h |
| **Cajita VIP admin** | Un mensaje vivo (ASCII + tier + hora) editado in situ tras Stripe/cleanup/arranque |
| **Legal** | Botón Privacidad → PDF final en Drive (`LEGAL_URL` en `telegram.bot.ts`) |

### Scrapers (horario)

| Lane | Cron | Portales |
|------|------|----------|
| **ROUND_1** | Cada **2 h**, L–V 08–20 | indomio, nuroa, rentola, rentumo, uniplaces, yaencontre |
| **ROUND_2** | Cada **4 h**, L–V 08–20 | idealista, idealista-new, fotocasa, pisoscom, habitaclia, spotahome |
| **Sábado** | Off | — |

`SCRAPER_PAGES=1` · HTTP directo → Unlocker si bloqueo · deep scrape sin Unlocker por defecto (~**6–8 €/mes** BD si casi todo cobra).

---

## 2. Stack técnico

| Capa | Herramienta | Por qué |
|------|-------------|---------|
| Runtime | Node 22 + TypeScript → `dist/` | Alpine multi-stage |
| Bot | Telegraf | Long polling + inline keyboards |
| HTTP | Express | `/health` mínimo + webhook Stripe (`PORT` 3001) |
| ORM / BD | Prisma 5 + PostgreSQL 15 | Schema tipado + migraciones |
| Cache / locks | Redis 7 + ioredis | Lock digests + caché inventory (fail-open) |
| Scraping | Cheerio + Axios | Sin Playwright |
| Anti-bot | Bright Data Web Unlocker | Fallback tras bloqueo |
| IA | OpenAI `gpt-4o-mini` | `/asesor` — ámbito cerrado inmobiliario |
| Pagos | Stripe Payment Links + webhooks | VIP |
| Backups | Cloudflare R2 (`@aws-sdk/client-s3`) | Offsite; nunca dump por Telegram |
| Jobs | node-cron | Scrapers, digests, cleanup, privacy, R2 |
| Logs | Winston + redact | `logs/` |

**Scripts npm:**

```bash
npm run build / start / dev
npm run backup:now / backup:now:prod
npm run restore:latest / restore:latest:prod   # CONFIRM_RESTORE=YES
npm run backfill:zonas / backfill:zonas:prod
npm run cleanup
```

**Higiene deps (local / CI):**

```bash
npm audit          # objetivo: 0 vulnerabilities
# No uses npm audit fix --force a ciegas (puede subir node-cron a v4)
```

---

## 3. Layout del repo

```
Alertas_VIP_telegram/
├── src/
│   ├── index.ts                 # Bootstrap por APP_ROLE / WORKER_MODE · /health slim · crons
│   ├── db/
│   │   ├── prisma.ts
│   │   ├── queries.ts
│   │   └── appMeta.ts           # clave/valor (message_id cajita VIP, etc.)
│   ├── bot/                     # telegram.bot.ts, menus.ts, horario.menu.ts
│   ├── jobs/
│   │   ├── scraper.job.ts       # ROUND_1 / ROUND_2
│   │   ├── notifier.job.ts      # Digests VIP + chollo % + muestra del día
│   │   ├── public_channel.job.ts# Alertas gratis diferidas 72 h (sin link anuncio)
│   │   ├── enrich-zonas.job.ts  # Nominatim → zonaNorm
│   │   ├── cleanup.job.ts
│   │   ├── privacy-purge.job.ts # Soft-purge 48 h
│   │   └── availability.job.ts
│   ├── scrapers/                # idealista, fotocasa, rentumo…
│   ├── services/
│   │   ├── vipCounter.service.ts# Cajita VIP admin (editMessageText)
│   │   ├── redis.service.ts     # locks, warmup, cuota, cadencia
│   │   ├── digest-schedule.service.ts  # Prefs /horario (días·horas·intervalo)
│   │   ├── ai.service.ts, chollo.service.ts, telegram.service.ts, r2…
│   ├── middlewares/ratelimit.ts
│   ├── webhooks/stripe.webhook.ts  # + actualizarCajitaVip en eventos
│   ├── scripts/                 # backup, restore, backfill-zonas, enrich:zonas
│   └── utils/                   # normalizer, nominatim, codigos-postales, adminNotify…
├── prisma/
│   ├── schema.prisma            # + AppMeta
│   └── migrations/
├── docker/
│   └── entrypoint.sh
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
└── README.md
```

---

## 4. Modelo de datos (Prisma)

| Modelo | Rol |
|--------|-----|
| **Piso** | Anuncios scrapados; `zonaNorm`; flags canal público; PK `(id_piso, portal)` |
| **UsuarioVIP** | Telegram, Stripe, filtros, cupos IA, `cancel_at`, `freeAiUsed` |
| **InventoryStats** | Agregados ciudad×zonaNorm para menús |
| **NotificacionEnviada** | Dedup alertas VIP `(telegram_id, id_piso, portal)` |
| **ScraperLog** | Métricas por ciclo |
| **AppMeta** | Clave/valor ops (p. ej. `vip_cajita_message_id` → chatId+messageId) |

**Decisiones:** schema compacto; `zonaNorm` para matching; soft-purge conserva `telegram_id` + free AI; `AppMeta` + Redis para no perder la cajita admin al reiniciar.

---

## 5. Arquitectura runtime

```
┌────────────────┐                    ┌────────────────┐
│  scraper       │                    │  app           │
│ APP_ROLE=      │                    │ APP_ROLE=app   │
│ scraper        │──writes───────────▶│ Bot + Express  │
│ ROUND_1/2      │   Postgres         │ /health slim   │
│ DB+Redis+BD    │◀──reads────────────│ + Stripe WH    │
│ (sin TG/Stripe │   Redis lock/cache │ Digests+IA+R2  │
│  /OpenAI/R2)   │                    │ Privacy purge  │
└────────────────┘                    └────────┬───────┘
                                               │
                                               ▼
                                          Telegram users
```

Diario **06:00 (app):** `pg_dump` → gzip → R2 (`pg-dumps/`).  
Admin Telegram: solo CRITICAL desde **app** (texto redactado; nunca dumps).

---

## 6. Crons (`TZ=Europe/Madrid`)

| Expr | Job | Rol |
|------|-----|-----|
| `0 8-20/2 * * 1-5` | ROUND_1 | scraper |
| `0 8-20/4 * * 1-5` | ROUND_2 | scraper |
| `*/5 7-22 * * *` | Tick digests VIP (hard floor `NOTIF_HARD_*`; cadencia **por VIP** vía `/horario`, seed 2 h) | app |
| `* * * * *` | Warmup digests (cola Redis tras Aplicar; respeta `/horario`) | app |
| `0 2 * * *` | Cleanup pisos / fin VIP → `Cancelado` | app |
| `30 2 * * *` | Privacy soft-purge ≥48 h | app |
| `0 4 * * *` | Availability (anuncios caídos) | app |
| `0 6 * * *` | Backup → R2 | app |
| `0 10 * * *` | Canal público diferido 72 h (`public_channel.job`) | app |
| `30 */2 * * *` | Enrich zonas Nominatim | app |

**Guard scrapers:** `shouldRunScrapers()` → L–V 08–20.

---

## 7. Estrategia de scraping

1. Listado HTTP directo → si bloqueo, Bright Data Unlocker.
2. Upsert `Piso` (+ `zonaNorm`).
3. `refreshInventoryStats` + invalida caché Redis `inventory:zonas:*`.
4. Digests en el **app** (lock Redis `digest:notifier`).

**Cambiar horario / portales:** `src/jobs/scraper.job.ts` + env `SCRAPER_PAGES`, `DEEP_SCRAPE_*`.

---

## 8. Redis

**Principio:** aceleración + lock; **Postgres es la fuente de verdad**. Si Redis cae → fail-open (sin lock distribuido / sin caché).

| Key | Uso | TTL |
|-----|-----|-----|
| `digest:notifier` | Lock del ciclo digest | `DIGEST_LOCK_TTL_MS` (~10 min) |
| `digest:warmup:{telegramId}` | Primer digest rápido tras Aplicar (dueAt) | 5–15 min + margen |
| `digest:warmup_quota:{telegramId}` | Cuota anti-abuso del warmup | `DIGEST_WARMUP_QUOTA_HOURS` (24 h) |
| `digest:next_regular:{telegramId}` | Próximo digest **regular** due (epoch ms) | intervalo + 7 d margen |
| `digest:cooldown:{telegramId}` | Debounce anti doble-fire tras un envío | ~90 s |
| `digest:prefs:{telegramId}` | Cache JSON prefs `/horario` | ~5 min |
| `inventory:zonas:v2:{ciudad}` | Menús inventory-aware (zonas + total + sin clasificar) | ~90 s |
| `admin:vip_cajita:ref` | `{chatId, messageId}` de la cajita VIP | 90 días |

Auth: `requirepass` con `REDIS_PASSWORD` del `.env`. Compose inyecta `REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379`.

---

## 9. Filtros, digests y chollo %

### Filtros VIP (`menus.ts`)
- Borrador en memoria → **Aplicar** del panel → BD.
- Zonas solo con stock (`InventoryStats` / Redis).
- **Cambio de ciudad:** reinicia en el borrador zonas, precio máx, tipo y habitaciones a «Cualquiera» (inventario distinto por ciudad). Igual al elegir ciudad «Cualquiera».
- «Aplicar» del submenú confirma el borrador; «Atrás» restaura el snapshot del submenú.

### Digests (`notifier.job.ts`)
- 1 mensaje / usuario / ciclo, ≤ `DIGEST_MAX_LISTINGS` (3).
- **Cadencia regular POR USUARIO:** `UsuarioVIP.digest_interval_h` (1–4 h, default **2** vía `/horario`). Seed/fallback: `NOTIFIER_INTERVAL_MINUTES` (=120). Anclada al último **Aplicar**. Al reconfigurar filtros se **reinicia** el reloj. Cron tick cada `NOTIFIER_TICK_MINUTES` (5) solo comprueba quiénes están due.
- **Ventana por VIP:** días + horas de `/horario` (defaults **L–D · 08–21** Madrid). **Hard floor** sistema: `NOTIF_HARD_*` (default **07–23**); el cron no corre fuera.
- **Warmup tras Aplicar:** lote rápido en **5–15 min** (cuota **1 / 24 h**), reprogramado si cae fuera de la ventana del usuario. **No** mueve `next_regular`. Ver §9.1 / §9.2.
- Debounce corto (~90 s) tras cualquier envío (anti doble-fire).
- Orden: % bajo mediana → precio.
- Enlace HTML «Anuncio encontrado»; **sin** nombre de portal; `disable_web_page_preview`.
- Opcional: `DIGEST_SOLO_CHOLLOS=true`.
- **Lotes del mismo apartamento:** si ≥2 ítems comparten firma visual (título + precio + ciudad + zona + habs), cabecera en negrita aclarando que son anuncios/lotes distintos del mismo inmueble, no triplicados.

### 9.1. Patrón reutilizable — Warmup (cuota) + cadencia regular anclada al “guardar”

> Úsalo en otros bots cuando haya: (A) un envío rápido tras guardar preferencias, y (B) un ritmo estable de alertas que no debe acelerarse abusando de “guardar”.

#### Dos canales de envío (no mezclar)

| Canal | Qué es | Cuándo | Límite |
|-------|--------|--------|--------|
| **Warmup** | Primer lote tras Aplicar | 5–15 min después | **1× / 24 h** (`DIGEST_WARMUP_QUOTA_HOURS`) |
| **Regular** | Radar continuo | cada N **h** desde el último Aplicar (o desde el último regular enviado), según `/horario` | Sin cuota diaria; reloj **por usuario** |

#### Qué NO se limita
- Aplicar / guardar filtros (BD) → **ilimitado**.
- El ciclo regular se **reinicia** en cada Aplicar (no se bloquea).

#### Timeline ejemplo
```
T0     Usuario Aplicar filtros
T0     → next_regular = T0 + intervalo (/horario, default 2h)
T0     → si cuota warmup OK → cola warmup (T0+5..15, dentro de ventana VIP)
T0+10  Warmup envía (no toca next_regular)
T0+2h  Digest regular → next_regular = ahora + intervalo
T0+3h  Usuario vuelve a Aplicar (sin warmup si cuota 24h activa)
T0+3h  → next_regular = T0+3h + intervalo   ← reloj reiniciado
T0+5h  Digest regular con los filtros nuevos
```

#### Claves Redis (por usuario)

| Key | Valor | Rol |
|-----|-------|-----|
| `digest:warmup:{id}` | `dueAt` ms | Cola del lote rápido |
| `digest:warmup_quota:{id}` | `"1"` TTL 24h | Anti-abuso warmup |
| `digest:next_regular:{id}` | `nextAt` ms | Cadencia regular |
| `digest:cooldown:{id}` | `"1"` TTL ~90s | Debounce |
| `digest:prefs:{id}` | JSON prefs | Cache `/horario` ~5 min |

#### Al Aplicar filtros
```
1. Guardar preferencias en BD
2. resetCadence(user): next_regular = now + INTERVAL_H   // siempre (prefs /horario)
3. clear debounce
4. scheduleWarmup(user):
     - pending / cuota → no encolar
     - else SET warmup dueAt (en ventana VIP) + SET cuota 24h
5. UX: explicar cadencia reiniciada + resultado warmup
```

#### Algoritmo warmup `scheduleWarmup`
```
1. Si existe cola warmup → pending
2. Si existe cuota (TTL>0) → quota(retryAfterSec)
3. dueAt = calcularDueWarmupEnVentana(prefs, random(5..15))
4. SET NX cola
5. SET cuota EX = 24h
6. return scheduled
```

#### Worker warmup (cada 1 min; hard floor + /horario)
```
due = warmups con dueAt <= now
si fuera de /horario VIP → reprograma dueAt (sin quemar cuota)
enviar modo=warmup  → NO actualiza next_regular
DEL cola warmup     → cuota permanece
```

#### Worker regular (tick cada 5 min; hard floor NOTIF_HARD_*)
```
for each VIP activo:
  if fuera de /horario → skip
  if debounce → skip
  if now < next_regular → skip   // (sin clave → due)
  intentar enviar modo=regular
  si enviado → next_regular = now + intervalH + debounce ~90s
```

#### Env
```
NOTIFIER_INTERVAL_MINUTES=120   # seed/fallback (VIP nuevos / NOTIF_INTERVAL_HOURS)
NOTIFIER_TICK_MINUTES=5         # frecuencia del cron “quién está due”
NOTIF_HARD_START_HOUR=7         # hard floor sistema (inclusiva)
NOTIF_HARD_END_HOUR=23          # hard floor (exclusiva)
NOTIF_WINDOW_START_HOUR=8       # default /horario nuevos VIP
NOTIF_WINDOW_END_HOUR=21
# NOTIF_INTERVAL_HOURS=2        # opcional; si no, se deriva de NOTIFIER_INTERVAL_MINUTES
DIGEST_WARMUP_MIN_MINUTES=5
DIGEST_WARMUP_MAX_MINUTES=15
DIGEST_WARMUP_QUOTA_HOURS=24
```

#### Coste
Solo SQL matching + Telegram. Warmup/regular no re-scrapean. El tick de 5 min es barato si el check `next_regular` es O(1) en Redis antes de matching pesado (aquí el matching se construye una vez por tick).

#### Archivos en este repo
- `src/services/digest-schedule.service.ts` — prefs `/horario`, ventana Madrid, clamp hard floor
- `src/services/redis.service.ts` — warmup, cuota, `resetDigestCadenceOnFilterApply`, `isRegularDigestDue`, `markRegularDigestSent`
- `src/bot/horario.menu.ts` — UI días / horas / intervalo
- `src/bot/menus.ts` — `vip_aplicar` + atajo **⏰ Horario**
- `src/jobs/notifier.job.ts` — `modo: 'warmup' | 'regular'` + ventana por VIP
- `src/index.ts` — tick regular (hard floor) + cron warmup
- Migración: `prisma/migrations/20260806150000_digest_horario`

### 9.2 Horario digests (`/horario`, alias `/schedule`)

VIP-only. Prefs en **`UsuarioVIP`** (sobreviven Reset/Aplicar del radar):

| Campo | Default | Notas |
|-------|---------|--------|
| `digest_days` | L–D (1…7 ISO) | Multi-select; atajos Laborables / Toda la semana |
| `digest_start_hour` / `digest_end_hour` | 8 / 21 | Europe/Madrid. UI inicio **07–12**, fin **19–23**. Start ≠ end |
| `digest_interval_h` | **2** | Botones 1h · 2h · 3h · 4h |

**Hard floor** (env): `NOTIF_HARD_START_HOUR=7` … `NOTIF_HARD_END_HOUR=23`.  
**UX:** panel → Días · Horas · Intervalo · **Listo** (escribe BD + invalida `digest:prefs:*`). Aviso *Cambios sin guardar* hasta Listo. Tras guardar: confirmación + solo **✏️ Editar horario**.  
**Entrypoints:** `/horario`, `/schedule`, panel radar **⏰ Horario**, `/start` VIP, resumen en `/estado`.

### 9.3. Cajita VIP admin (contador vivo)

> Panel de ops en el chat `TELEGRAM_ADMIN_ID`: **un solo mensaje** que se reescribe (`editMessageText`), no un mensaje nuevo por cada alta/baja.

#### Decisión de diseño
- **Por qué un mensaje único:** el chat admin no se llena de “VIP actuales: N” en cada evento Stripe.
- **Por qué ASCII + `<pre>`:** legible en móvil, número centrado, aspecto de “dashboard”.
- **Por qué tier en el mismo mensaje:** el precio Stripe cambia a 200 / 300 VIP; el admin ve el umbral sin abrir el código.
- **Por qué triple persistencia** (memoria → Redis → `app_meta`): el contenedor puede reiniciarse; hace falta el `message_id` para seguir editando el mismo mensaje.

#### Qué cuenta como VIP activo
`contarUsuariosVip()` = estado **`Pagado`** **o** **`Cancelando`** con `cancel_at` aún futuro (o null).  
Quien ya expiró pero aún no pasó por cleanup no infla el número.

#### Formato del mensaje
```
💎 VIP activos

╔══════════╗
║    N     ║
╚══════════╝

Precio actual: Tier 1 (≤200) | Tier 2 (≤300) | Tier 3 (300+)
<hora Europe/Madrid>
```

#### Cuándo se actualiza (`actualizarCajitaVip`)
| Evento | Dónde |
|--------|--------|
| Arranque bot (~12 s) | `programarCajitaVipAlArranque` en `iniciarBot` |
| Alta VIP (checkout) | `stripe.webhook.ts` |
| Baja / cancelación inmediata | `stripe.webhook.ts` |
| Paso a Cancelando / reactivación | `stripe.webhook.ts` |
| Expiración en cleanup (≥1 usuario) | `cleanup.job.ts` |
| `/vip_count` | También refresca la cajita + responde con el mismo diseño |

#### Flujo técnico
```
1. Contar VIP
2. Montar HTML cajita
3. loadRef: memoria → Redis admin:vip_cajita:ref → app_meta.vip_cajita_message_id
4. Si hay message_id y mismo chatId → editMessageText
5. Si edit falla (mensaje borrado) o no hay ref → sendMessage + saveRef
```
Llamadas concurrentes se serializan (`refreshChain`) para no crear dos cajitas.

#### `/vip_count` vs cajita
| | Cajita | `/vip_count` |
|--|--------|--------------|
| Qué es | Panel vivo (1 mensaje) | Consulta puntual |
| Quién | Automática | Admin escribe el comando |
| Menú Telegram | No (no es comando de usuario) | Sí, solo scope chat admin |
| Diseño | ASCII + tier + hora | **El mismo** HTML |

#### Comandos Telegram (scopes)
- Default / privados: comandos de usuario (sin `/vip_count`).
- Scope `{ type: 'chat', chat_id: TELEGRAM_ADMIN_ID }`: usuario + `/vip_count`.

#### Archivos
- `src/services/vipCounter.service.ts`
- `src/db/appMeta.ts` + modelo `AppMeta`
- `src/services/telegram.service.ts` → `editarMensaje`
- `src/bot/telegram.bot.ts` → menús + arranque + `/vip_count`
- `src/webhooks/stripe.webhook.ts`, `src/jobs/cleanup.job.ts`

### 9.3. Canal público (plan gratuito) — diseño FOMO

#### Decisión de producto
El canal **no** compite con VIP: enseña que el sistema encuentra anuncios reales, pero **sin enlace al portal**. El CTA es solo **Pasarse a VIP**.  
VIP recibe DM filtrado con «Anuncio encontrado» + URL.

#### Dos publicaciones
| Tipo | Origen | Cron / trigger | Contenido |
|------|--------|----------------|-----------|
| **Chollo de muestra del día** | `notifier.job.ts` (si no hubo publicación pública hoy) | junto al tick digests | título, precio, ciudad, % chollo, CTA VIP — **sin** link anuncio |
| **Alerta gratuita (diferida 72 h)** | `public_channel.job.ts` | `0 10 * * *` | ficha completa + CTA VIP — **sin** link anuncio |

#### Ficha alerta diferida (campos)
- Título  
- Ciudad  
- Zona (`zona` / `zonaNorm` o «—»)  
- Tipo (Piso / Habitación, inferido)  
- Habitaciones (si hay; `0` → estudio)  
- Precio €/mes  
- CTA `Pasarse a VIP` → `t.me/VIP_managment_bot`  

**No incluir:** enlace al anuncio, avisos largos de “3 días tarde”, separadores de marketing.

#### Reglas de selección (`public_channel.job`)
- Máx. **5** publicaciones/semana (`fecha_publicacion_publica`).
- Candidatos: `publicado_en_canal_publico = false` y `created_at` ≥ **3 días**.
- Verifica si el anuncio sigue vivo; si caído → borra de BD y prueba otro.
- 1 anuncio por ciclo.

#### Ops: reset flags + forzar envío
```bash
# Marcar todos como no publicados en canal público
docker compose exec db psql -U alertas_user -d alertas_vip -c "
UPDATE pisos
SET publicado_en_canal_publico = false,
    telegram_public_message_id = NULL,
    fecha_publicacion_publica = NULL
WHERE publicado_en_canal_publico = true;
"

# Forzar un ciclo ahora (tras rebuild app)
docker compose exec alertas-vip node -e \
  "require('./dist/jobs/public_channel.job').ejecutarPublicChannelJob().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"
```

#### Archivos
- `src/jobs/public_channel.job.ts` — `formatearFichaPublica`
- `src/jobs/notifier.job.ts` — bloque muestra del día
- `src/db/queries.ts` — `getPisosParaCanalPublico`, `marcarPisoComoPublicadoPublico`, contadores semana/hoy

### Chollo %
`chollo.service.ts`: mediana ciudad×zonaNorm×hab (+ fallbacks). Chollo si ≥ `CHOLLO_MIN_PCT` (5) y muestra ≥ `CHOLLO_MIN_SAMPLES` (5).

---

## 10. IA (`/asesor`) — `ai.service.ts`

### Ámbito cerrado (estilo Auto Broker)
- Solo alquiler en **Barcelona / Madrid / Valencia** y macro-zonas del producto.
- Rechaza off-topic (guerras, fútbol, política, otras ciudades, etc.) con redirección corta.
- No inventa anuncios ni URLs; tool `buscar_piso_alternativa` = máx. **1** anuncio de la BD.
- Acceso dinámico VIP vs free en el system prompt (`construirPromptSistema`).
- Tool forzada solo en recuperación / descripción de piso (no en consejo puro de barrio).
- HTML Telegram; limpia URLs crudas y markdown del modelo.

### Cuotas y enlaces

| Uso | Comportamiento |
|-----|----------------|
| Free | `AI_FREE_MAX` (3) interacciones; 1 anuncio; **sin** enlace |
| VIP chat | 20/día · 140/semana |
| Alternativa / enlace caído | 1 piso desde BD según **ciudad/zona/precio del mensaje** — **no** lee automáticamente los filtros del radar VIP |
| Formato | Ficha + «Anuncio encontrado» (VIP); nunca nombre de portal |

---

## 11. Stripe

Payment Links TIER1–3 + Billing Portal. Webhook firmado + **rate-limit** IP.  
No hardcodear € en copy. `client_reference_id` = telegram id.

---

## 12. Backup & DR (Cloudflare R2)

### Por qué R2
Telegram ~50 MB; dumps crecen. R2 privado; admin = alertas only.

### Flujo
1. `pg_dump` → gzip → `pg-dumps/backup-{ISO}.sql.gz`
2. Prune > `BACKUP_RETENTION_DAYS` (7)
3. Fallo → CRITICAL redactado (app)

### Seguridad R2
- Credenciales **solo en app** (`env_file`).
- Token API Cloudflare **restringido a la IP del VPS** (hechos en consola R2).

### Runbook VPS

```bash
# Backup
docker compose exec alertas-vip npm run backup:now:prod

# Restore (destructivo) — deja db+app up; para scraper
docker compose stop scraper
docker compose exec -e CONFIRM_RESTORE=YES alertas-vip npm run restore:latest:prod
docker compose start scraper
```

**Smoke obligatorio:** backup aparece en bucket + (opcional) restore controlado.

---

## 13. Admin Telegram

| Variable | Uso |
|----------|-----|
| `TELEGRAM_ADMIN_ID` | Chat CRITICAL + **cajita VIP** + `/vip_count` (**solo app**) |
| `ADMIN_ALERT_COOLDOWN_MS` | Anti-spam CRITICAL (15 min) |

### Qué llega al chat admin
| Tipo | Comportamiento |
|------|----------------|
| **CRITICAL** | Fallos graves (backup, uncaught…); texto redactado; cooldown |
| **Cajita VIP** | Un mensaje vivo (edit); alta/baja/cancel/reactivar/expiración/arranque |
| **`/vip_count`** | Consulta puntual con el mismo diseño ASCII; también refresca la cajita |

El scraper **no** lleva token del bot → no puede enviar CRITICAL ni tocar la cajita (por diseño).  
Ver §9.2 para el detalle técnico de la cajita.

---

## 14. Docker / seguridad / sizing

| Servicio | CPU | RAM | Notas |
|----------|-----|-----|--------|
| **alertas-vip** (app) | 0.50 | 512M | Bot, Stripe, digests, IA, R2 · `127.0.0.1:3001` · `env_file` |
| **scraper** | 0.60 | 640M | ROUND_1/2 · **sin** `env_file` · **sin** Telegram · sin ports host · vol `scraper-state` |
| **redis** | 0.20 | 128M | `requirepass` · sin ports · maxmemory 96mb |
| **db** | 0.90 | 1280M | secret password · sin ports |

### Por qué split
Un RCE/crash en scraper **no** comparte proceso con bot ni Stripe. El scraper **no** tiene el token del bot: un compromiso de scrape no implica takeover del bot.

### Checklist harden

| Capa | Política |
|------|----------|
| Bind | `127.0.0.1:3001` solo app |
| Postgres / Redis / scraper | Sin `ports:` en host |
| Non-root | app/scraper `user: 1001:1001` · redis `999:999` |
| Anti-escalada | `no-new-privileges:true` en **todos** |
| Caps | `cap_drop: ALL`; Postgres solo CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID |
| FS | `read_only: true` en app/scraper/redis + tmpfs `/tmp` (y logs) |
| Recursos | `mem_limit` + `cpus` + `pids_limit` en **todos** |
| Aislamiento | `ipc: private`; sin docker.sock; scraper sin Stripe/R2/**Telegram**/OpenAI |
| Secrets | `.env` con `chmod 600`; R2 IP-restrict en Cloudflare |
| Boot | `prisma migrate deploy` (app); scraper espera app healthy |
| HTTP | `/health` mínimo + webhook; resto 404 |
| Logs | redact console + Winston |
| Deps | sin better-sqlite3; `npm audit` limpio |

### Nginx Proxy Manager (VPS)

```bash
# Tras pull/up — app en backend + nginx-proxy_default
docker compose up -d
docker inspect alertas-vip-inmobiliaria-bot --format '{{range $k,$v := .NetworkSettings.Networks}}{{println $k}}{{end}}'
# Debe listar: …_backend  y  nginx-proxy_default

sudo ss -tulpn | grep 3001   # solo 127.0.0.1:3001

# NPM UI (Proxy Host):
#   Domain: alertasinmobiliaria… (tu dominio)
#   Forward Hostname: alertas-vip-inmobiliaria-bot
#   Forward Port: 3001
#   Scheme: http
# Stripe webhook: https://TU_DOMINIO/webhook/stripe
```

**Túnel NPM admin (Windows → VPS):** el puerto 8181 local solo existe si el túnel SSH está abierto. Preferir IP Tailscale:

```powershell
# PowerShell (Tailscale Connected) — usar OpenSSH de Windows
C:\Windows\System32\OpenSSH\ssh.exe -i C:\Users\Florian\.ssh\id_ed25519_vps -L 8181:127.0.0.1:81 florian@100.91.140.107
```

```bash
# Git Bash / Linux (Tailscale Connected)
ssh -i ~/.ssh/id_ed25519_vps -L 8181:127.0.0.1:81 florian@100.91.140.107
```

Luego en el VPS comprueba que NPM escucha en loopback:
```bash
sudo ss -tulpn | grep ':81'
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep -i nginx
```

Si `localhost:8181` → `ERR_CONNECTION_REFUSED`: el túnel no está activo o NPM no está en `127.0.0.1:81`.

### Acceso seguro al VPS (Tailscale + SSH + UFW + fail2ban)

#### Por qué se hizo así

| Decisión | Motivo |
|---------|--------|
| **Fail2ban en `sshd`** | El VPS recibía fuerza bruta constante (`root`, usuarios inventados). Ban automático reduce ruido y riesgo sin tocar la app. |
| **SSH: solo clave, sin password, sin root login, `AllowUsers florian`** | Aunque llegue un bot al puerto 22, no hay login por contraseña ni root directo. |
| **UFW: 22 solo desde IP de casa + red Tailscale; 80/443 abiertos** | Cierra SSH al resto de Internet. Las webs (NPM/Cloudflare) siguen públicas. |
| **Tailscale (VPN mesh)** | Acceso admin por red privada (`100.x`). Misma cuenta en PC + VPS. No sustituye HTTPS público; solo el plano de administración. |
| **No cerrar 80/443** | Stripe webhook, dominio y canal público dependen del proxy. |
| **App/scraper sin `read_only` estricto** | Prisma Studio y tooling necesitan FS escribible; se priorizó ops estable tras incidentes de engines. Redis/DB siguen endurecidos. |

IPs de referencia (actualizar si cambian):

| Rol | IP |
|-----|-----|
| VPS pública | `46.225.172.167` |
| VPS Tailscale | `100.91.140.107` |
| PC (casa) allowlist SSH | `92.178.60.203` (verificar con `Invoke-RestMethod https://ifconfig.me/ip`) |
| Rango Tailscale UFW | `100.64.0.0/10` |

#### Comandos — PowerShell (Windows)

Requisito: app **Tailscale Connected** en el PC.

```powershell
# Preferir OpenSSH de Windows (evita KEX errors del ssh de Git)
$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
# Si HOME está mal (/home/Florian): $env:HOME = $env:USERPROFILE

# SSH normal (recomendado: por Tailscale)
& $ssh -i C:\Users\Florian\.ssh\id_ed25519_vps florian@100.91.140.107

# Alternativa: IP pública (solo si tu IP de casa sigue en UFW allowlist)
& $ssh -i C:\Users\Florian\.ssh\id_ed25519_vps florian@46.225.172.167

# Túnel Prisma Studio → http://127.0.0.1:5555
& $ssh -i C:\Users\Florian\.ssh\id_ed25519_vps -L 5555:127.0.0.1:5555 florian@100.91.140.107

# Túnel NPM admin → http://127.0.0.1:8181
& $ssh -i C:\Users\Florian\.ssh\id_ed25519_vps -L 8181:127.0.0.1:81 florian@100.91.140.107

# Keepalive (menos Connection reset)
& $ssh -i C:\Users\Florian\.ssh\id_ed25519_vps -o ServerAliveInterval=20 -o ServerAliveCountMax=10 florian@100.91.140.107
```

#### Comandos — Bash / Git Bash

```bash
# SSH por Tailscale (recomendado)
ssh -i ~/.ssh/id_ed25519_vps florian@100.91.140.107

# Alternativa IP pública (allowlist casa)
ssh -i ~/.ssh/id_ed25519_vps florian@46.225.172.167

# Túnel Prisma Studio
ssh -i ~/.ssh/id_ed25519_vps -L 5555:127.0.0.1:5555 florian@100.91.140.107

# Túnel NPM
ssh -i ~/.ssh/id_ed25519_vps -L 8181:127.0.0.1:81 florian@100.91.140.107

# Keepalive
ssh -i ~/.ssh/id_ed25519_vps -o ServerAliveInterval=20 -o ServerAliveCountMax=10 florian@100.91.140.107
```

#### En el VPS — Prisma Studio (con el túnel `-L 5555` activo)

```bash
cd ~/Alertas_VIP_inmobiliaria
docker compose run --rm -p 127.0.0.1:5555:5555 alertas-vip \
  npx prisma studio --hostname 0.0.0.0 --port 5555
```

Abre en el PC: `http://127.0.0.1:5555`. Al terminar: `Ctrl+C` y/o `docker stop` del contenedor `*-run-*`.

#### Comprobar host hardening

```bash
sudo sshd -T | grep -Ei 'passwordauthentication|permitrootlogin|allowusers'
sudo ufw status verbose
sudo fail2ban-client status sshd
tailscale ip -4
curl -sS http://127.0.0.1:3001/health
```

UFW esperado: `22` solo desde IP casa + `100.64.0.0/10`; `80`/`443` Anywhere; **sin** `22 Anywhere`.

#### Si cambia la IP de casa

1. Consola del panel del VPS (rescue/VNC) si no puedes entrar.
2. `sudo ufw allow from NUEVA.IP to any port 22 proto tcp`
3. Actualizar `ignoreip` en `/etc/fail2ban/jail.local` y `sudo systemctl restart fail2ban`.

### Prisma Studio (inspeccionar BD)

Ver § «Acceso seguro al VPS» arriba (túnel SSH + `docker compose run`). Resumen corto en el VPS:

```bash
docker compose run --rm -p 127.0.0.1:5555:5555 alertas-vip \
  npx prisma studio --hostname 0.0.0.0 --port 5555
```

### Verificación (stack Alertas)

```bash
docker compose exec alertas-vip id          # uid=1001(nodejs)
docker compose exec scraper id
docker compose exec redis id                # uid=999
docker compose logs -f alertas-vip scraper

curl -sS http://127.0.0.1:3001/health
# esperado: {"status":"ok"}

docker compose exec redis redis-cli -a "$REDIS_PASSWORD" ping

docker compose exec scraper printenv TELEGRAM_BOT_TOKEN || true   # vacío
docker compose exec scraper printenv R2_BUCKET || true            # vacío
docker compose exec scraper printenv STRIPE_SECRET_KEY || true    # vacío
docker compose exec alertas-vip printenv R2_BUCKET                # ok
```

### Primer deploy

```bash
cp .env.example .env
# Edita POSTGRES_PASSWORD + REDIS_PASSWORD (fuertes) y el resto de claves
chmod 600 .env

# Si el volumen Postgres YA tenía otra pass:
docker compose exec db psql -U alertas_user -d alertas_vip \
  -c "ALTER USER alertas_user WITH PASSWORD 'TU_PASS_NUEVA';"
```

---

## 15. Variables de entorno

Ver `.env.example`. Bloques:

- **Core:** `TELEGRAM_*`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `PORT`, `TZ`
- **Stripe / OpenAI / R2:** solo relevantes en **app**
- **Bright Data / scrape:** scraper vía `environment:` Compose (sin Telegram)
- **IA:** `AI_VIP_DAILY_MAX`, `AI_VIP_WEEKLY_MAX`, `AI_FREE_MAX`, `AI_*_RECOVERY_*`, `AI_TIMEOUT_MS`
- **Privacy:** `PRIVACY_PURGE_HOURS` (= `DATA_PURGE_HOURS`)
- **Digests / cadencia / warmup / horario:**
  - `NOTIFIER_INTERVAL_MINUTES=120` — seed/fallback (VIP nuevos); intervalo real = `/horario`
  - `NOTIF_INTERVAL_HOURS` — opcional; si no, se deriva de los minutos
  - `NOTIFIER_TICK_MINUTES=5` — cada cuánto el cron mira quiénes están due
  - `NOTIF_HARD_START_HOUR` / `NOTIF_HARD_END_HOUR` — hard floor sistema (default 7–23)
  - `NOTIF_WINDOW_START_HOUR` / `NOTIF_WINDOW_END_HOUR` — defaults `/horario` (8–21)
  - `DIGEST_WARMUP_MIN/MAX_MINUTES` — ventana del lote rápido
  - `DIGEST_WARMUP_QUOTA_HOURS=24` — máx. 1 warmup / N horas
  - `DIGEST_MAX_LISTINGS`, `DIGEST_LOOKBACK_DAYS`, `DIGEST_SOLO_CHOLLOS`
- **Chollo / enrich:** `CHOLLO_*`, `ENRICH_ZONAS_*`
- **Roles:** `APP_ROLE` / `WORKER_MODE` (`app` \| `scraper` \| `all`)

**Legal (código, no env):** `LEGAL_URL` en `telegram.bot.ts` (PDF Drive final).

Secretos: todo vive en `.env` (`chmod 600`). Compose inyecta `DATABASE_URL`/`REDIS_URL` desde `POSTGRES_PASSWORD`/`REDIS_PASSWORD`.

---

## 16. Decisiones de producto (locked)

| Decisión | Razón |
|----------|--------|
| Cadencia **1–4 h/usuario** vía `/horario` (default 2) | UX premium; seed `NOTIFIER_INTERVAL_MINUTES` solo para VIP nuevos |
| `/horario` días + horas; hard floor **7–23** | Noches libres para cleanup/backup; el usuario controla la entrega |
| Tras guardar `/horario`: solo **Editar horario** | Sin botón al radar (navegación redundante) |
| Warmup 5–15 min con cuota **24 h** | Sensación de “el radar responde” sin abuso cambiando filtros |
| Aplicar filtros **ilimitado** | Solo se limita el envío rápido, no la escritura BD |
| Warmup **no** mueve `next_regular` | El ciclo regular queda anclado al Aplicar, no al lote rápido |
| Tick cron 5 min ≠ intervalo usuario | El cron solo comprueba dues; la cadencia real es Redis + prefs BD |
| Digests 1 msg, ≤3 | UX VIP; protege Telegram |
| % chollo real (no fake) | Confianza |
| Sin nombre de portal en DMs | Marca propia; «Anuncio encontrado» |
| Canal gratis **sin** link al anuncio | FOMO → VIP; free ve ficha, no se salta el paywall |
| Filtros borrador → Aplicar | Menos writes BD |
| Ciudad cambia → reset resto filtros | Inventario / zonas por ciudad |
| Filtro habs `0` = estudio exacto | Distinto de «1+» (mínimo) |
| Aviso lotes mismo piso | Evita “me mandó 3 iguales” |
| Free 3 IA; link solo si se entrega | Embudo VIP + cuota honesta |
| VIP 20/140 | Cupo honesto |
| IA ámbito cerrado ES alquiler | No chatbot genérico |
| Alternativa IA por chat, no radar | Claridad; tool ligera ≠ digests |
| Cajita VIP = 1 mensaje editado | Chat admin limpio; tier visible |
| Soft-purge conserva telegram_id | Anti-abuso free trial |
| Chat IA no en Postgres | Minimización RGPD; solo RAM + OpenAI al vuelo |
| R2 no Telegram para dumps | Escala + seguridad |
| Scraper sin token bot | Blast radius |
| `/health` mínimo | Sin info leak |
| Castellano only | Mercado ES |
| Volúmenes Docker named | Persistencia si el contenedor cae; backup R2 a las 06:00 |

---

## 17. Recetas de cambio

| Objetivo | Dónde |
|----------|--------|
| Horario digests VIP | `/horario` o **⏰ Horario** en el panel; prefs `UsuarioVIP.digest_*` |
| Defaults / hard floor | `NOTIF_WINDOW_*`, `NOTIF_HARD_*`, seed `NOTIFIER_INTERVAL_MINUTES` → restart app |
| Tick del cron due | `NOTIFIER_TICK_MINUTES` |
| Cuota warmup 24 h | `DIGEST_WARMUP_QUOTA_HOURS` |
| Ventana scrapers | `scraper.job.ts` + `shouldRunScrapers` |
| Nuevo portal | `src/scrapers/` + `TAREAS_BASE` |
| Prompt / cuotas IA | `ai.service.ts` + env `AI_*` |
| Reset al cambiar ciudad | `menus.ts` (`draft_ciudad_*`) |
| Aviso lotes digest | `notifier.job.ts` (`hayLotesMismoApartamento`) |
| Texto canal gratis | `public_channel.job.ts` (`formatearFichaPublica`) |
| Cajita / contador VIP | `vipCounter.service.ts` + Stripe/cleanup hooks |
| PDF legal | `LEGAL_URL` en `telegram.bot.ts` |
| Schema | editar Prisma → `migrate` → deploy app |
| Forzar solo chollos | `DIGEST_SOLO_CHOLLOS=true` |
| Payload `/health` | `src/index.ts` |

---

## 18. Chuleta ops

```bash
# --- Acceso (desde PC; Tailscale Connected) ---
# Preferir OpenSSH de Windows (evita "Unable to negotiate a key exchange method" del ssh de Git):
#   C:\Windows\System32\OpenSSH\ssh.exe -i C:\Users\Florian\.ssh\id_ed25519_vps florian@100.91.140.107
#   C:\Windows\System32\OpenSSH\ssh.exe -i C:\Users\Florian\.ssh\id_ed25519_vps -L 5555:127.0.0.1:5555 florian@100.91.140.107
# Si falla Sysnative, no usarlo. Si HOME apunta a /home/Florian: $env:HOME = $env:USERPROFILE
# Bash:
#   ssh -i ~/.ssh/id_ed25519_vps florian@100.91.140.107
#   ssh -i ~/.ssh/id_ed25519_vps -L 5555:127.0.0.1:5555 florian@100.91.140.107

cd ~/Alertas_VIP_inmobiliaria
docker compose up -d --build
docker compose ps
curl -sS http://127.0.0.1:3001/health
# {"status":"ok"}

docker compose logs -f alertas-vip scraper

docker compose exec db psql -U alertas_user -d alertas_vip -c "SELECT COUNT(*) FROM pisos;"
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" ping

# Prisma Studio → http://127.0.0.1:5555 (con túnel -L 5555 activo)
docker compose run --rm -p 127.0.0.1:5555:5555 alertas-vip \
  npx prisma studio --hostname 0.0.0.0 --port 5555

docker compose exec alertas-vip npm run backup:now:prod
docker compose exec alertas-vip npm run backfill:zonas:prod
docker compose exec alertas-vip npm run enrich:zonas:prod

# Forzar alerta canal gratuito (ficha sin link anuncio)
docker compose exec alertas-vip node -e \
  "require('./dist/jobs/public_channel.job').ejecutarPublicChannelJob().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"

# Reset flags canal público
docker compose exec db psql -U alertas_user -d alertas_vip -c "
UPDATE pisos SET publicado_en_canal_publico = false,
  telegram_public_message_id = NULL, fecha_publicacion_publica = NULL
WHERE publicado_en_canal_publico = true;"

docker compose stop scraper
docker compose exec -e CONFIRM_RESTORE=YES alertas-vip npm run restore:latest:prod
docker compose start scraper

docker compose restart alertas-vip

# Host hardening check
sudo ufw status verbose
sudo fail2ban-client status sshd
tailscale ip -4

# Limpieza Docker (cuidado con -v → borra volúmenes)
docker system prune
```

### Verificación automática del sistema (smoke operativo)

Incluye validación de:
- variables sensibles en `.env` (no vacías),
- estado/health de `alertas-vip`, `scraper`, `db`, `redis`,
- `health` local (y público opcional),
- errores críticos recientes en logs de app.

```bash
# desde el root del repo
npm run verify:system

# opcional: también validar health público
PUBLIC_HEALTH_URL="https://alertasinmobiliaria.florianserb.com/health" npm run verify:system

# mismo check ejecutado dentro del contenedor app (útil en deploy remoto)
docker compose exec alertas-vip npm run verify:system

# tras un deploy, patrón recomendado:
docker compose up -d --build
PUBLIC_HEALTH_URL="https://alertasinmobiliaria.florianserb.com/health" npm run verify:system
```

Si devuelve `FAIL>0`, el script sale con código 1 (útil para CI o hooks de deploy).

### Alertas automáticas al chat de admins (fail/recovery)

```bash
# Ejecuta verify + notifica al chat admin en fallo/recuperación
npm run ops:verify:notify
```

### Recordatorio mensual al chat de admins

Incluye:
- revisión manual de dependencias (controlada, sin auto-upgrades semanales),
- recordatorio de drill mensual de restore real.

```bash
npm run ops:monthly:reminder
```

### Cron recomendado en VPS (automatización)

```bash
# Editar crontab del usuario florian
crontab -e

# Cada 30 min: verify + alerta al chat admin si falla o se recupera
*/30 * * * * cd /home/florian/Alertas_VIP_inmobiliaria && PUBLIC_HEALTH_URL="https://alertasinmobiliaria.florianserb.com/health" npm run ops:verify:notify >> logs/ops-verify.log 2>&1

# Día 1 de cada mes, 10:15: recordatorio mensual deps + restore drill
15 10 1 * * cd /home/florian/Alertas_VIP_inmobiliaria && npm run ops:monthly:reminder >> logs/ops-reminder.log 2>&1
```

### CI por PR (automatizado)

Workflow incluido: `.github/workflows/ci.yml`
- `npm ci`
- `npx tsc --noEmit`
- `npm audit --audit-level=high`

### Cobertura extra recomendada (siguiente nivel)

1. **Runbook de rotación de secretos** con checklist y smoke obligatorio post-rotación (ya documentado).
2. **Drill mensual de restore real** con acta de RTO/RPO.
3. **Near-dup cross-portal** y cola Redis `notif:q` para escalar envío.

---

## 19. Tracker

### Hecho ✅
- Dual app/scraper · non-root/caps · passwords en `.env` · Redis auth · volúmenes named
- migrate sin accept-data-loss · privacy 48 h · chollo % · digests batch
- R2 + **IP-restrict token** · inventory-aware · redact logs · rate-limit Stripe
- HTTP 404 catch-all · **`/health` slim** (`status: ok` only)
- Scraper **sin** Stripe / R2 / OpenAI / **`TELEGRAM_BOT_TOKEN`**
- Asesor IA experto: ámbito cerrado BCN/MAD/VLC · tool stock · VIP vs free · cupo solo si hay link
- Cambio de ciudad → reset borrador (zonas/precio/tipo/habs); filtro habs `0` = estudio
- Digest: aviso negrita si lotes del mismo apartamento
- **Cadencia por usuario** vía `/horario` (1–4 h, default 2) + **warmup cuota 24 h** + hard floor 7–23
- **`/horario`** UI (días/horas/intervalo) · prefs en `UsuarioVIP` · visible en `/estado`
- **Cajita VIP admin** (edit in-place) + `/vip_count` + menú scope admin
- **Canal gratis sin link anuncio** (ficha + CTA VIP); sample del día + diferidas 72 h
- Textos legales finales + `LEGAL_URL` Drive
- Enrich zonas Nominatim + CP Rentumo
- Copy `/asesor`: alternativa por descripción del chat (no radar)
- Supply chain: sin `better-sqlite3` · `overrides.uuid` · `npm audit` 0
- Secretos vía `.env` (`chmod 600`) + Compose `env_file`
- Script `verify:system` + `ops:verify:notify` con alerta al chat admins en fail/recovery
- Recordatorio mensual automático al chat admins (deps manual + restore drill)
- CI por PR (`.github/workflows/ci.yml`: install + typecheck + audit high)

### Pendiente / opcional
- [ ] Near-dup cross-portal (dedup inteligente entre portales)
- [ ] Cola Redis tipo `notif:q:{user}` (hoy digests síncronos + lock)
- [ ] Smoke Stripe live → VIP en VPS (si aún no)
- [ ] Dependabot (se mantiene manual por decisión de producto/ops)

---

## 20. Glosario

| Término | Significado |
|---------|-------------|
| **Alerta / digest** | 1 mensaje Telegram con ≤3 anuncios (en docs de usuario preferir «alerta VIP») |
| **Warmup** | Primer lote rápido 5–15 min tras Aplicar (máx. 1 / 24 h); respeta `/horario` |
| **Horario** (`/horario`) | Prefs VIP: días + horas + intervalo 1–4 h; hard floor 7–23 Europe/Madrid |
| **Hard floor** | `NOTIF_HARD_*`: techo del sistema; `/horario` no puede salir de ahí |
| **Cadencia regular** | Reloj por usuario: cada `digest_interval_h` desde el último Aplicar (o último envío regular); seed `NOTIFIER_INTERVAL_MINUTES` |
| **Cajita VIP** | Mensaje admin único con contador ASCII + tier; se edita in situ |
| **Chollo** | Precio ≥5 % bajo mediana de zona |
| **Radar** | Filtros VIP activos (`/filtros`) |
| **Borrador** | Filtros en memoria hasta Aplicar del panel |
| **Lotes mismo piso** | Varios anuncios con misma ficha visible; enlaces distintos |
| **zonaNorm** | Zona canónica sin acentos |
| **Cualquiera** (zonas) | `filtro_zonas` vacío → toda la ciudad |
| **ROUND_1 / 2** | Mitades de portales (ligeros / duros) |
| **APP_ROLE / WORKER_MODE** | `app` \| `scraper` \| `all` |
| **Soft-purge** | Borra PII; conserva telegram_id + free AI |
| **AppMeta** | Tabla clave/valor ops (p. ej. message_id cajita) |
| **Ámbito cerrado IA** | Solo inmobiliaria alquiler ES (ciudades del producto) |
| **Bright Data** | Unlocker de pago (≠ Postgres) |

---

## 21. Catálogo de controles de seguridad (implementados)

> Checklist vivo de **todo** lo que endurece el sistema. Verificación VPS actual:  
> `curl …/health` → `{"status":"ok"}` · `npm audit` → `0 vulnerabilities`.

### A. Contenedores y sistema

| # | Control | Dónde | Qué evita |
|---|---------|-------|-----------|
| A1 | Dual `app` / `scraper` | `docker-compose.yml`, `APP_ROLE` | Blast radius: scrape ≠ bot/pagos |
| A2 | Scraper **sin** `env_file` | compose `scraper` | Stripe/OpenAI/R2 no llegan al scraper |
| A3 | Scraper **sin** `TELEGRAM_BOT_TOKEN` / admin | compose (quitado) | RCE scraper ≠ takeover del bot |
| A4 | Non-root `1001:1001` (Node) / `999` (Redis) | compose + Dockerfile | Privilegio de root en proceso |
| A5 | `cap_drop: ALL` en Redis (+ mínimas solo en Postgres) | compose | Escalada por capabilities en datos |
| A6 | `no-new-privileges:true` | todos los servicios | `setuid` / privilege escalation |
| A7 | Redis `read_only` + tmpfs; app/scraper FS escribible (ops/Prisma) | compose | Equilibrio seguridad datos vs tooling |
| A8 | `mem_limit` / `cpus` / `pids_limit` | todos | DoS por fork bomb / RAM |
| A9 | `ipc: private` | Node runtime | IPC compartido entre containers |
| A10 | Sin `docker.sock` montado | compose | Escape a Docker host |
| A11 | Multi-stage Alpine image | `Dockerfile` | Superficie de build mínima |

### B. Red y exposición

| # | Control | Dónde | Qué evita |
|---|---------|-------|-----------|
| B1 | App bind `127.0.0.1:3001` | compose `ports` | Exposición directa a Internet del Node |
| B2 | DB / Redis / scraper **sin** `ports:` host | compose | Acceso externo a datos/cola/scrape |
| B3 | Red `backend` interna | compose networks | Aislamiento L2 entre servicios |
| B4 | App también en `npm_proxy` | NPM → contenedor | Solo proxy reverso llega al HTTP |
| B5 | Catch-all HTTP **404** | `src/index.ts` | Endpoints inventados / scanning |

### C. Secretos y almacenamiento

| # | Control | Dónde | Qué evita |
|---|---------|-------|-----------|
| C1 | `.env` gitignored + `chmod 600` | ops / `.gitignore` | Filtrado de claves al repo / world-readable |
| C2 | Passwords **no** hardcode en YAML | compose `${…}` | Secrets en git |
| C3 | Redis `requirepass` + URL con pass | compose + `.env` | Redis abierto sin auth |
| C4 | Postgres password fuerte rotado | `.env` + `ALTER USER` si volumen viejo | Credenciales por defecto |
| C5 | R2 solo en app | compose | Scraper sin dumps/PII offsite |
| C6 | R2 API token **IP-restrict VPS** | Cloudflare R2 | Uso del token desde fuera del servidor |
| C7 | Backups nunca por Telegram | `backup.ts` | Dumps gigantes / fuga por chat |
| C8 | Variables sensibles validadas por smoke | `verify-system.sh` | Arranque con claves vacías |

### D. Superficie HTTP y pagos

| # | Control | Dónde | Qué evita |
|---|---------|-------|-----------|
| D1 | `/health` → solo `{status:"ok"}` | `index.ts` | Info leak (inventario, memoria, jobs) |
| D2 | Stripe `constructEvent` (firma) | `stripe.webhook.ts` | Webhooks falsos |
| D3 | Rate-limit webhook por IP | `middlewares/ratelimit.ts` | Flood / abuso Stripe endpoint |
| D4 | Body raw para Stripe | Express router | Bypass de verificación de firma |

### E. Bot, VIP y abuso

| # | Control | Dónde | Qué evita |
|---|---------|-------|-----------|
| E1 | VIP check en filtros / panel | `menus.ts` `requerirUsuarioVIP` | Free configura radar |
| E2 | Cuotas IA free / VIP | `queries.ts` + `ai.service.ts` | Abuso OpenAI |
| E3 | Rate-limit por usuario Telegram (~1 s) | `telegram.bot.ts` | Flood de mensajes |
| E4 | Ignora grupos | bot middleware | Spam multigrupo |
| E5 | Soft-purge + `/eliminar_cuenta` | privacy job + bot | Retención PII innecesaria |
| E6 | Soft-purge conserva `telegram_id` + `freeAiUsed` | queries | Re-abuso del trial free |
| E7 | Warmup cuota 24 h | `redis.service` `DIGEST_WARMUP_QUOTA_HOURS` | Spam de lotes rápidos abusando Aplicar |
| E8 | Cadencia por usuario anclada a Aplicar | `next_regular` Redis | Envíos desalineados / globales cada 2 h clock |
| E9 | Cajita VIP edit (no flood admin) | `vipCounter.service` | Spam de contadores en chat admin |
| E10 | Canal free sin URL anuncio | `public_channel.job` | Bypass paywall vía canal gratis |

### F. Logs, privacidad y datos

| # | Control | Dónde | Qué evita |
|---|---------|-------|-----------|
| F1 | `installRedactedConsole()` | boot | Tokens en stdout |
| F2 | Winston + patrones redact | `logger` / `secrets.ts` | Stripe/TG/OpenAI/DB en logs |
| F3 | Admin CRITICAL redactado + cooldown | `adminNotify.ts` | Spam + secretos a admin |
| F4 | Purge 48 h post-cancelación | `privacy-purge.job.ts` | PII huérfana |
| F5 | Migraciones sin `--accept-data-loss` | `entrypoint.sh` | Wipe accidental de BD |

### G. IA (ámbito y datos)

| # | Control | Dónde | Qué evita |
|---|---------|-------|-----------|
| G1 | Ámbito cerrado inmobiliario ES | `ai.service.ts` SYSTEM | Jailbreak / off-topic |
| G2 | Sin URLs al modelo; limpia markdown/URLs | `limpiarEnlacesSucios` | Enlaces sucios / portales |
| G3 | Tool = 1 anuncio real BD | `buscarPisoAlternativo` | Inventar stock |
| G4 | Enlace solo VIP en ficha | `formatearPisoAlternativa` | Free con link directo |

### H. Supply chain

| # | Control | Dónde | Qué evita |
|---|---------|-------|-----------|
| H1 | Sin `better-sqlite3` | `package.json` | Addon nativo innecesario |
| H2 | `overrides.uuid` ≥ 11.1.1 | `package.json` | CVE uuid vía node-cron |
| H3 | `npm audit` = 0 | lockfile | CVEs conocidos conocidos |

### I. Observabilidad operativa

| # | Control | Dónde | Qué evita |
|---|---------|-------|-----------|
| I1 | Verificación integral del sistema | `scripts/verify-system.sh` | Fallos silenciosos de health/servicios/secrets |
| I2 | Alerta automática fail/recovery a admins | `scripts/verify-and-notify.sh` | Detección tardía de caídas |
| I3 | Recordatorio mensual deps+restore | `scripts/monthly-admin-reminders.sh` | Olvido de mantenimiento preventivo |
| I4 | CI por PR (typecheck+audit high) | `.github/workflows/ci.yml` | Regresiones/CVEs entrando sin control |

### J. Host VPS (acceso admin)

| # | Control | Dónde | Qué evita / por qué |
|---|---------|-------|---------------------|
| J1 | Fail2ban jail `sshd` | `/etc/fail2ban/jail.local` | Fuerza bruta masiva; ban auto tras fallos |
| J2 | `PasswordAuthentication no` | `sshd_config.d/99-hardening.conf` | Login por password adivinable |
| J3 | `PermitRootLogin no` + `AllowUsers florian` | idem | Root SSH y usuarios no autorizados |
| J4 | UFW: 22 solo IP casa + `100.64.0.0/10` | `ufw` | SSH abierto a todo Internet |
| J5 | UFW: 80/443 Anywhere | `ufw` | Webs/NPM/Stripe webhook siguen vivos |
| J6 | Tailscale (PC + VPS) | Tailscale app | Plano admin por red privada mesh |
| J7 | Acceso ops preferente `100.91.140.107` | runbook §14 | No depender del 22 público |

### Residual (no es "100 %")

| Residual | Por qué queda | Mitigación ops |
|----------|---------------|----------------|
| `.env` en el host | Compose clásico; no Docker Swarm secrets | `chmod 600`, backups off-box, SSH keys + Tailscale |
| NPM / Cloudflare | Fuera del repo | Túnel NPM por Tailscale, Cloudflare en edge |
| IP de casa dinámica | Allowlist UFW | Consola panel + actualizar regla; o SSH solo Tailscale |
| Stripe live smoke | Proceso de negocio | Probar Payment Link → VIP 1 vez |
| Deps futuras | El ecosistema npm cambia | Re-auditar en cada deploy; Dependabot opcional |
| Soft-purge incompleto | Anti-abuso trial | Documentado; no es borrado total GDPR "hard" |
| Scraper sigue con DB+Bright Data | Necesario para ingest | Aislamiento de contenedor + sin bot token |
| App/scraper sin `read_only` | Tooling Prisma / ops | Redis/DB sí endurecidos; no montar docker.sock |

### Verificación rápida (VPS)

```bash
curl -sS http://127.0.0.1:3001/health
curl -sS https://alertasinmobiliaria.florianserb.com/health
# → {"status":"ok"}

npm audit
# → found 0 vulnerabilities

docker compose exec scraper printenv TELEGRAM_BOT_TOKEN   # vacío
docker compose exec scraper printenv STRIPE_SECRET_KEY    # vacío
docker compose exec scraper printenv R2_BUCKET            # vacío
```

---

## 22. Changelog reciente (seguridad + producto)

| Área | Cambio |
|------|--------|
| Host | Fail2ban `sshd` + SSH hardening (sin password, sin root, `AllowUsers`) |
| Host | UFW: SSH solo IP casa + Tailscale; 80/443 públicos |
| Host | Tailscale PC↔VPS; acceso ops por `100.91.140.107` |
| Docs | Runbook PowerShell/Bash; preferir `System32\OpenSSH\ssh.exe` en Windows |
| Seguridad app | Token Telegram / admin fuera del contenedor scraper |
| Seguridad app | `/health` sin memoria, jobs ni conteos de BD |
| Seguridad | R2 API token limitado a IP del VPS |
| Seguridad | Eliminado `better-sqlite3`; override `uuid`; audit limpio |
| IA | Prompt experto; ficha/enlace solo recuperar o link caído; cupo si hay link |
| Filtros | Reset al cambiar ciudad; zonas + Cualquiera; habs `0` = estudio |
| Digests | Warmup 5–15 min (**cuota 24 h**) + cadencia **por usuario** vía `/horario` (default 2 h · 08–21 · hard floor 7–23) |
| Digests | UI `/horario` · prefs `digest_*` en `UsuarioVIP` · visible en `/estado` |
| Digests | Aviso «mismo apartamento, varios anuncios» |
| Admin | Cajita VIP viva (edit) + `/vip_count` + menú scope admin |
| Canal free | Ficha completa **sin** link anuncio; solo CTA VIP |
| Legal | PDF final + `LEGAL_URL` Drive |
| Datos | Enrich Nominatim + CP Rentumo; `AppMeta` |
| Persistencia | Volúmenes Docker named (Postgres/Redis/logs) + backup R2 06:00 |
| Score | Soft-launch ~**96/100** (no 100 % — ver residual §21) |

---

*Última actualización: `/horario` (días/horas/intervalo) + hard floor 7–23, warmup/cuota/cadencia por VIP, cajita VIP admin, canal gratis sin link, textos legales, enrich zonas, volúmenes, catálogo §21, patrones §9.1–9.3.*
