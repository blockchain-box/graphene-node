// javascript
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const bundled = './mpt.db.js';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

function normalizeExporter(mod) {
    if (!mod) return null;
    if (typeof mod.startServer === 'function') return { startServer: mod.startServer.bind(mod) };
    if (typeof mod.default === 'function') return { startServer: mod.default.bind(mod) };
    if (typeof mod === 'function') return { startServer: mod.bind(mod) };
    if (mod.default && typeof mod.default.startServer === 'function') return { startServer: mod.default.startServer.bind(mod.default) };
    return null;
}

(async () => {
    try {
        const head = (await readFile(bundled, 'utf8')).slice(0, 2000);
        try {
            const mod = await import(pathToFileURL(bundled).href);
            const runner = normalizeExporter(mod);
            if (!runner) throw new Error('No startServer/default function exported by ESM module.');
            await runner.startServer(PORT);
            return;
        } catch (err) {
            console.error('Import failed:', err && err.message ? err.message : err);
            if (!(err instanceof SyntaxError)) throw err;

            console.error('Bundle head (first 2000 chars):\n', head);
            try {
                const require = createRequire(import.meta.url);
                const modCjs = require(bundled);
                const runner = normalizeExporter(modCjs);
                if (!runner) throw new Error('No startServer/default function exported by CommonJS module.');
                await runner.startServer(PORT);
                return;
            } catch (err2) {
                console.error('Require fallback failed:', err2 && err2.message ? err2.message : err2);
                process.exit(1);
            }
        }
    } catch (err) {
        console.error('Failed to start bundled app:', err && err.message ? err.message : err);
        process.exit(1);
    }
})();
