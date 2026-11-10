// A SOCKS5 proxy that is also the destination: it accepts CONNECT without
// authentication, records how the client named the destination, and answers
// the HTTP request itself. Prints {"port":N} first, then one JSON line per
// CONNECT: {"atyp":"domain"|"ipv4"|"ipv6","host":...,"port":...}.
//
// Answering itself is what makes `.invalid` hosts usable: a page there can
// only load if the browser handed the name to the proxy instead of resolving
// it, so a loaded page is proof that name resolution went through the proxy.
import { createServer } from 'node:net';

const ATYP = { 1: 'ipv4', 3: 'domain', 4: 'ipv6' };

function readExact(socket, size) {
  return new Promise((resolve, reject) => {
    const take = () => {
      const chunk = socket.read(size);
      if (chunk) {
        socket.off('readable', take);
        socket.off('end', ended);
        resolve(chunk);
      }
    };
    const ended = () => reject(new Error('client closed'));
    socket.on('readable', take);
    socket.once('end', ended);
    take();
  });
}

const server = createServer(async (socket) => {
  socket.on('error', () => {});
  try {
    const [, methods] = await readExact(socket, 2);
    await readExact(socket, methods);
    socket.write(Buffer.from([5, 0]));
    const [, command, , atyp] = await readExact(socket, 4);
    let host;
    if (atyp === 1) host = [...(await readExact(socket, 4))].join('.');
    else if (atyp === 3) host = (await readExact(socket, (await readExact(socket, 1))[0])).toString();
    else host = (await readExact(socket, 16)).toString('hex');
    const port = (await readExact(socket, 2)).readUInt16BE(0);
    console.log(JSON.stringify({ atyp: ATYP[atyp] ?? atyp, host, port, command }));
    socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
    socket.once('data', () => {
      const body = `<!doctype html><title>via socks ${host}</title><p>${host}</p>`;
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: close\r\n\r\n${body}`
      );
    });
  } catch {
    socket.destroy();
  }
});

server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
