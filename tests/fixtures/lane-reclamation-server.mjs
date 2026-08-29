import { createServer } from 'node:http';

const heldResponses = new Set();

const server = createServer((request, response) => {
  if (request.url?.startsWith('/hold')) {
    heldResponses.add(response);
    request.once('close', () => heldResponses.delete(response));
    return;
  }
  if (request.url === '/release') {
    for (const held of heldResponses) held.end('released');
    heldResponses.clear();
    response.end('released');
    return;
  }

  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.url === '/dirty') {
    response.end(`<!doctype html><title>Dirty</title><form>
      <input aria-label="Draft"><button type="reset">Cancelled reset</button>
    </form><script>
      document.querySelector('form').addEventListener('reset', event => event.preventDefault());
    </script>`);
    return;
  }
  if (request.url === '/media') {
    response.end(`<!doctype html><title>Media</title><video></video><script>
      const media = document.querySelector('video');
      Object.defineProperties(media, {
        paused: { get: () => false },
        ended: { get: () => false },
      });
    </script>`);
    return;
  }
  if (request.url === '/slow') {
    response.end('<!doctype html><title>Slow</title><script>void fetch("/hold")</script>');
    return;
  }
  if (request.url === '/beforeunload') {
    response.end(`<!doctype html><title>Before unload</title><button>Arm</button><script>
      addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; });
    </script>`);
    return;
  }
  response.end('<!doctype html><title>Clean</title><main>clean lane</main>');
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});

function stop() {
  for (const response of heldResponses) response.end('server stopping');
  heldResponses.clear();
  server.close(() => process.exit(0));
}

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
