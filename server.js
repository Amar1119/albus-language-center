import { loadDotEnv, readConfig } from './src/config.js';
import { createApp } from './src/app.js';

await loadDotEnv();
const config = readConfig();
const app = createApp(config);

app.server.listen(config.port, config.host, () => {
  console.log(`\n  Albus Language Center → http://localhost:${config.port}`);
  console.log(`  Админ самбар          → http://localhost:${config.port}/admin`);
  console.log(`  Өгөгдлийн сан         → ${config.dbFile}`);
  if (config.generatedPassword) {
    console.log(`\n  ⚠ ADMIN_PASSWORD тохируулаагүй тул түр нууц үг үүсгэлээ: ${config.adminPassword}`);
    console.log('    .env файлд ADMIN_PASSWORD=... гэж өөрийн нууц үгээ бичнэ үү.\n');
  }
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} — сервер зогсож байна…`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await app.close();
    process.exit(0);
  });
}
