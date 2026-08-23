# Reporte de compatibilidad: sqlite3 → better-sqlite3 / node:sqlite

**Fecha:** 2026-08-23 · **Estado:** solo auditoría, sin migración aplicada.
**Motivación:** el paquete `sqlite3` está archivado upstream (sin mantenimiento).

---

## 1. Resumen ejecutivo

La capa de persistencia es pequeña y homogénea: **16 call-sites callback-style en 7 archivos**
(6 dentro de `src/db/`, 1 fuera: `skill-loader.ts`). No hay transacciones explícitas ni
prepared statements cacheados; los repositorios ya exponen APIs `async` a sus llamadores,
por lo que una migración a better-sqlite3 (síncrono) puede hacerse **sin tocar gateway,
token-budget ni ningún consumidor**. WAL y los índices actuales se preservan tal cual.
Esfuerzo estimado: 0.5–1 día + suite existente como red de seguridad
(`tests/unit/db-repos.test.ts` ejercita SQLite real end-to-end).

---

## 2. Inventario de call-sites que cambian de API

| Archivo | Línea | Llamada actual (callback) | Equivalente nuevo |
|---|---|---|---|
| `src/db/index.ts` | 14 | `new Database.Database(dbPath, cb)` | `new Database(dbPath)` sync |
| `src/db/index.ts` | 20–22 | `db.run('PRAGMA …')` ×3 | `db.pragma('foreign_keys = ON')` etc. |
| `src/db/index.ts` | 59 | `db.run(stmt, cb)` en cadena recursiva (`runSchema`) | un único `db.exec(schema)` — el secuenciador hand-rolled desaparece |
| `src/db/index.ts` | 90 | `db.close(cb)` | `db.close()` sync |
| `src/db/repositories/sessions.ts` | 20 | `db.get(sql, [params], cb)` | `db.prepare(sql).get(...params)` |
| `src/db/repositories/sessions.ts` | 29 | `db.run('INSERT …', [...], cb)` anidado | `db.prepare(sql).run(...)` — la pirámide colapsa a líneas sync |
| `src/db/repositories/sessions.ts` | 55 | `db.run('UPDATE …', cb)` | idem |
| `src/db/repositories/messages.ts` | 10 | `db.run('INSERT …', cb)` | idem |
| `src/db/repositories/messages.ts` | 25 | `db.all('SELECT …', cb)` | `db.prepare(sql).all(...)` |
| `src/db/repositories/commands.ts` | 28 | `db.run('INSERT …', cb)` | idem |
| `src/db/repositories/commands.ts` | 44 | `db.all('SELECT …', cb)` | idem |
| `src/db/repositories/token-usage.ts` | 22 | `db.run('INSERT …', cb)` | idem |
| `src/db/repositories/token-usage.ts` | 33 | `db.get('SELECT COALESCE(SUM…)', cb)` | idem |
| `src/db/repositories/token-usage.ts` | 47 | `db.all('GROUP BY provider', cb)` | idem |
| `src/services/skill-loader.ts` | ~210 | `await new Promise((res, rej) => db.run(upsert, cb))` por skill | `db.prepare(upsert).run(...)` sync — desaparece el wrapper Promise |

**No afectado:** `src/db/session-store.ts` es filesystem JSON puro, no usa sqlite3.

### Cambios transversales

1. **Errores**: callbacks `(err) =>` pasan a excepciones lanzadas. Los `try/catch`
   existentes ya capturan en repositorios y `cacheSkillsInDb`; revisar que cada callback
   con manejo de error tenga su try/catch equivalente.
2. **Firmas públicas**: los métodos de repositorios son `async` hoy. Recomendación:
   mantenerlos async-devolviendo-Promise en la primera pasada (cero impacto en llamadores,
   diff mínimo); sincronizar después si interesa.
3. **Tipos**: sqlite3 incluye los suyos; better-sqlite3 usa `@types/better-sqlite3`;
   node:sqlite requiere `@types/node ≥ 22.5`.

---

## 3. WAL mode e índices

- WAL se fija en un único sitio: `src/db/index.ts:21` (`PRAGMA journal_mode = WAL`),
  junto a `foreign_keys = ON` (L20) y `wal_autocheckpoint = 1000` (L22).
  Los tres PRAGMA existen idénticos en ambos drivers candidatos → **se preservan**.
- Esquema e índices se crean al arranque desde la constante embebida `SCHEMA_SQL`
  (`src/db/schema.ts`), todo con `CREATE ... IF NOT EXISTS`: 6 tablas y 5 índices
  (`idx_messages_session_id`, `idx_messages_created_at`, `idx_command_log_user_id`,
  `idx_command_log_executed_at`, `idx_token_usage_date`). No hay framework de migraciones;
  el DDL es driver-agnóstico → **se preserva sin cambios**.
- El fichero `.db` es formato SQLite estándar: cualquier driver lo abre sin conversión.

---

## 4. Elección de driver

| Criterio | better-sqlite3 | node:sqlite |
|---|---|---|
| Estado | Mantenido activamente, maduro | Nativo; estable en Node ≥23, **experimental en 22.x** (`--experimental-sqlite`) |
| Local (Node 22.14, darwin-arm64) | Prebuilds disponibles ✅ | Incluido con flag ⚠️ |
| Docker (`node:22-alpine`) | Necesita prebuild musl o toolchain (`python3 make g++`); el Dockerfile actual NO lo instala ⚠️ | Sin deps nativas ✅, pero flag experimental en 22.x ⚠️ |
| API | Sync: `prepare/run/get/all/exec/pragma` + helper de transacciones | Sync (`DatabaseSync`), API similar pero más joven |
| Riesgo principal | Build nativo en CI/alpine | Cambios de API mientras sea experimental |

**Recomendación**: `better-sqlite3` para la app (madurez + tests existentes como red),
añadiendo toolchain de build al Dockerfile. Reconsiderar `node:sqlite` cuando la base
pase a `node:24-alpine` (sin flag, cero dependencias nativas).

---

## 5. Plan de rollback

1. **Migración en un único commit/PR** que toque solo los 7 archivos inventariados +
   `package.json`/lockfile + Dockerfile (si better-sqlite3). Nada más.
2. Antes de mergear:
   - `npm test` completo — `tests/unit/db-repos.test.ts` valida CRUD real contra fichero
     temporal (incluye WAL).
   - Añadir un test de humo que abra la DB, escriba, cierre y reabra (simula restart)
     antes de dar por buena la migración.
3. Rollback operativo:
   - `git revert <commit-de-migracion>` + `npm install` + `./deploy.sh`.
   - **No hay paso de datos**: el formato del fichero `alfred.db` es idéntico para ambos
     drivers; ninguna fila escrita por better-sqlite3/node:sqlite impide volver a sqlite3
     o viceversa. El rollback es puramente de código.
   - Ventana de riesgo: solo los cambios de esquema futuros (ninguno hoy — el DDL es el
     mismo) podrían crear incompatibilidades; mantener esa disciplina durante la transición.
4. Señales de alerta post-migración a vigilar 48h: errores `SQLITE_BUSY`/`SQLITE_CORRUPT`
   en logs, crecimiento anómalo del `-wal`, latencias de escritura en `command_log`
   (se escribe en cada exec).

