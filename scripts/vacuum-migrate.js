const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(
  process.argv[2] || process.env.ALFRED_DB || path.join(__dirname, '..', 'workspace', 'db', 'alfred.db')
);

if (!fs.existsSync(dbPath)) {
  console.error(`[vacuum-migrate] DB not found: ${dbPath}`);
  process.exit(1);
}

const sizeBefore = fs.statSync(dbPath).size;
const db = new Database(dbPath);

try {
  const before = db.prepare('PRAGMA page_count;').get();
  const freelistBefore = db.prepare('PRAGMA freelist_count;').get();
  console.log(`[vacuum-migrate] before: bytes=${sizeBefore} pages=${before.page_count} freelist=${freelistBefore.freelist_count}`);

  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec('VACUUM');

  const after = db.prepare('PRAGMA page_count;').get();
  const autoVacuum = db.prepare('PRAGMA auto_vacuum;').get();
  console.log(`[vacuum-migrate] after: pages=${after.page_count} auto_vacuum=${autoVacuum.auto_vacuum} (0=NONE 1=FULL 2=INCREMENTAL)`);
} catch (err) {
  if (err.code === 'SQLITE_BUSY') {
    console.error('[vacuum-migrate] SQLITE_BUSY — stop Alfred first (the DB is locked by a running instance), then re-run.');
    process.exit(2);
  }
  throw err;
} finally {
  db.close();
}

const sizeAfter = fs.statSync(dbPath).size;
console.log(`[vacuum-migrate] done: bytes ${sizeBefore} -> ${sizeAfter} (${dbPath})`);
