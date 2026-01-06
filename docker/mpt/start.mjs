const bundled = './mpt.db.js';

(async () => {
    try {
        const mod = await import(bundled);
        // The bundle exports `startServer` in the original app
        if (mod && typeof mod.startServer === 'function') {
            await mod.startServer(process.env.PORT ? Number(process.env.PORT) : 3000);
            // Keep the process alive; startServer handles the HTTP server
        } else if (mod && typeof mod.default === 'function') {
            // fallback: if default export is a function, call it
            await mod.default();
        } else {
            console.error('No startServer or default function exported from bundle. Exiting.');
            process.exit(1);
        }
    } catch (err) {
        console.error('Failed to start bundled app:', err);
        process.exit(1);
    }
})();

