/**
 * Jalankan satu siklus refresh lalu keluar.
 * Berguna untuk cron / job terjadwal di luar container long-running.
 *
 *   npm run refresh
 */

import { ProxyService } from './service.js';

const service = new ProxyService();
service.store.load();

const result = await service.refresh('cli');
console.log(JSON.stringify(result, null, 2));

service.store.save();
process.exit(result.ok ? 0 : 1);
