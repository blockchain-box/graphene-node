import http from 'http';

export function createHealthServer(healthCheck) {
  const port = parseInt(process.env.HEALTH_PORT || '3001', 10);

  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }

    if (req.url === '/readyz' || req.url === '/status') {
      try {
        const result = await healthCheck();
        const statusCode = req.url === '/status' ? 200 : result.ready ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ready: false, error: err.message }));
      }
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    console.log(`[${new Date().toISOString()}] [INFO] Health server listening on port ${port}`);
  });

  return server;
}
