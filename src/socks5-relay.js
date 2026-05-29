/**
 * Minimal SOCKS5 relay: listens on a local port (no auth required)
 * and forwards connections to an upstream authenticated SOCKS5 proxy.
 *
 * Usage: import { startRelay } from './socks5-relay.js'
 * const { port, stop } = await startRelay('proxyuser', 'pass', 'host', 1080)
 */
import net from 'net';

const SOCKS5 = 5;
const AUTH_NO_AUTH = 0x00;
const AUTH_USER_PASS = 0x02;
const AUTH_NO_ACCEPTABLE = 0xFF;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;

export function startRelay(upstreamUser, upstreamPass, upstreamHost, upstreamPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      handleClient(client, upstreamUser, upstreamPass, upstreamHost, upstreamPort);
    });

    server.on('error', reject);

    // bind on random free port
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        stop: () => server.close(),
      });
    });
  });
}

function handleClient(client, upstreamUser, upstreamPass, upstreamHost, upstreamPort) {
  client.once('data', (buf) => {
    // SOCKS5 greeting: VER NAUTH AUTH...
    if (buf[0] !== SOCKS5) { client.destroy(); return; }

    const nMethods = buf[1];
    const methods = [...buf.slice(2, 2 + nMethods)];
    if (!methods.includes(AUTH_NO_AUTH)) {
      client.write(Buffer.from([SOCKS5, AUTH_NO_ACCEPTABLE]));
      client.destroy();
      return;
    }

    // Accept no-auth
    client.write(Buffer.from([SOCKS5, AUTH_NO_AUTH]));

    client.once('data', (req) => {
      // VER CMD RSV ATYP ...
      if (req[0] !== SOCKS5 || req[1] !== CMD_CONNECT) {
        sendReply(client, REP_GENERAL_FAILURE);
        client.destroy();
        return;
      }

      const atyp = req[3];
      let targetHost, targetPort, offset;

      if (atyp === ATYP_IPV4) {
        targetHost = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
        offset = 8;
      } else if (atyp === ATYP_DOMAIN) {
        const len = req[4];
        targetHost = req.slice(5, 5 + len).toString();
        offset = 5 + len;
      } else if (atyp === ATYP_IPV6) {
        const bytes = req.slice(4, 20);
        targetHost = [...Array(8)].map((_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':');
        offset = 20;
      } else {
        sendReply(client, REP_GENERAL_FAILURE);
        client.destroy();
        return;
      }

      targetPort = req.readUInt16BE(offset);

      connectViaUpstream(client, upstreamUser, upstreamPass, upstreamHost, upstreamPort, targetHost, targetPort);
    });
  });

  client.on('error', () => client.destroy());
}

function connectViaUpstream(client, user, pass, upHost, upPort, targetHost, targetPort) {
  const upstream = net.createConnection(upPort, upHost, () => {
    // SOCKS5 greeting to upstream: offer user/pass auth
    upstream.write(Buffer.from([SOCKS5, 1, AUTH_USER_PASS]));

    upstream.once('data', (buf) => {
      if (buf[0] !== SOCKS5 || buf[1] !== AUTH_USER_PASS) {
        sendReply(client, REP_GENERAL_FAILURE);
        client.destroy(); upstream.destroy(); return;
      }

      // Send user/pass
      const userBuf = Buffer.from(user);
      const passBuf = Buffer.from(pass);
      const authMsg = Buffer.alloc(3 + userBuf.length + passBuf.length);
      authMsg[0] = 0x01;
      authMsg[1] = userBuf.length;
      userBuf.copy(authMsg, 2);
      authMsg[2 + userBuf.length] = passBuf.length;
      passBuf.copy(authMsg, 3 + userBuf.length);
      upstream.write(authMsg);

      upstream.once('data', (authReply) => {
        if (authReply[1] !== 0x00) {
          sendReply(client, REP_GENERAL_FAILURE);
          client.destroy(); upstream.destroy(); return;
        }

        // Send CONNECT request to upstream
        const hostBuf = Buffer.from(targetHost);
        const connectReq = Buffer.alloc(7 + hostBuf.length);
        connectReq[0] = SOCKS5;
        connectReq[1] = CMD_CONNECT;
        connectReq[2] = 0x00;
        connectReq[3] = ATYP_DOMAIN;
        connectReq[4] = hostBuf.length;
        hostBuf.copy(connectReq, 5);
        connectReq.writeUInt16BE(targetPort, 5 + hostBuf.length);
        upstream.write(connectReq);

        upstream.once('data', (connectReply) => {
          if (connectReply[1] !== REP_SUCCESS) {
            sendReply(client, connectReply[1] || REP_GENERAL_FAILURE);
            client.destroy(); upstream.destroy(); return;
          }

          // Tell client we're connected
          sendReply(client, REP_SUCCESS);

          // Pipe both ways
          client.pipe(upstream);
          upstream.pipe(client);

          client.on('close', () => upstream.destroy());
          upstream.on('close', () => client.destroy());
          client.on('error', () => upstream.destroy());
          upstream.on('error', () => client.destroy());
        });
      });
    });
  });

  upstream.on('error', () => {
    sendReply(client, REP_GENERAL_FAILURE);
    client.destroy();
  });
}

function sendReply(socket, rep) {
  socket.write(Buffer.from([SOCKS5, rep, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
}
