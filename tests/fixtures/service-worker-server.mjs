import { createServer } from 'node:http';

const server = createServer((request, response) => {
  if (request.url === '/sw.js') {
    response.setHeader('content-type', 'text/javascript');
    response.end("self.addEventListener('fetch', () => {});\n");
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.url === '/register') {
    response.end(`<!doctype html><title>Registers</title><script>
      navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready)
        .then(() => { document.title = 'Registered'; });
    </script>`);
    return;
  }
  response.end('<!doctype html><title>Plain</title><main>plain page</main>');
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});

process.once('SIGTERM', () => server.close(() => process.exit(0)));
