import { createServer } from 'node:http';

// One server, two sites: a page on 127.0.0.1 framing a child on localhost puts
// the child in its own renderer process (an out-of-process iframe), the way a
// payment iframe from another domain is on a real site.
const server = createServer((request, response) => {
  response.setHeader('cache-control', 'no-store');
  const path = new URL(request.url, 'http://fixture').pathname;
  if (path === '/ping') {
    response.setHeader('content-type', 'text/plain');
    response.end('pong');
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (path === '/child') {
    response.end('<!doctype html><title>Child</title><main>child frame</main>');
    return;
  }
  const { port } = server.address();
  // The frame is added after the page has loaded, so it attaches after the
  // lane's driver has finished connecting, as a payment widget does.
  response.end(`<!doctype html><title>Waiting</title><script>
    addEventListener('load', () => setTimeout(() => {
      const frame = document.createElement('iframe');
      frame.src = 'http://localhost:${port}/child';
      frame.onload = () => {
        document.title = 'Framed';
        fetch('/ping').then((r) => r.text()).then((text) => { document.title = 'Fetched ' + text; });
      };
      document.body.append(frame);
    }, 1000));
  </script>`);
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});

process.once('SIGTERM', () => server.close(() => process.exit(0)));
