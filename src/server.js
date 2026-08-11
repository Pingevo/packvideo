import { createApp } from './app.js';
import { config, validateConfig, configWarnings } from './config.js';
import { log } from './log.js';
import { connect, close as closeDb } from './db.js';
import { ensureStorage, storageStatus } from './lib/storage.js';
import { startMonitor } from './lib/monitor.js';
import { startSweeper } from './lib/clips.js';
import { ensureIndexes } from './lib/schema.js';
import { reconcileOrphans } from './lib/repo.js';
import { probeFfmpeg } from './lib/ffmpeg.js';
import { startRetention } from './lib/retention.js';

for (const warning of configWarnings()) log.warn(warning);

const problems = validateConfig();
if (problems.length) {
  log.fatal({ problems }, 'ค่าตั้งไม่ครบ — หยุดทำงาน');
  process.exit(1);
}

const root = await ensureStorage();
const disk = await storageStatus();
log.info(
  { path: root, used_pct: disk.used_pct, free_gb: disk.free_gb, disk_level: disk.disk_level },
  'ที่เก็บคลิปพร้อมใช้งาน',
);
if (!disk.writable) log.error({ error: disk.error }, 'ที่เก็บคลิปเขียนไม่ได้');

// ไม่ await — ต่อ Mongo ไม่ได้ต้องไม่ทำให้บริการไม่ขึ้น (ดูเหตุผลใน db.js)
connect(async () => {
  await ensureIndexes();
  await reconcileOrphans();
}).catch((err) => log.error({ err: err.message }, 'เริ่มการเชื่อมต่อ mongo ไม่สำเร็จ'));

const server = createApp().listen(config.port, () => {
  log.info({ port: config.port, env: config.env, node: process.version }, 'packvideo พร้อมรับงาน');
});

await probeFfmpeg();

startMonitor();
startSweeper();
startRetention();

// การอัปโหลดชิ้นวิดีโอเป็น request สั้นๆ แต่ SSE เป็น request ยาว — ตั้งให้ยาวกว่าค่าปริยาย
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'กำลังปิดระบบ');

  // เผื่อค้าง — ยอมตัดจบดีกว่าค้างจน orchestrator ฆ่าแบบไม่ทันเก็บงาน
  const hardStop = setTimeout(() => {
    log.warn('ปิดไม่ทันใน 10 วินาที — ออกทันที');
    process.exit(1);
  }, 10_000);
  hardStop.unref();

  server.close(async () => {
    await closeDb();
    log.info('ปิดเรียบร้อย');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaughtException');
  shutdown('uncaughtException');
});
