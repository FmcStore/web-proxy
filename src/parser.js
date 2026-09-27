/**
 * Parser daftar proxy mentah.
 *
 * Format yang didukung (dicampur dalam satu file pun boleh):
 *   1.2.3.4:8080
 *   1.2.3.4,8080
 *   http://1.2.3.4:8080
 *   socks5://1.2.3.4:1080
 *   # komentar (diabaikan)
 */

/** Skema yang dianggap sama dengan http (proxy HTTP yang mendukung SSL/CONNECT). */
const PROTOCOL_ALIASES = {
  http: 'http',
  https: 'http', // list "https" hampir selalu = proxy HTTP biasa yang support CONNECT
  socks: 'socks5',
  socks5: 'socks5',
  socks4: 'socks4',
};

const IP_PORT_RE = /^(\d{1,3}(?:\.\d{1,3}){3})[:,\s](\d{1,5})$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

export function isIpv4(host) {
  return IPV4_RE.test(host);
}

/**
 * Ambil satu entri proxy dari sebuah baris.
 * @returns {{host:string, port:number, protocol:string}|null}
 */
export function parseLine(rawLine, defaultProtocol = 'http') {
  if (!rawLine || typeof rawLine !== 'string') return null;

  let line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;

  // buang komentar inline
  const hashIdx = line.indexOf('#');
  if (hashIdx !== -1) line = line.slice(0, hashIdx).trim();
  if (!line) return null;

  let protocol = defaultProtocol;
  const schemeMatch = line.match(/^([a-z0-9]+):\/\/(.+)$/i);
  if (schemeMatch) {
    const mapped = PROTOCOL_ALIASES[schemeMatch[1].toLowerCase()];
    if (!mapped) return null;
    protocol = mapped;
    line = schemeMatch[2].trim();
  }

  // buang path/query kalau ada, sisakan host:port
  line = line.split(/[/?#]/)[0].trim();

  const match = line.match(IP_PORT_RE);
  if (!match) return null;

  const host = match[1];
  const port = Number(match[2]);
  if (!isIpv4(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { host, port, protocol };
}

/**
 * Parse seluruh isi file/list menjadi array proxy unik.
 * @returns {Array<{host:string, port:number, protocol:string}>}
 */
export function parseProxyList(text, defaultProtocol = 'http', maxItems = Infinity) {
  const out = [];
  const seen = new Set();
  if (!text) return out;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const entry = parseLine(rawLine, defaultProtocol);
    if (!entry) continue;

    const key = `${entry.protocol}://${entry.host}:${entry.port}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push(entry);
    if (out.length >= maxItems) break;
  }

  return out;
}

export const proxyKey = (p) => `${p.protocol}://${p.host}:${p.port}`;
