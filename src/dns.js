/**
 * Fmc Proxy - DNS buat browser.
 *
 * Ada dua cara memakai server ini sebagai DNS:
 *
 *  1. DNS-over-HTTPS (DoH) — GET|POST /dns-query  [default: aktif]
 *     Didaftarkan langsung sebagai "Secure DNS / DNS over HTTPS" di browser
 *     (Chrome, Edge, Firefox, Brave, Opera), Wi-Fi Android, atau router yang
 *     mendukung DoH. Seluruh query ikut terenkripsi di dalam HTTPS, jadi
 *     pembajakan/pemblokiran DNS oleh operator tidak berpengaruh.
 *
 *       GET  /dns-query?name=example.com&type=A     -> application/dns-json
 *       GET  /dns-query?dns=<base64url>             -> application/dns-message
 *       POST /dns-query  (application/dns-message)  -> application/dns-message
 *
 *  2. DNS server biasa (UDP + TCP port 53) — DNS_SERVER=true  [default: mati]
 *     Dipakai kalau mau mengarahkan DNS perangkat/router ke IP server ini
 *     (mis. IP LAN: `DNS 1 = 192.168.1.10`). Dinonaktifkan secara default
 *     karena butuh port istimewa (53) dan mayoritas hosting tidak membuka UDP.
 *
 * Inti resolver-nya sama untuk keduanya: resolve lewat `node:dns`, upstream
 * bisa diganti lewat DNS_UPSTREAM (mis. 1.1.1.1,8.8.8.8).
 */

import dns from 'node:dns';
import dgram from 'node:dgram';
import net from 'node:net';
import { config } from './config.js';

// --- tipe record -------------------------------------------------------------
export const TYPES = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  CAA: 257,
  ANY: 255,
};

const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));

/** Nama tipe ("a", "AAAA", "28", …) -> nomor tipe. Kosong = A, tidak dikenal = 0. */
export function typeFromName(value) {
  const key = String(value ?? '').trim().toUpperCase();
  if (key === '') return TYPES.A;
  if (Object.hasOwn(TYPES, key)) return TYPES[key];
  const num = Number(key);
  return Number.isInteger(num) && num > 0 && num < 65536 ? num : 0;
}

/** Nomor tipe -> nama ("A", "AAAA", …). */
export function typeName(code) {
  return TYPE_NAMES[code] || `TYPE${code}`;
}

const OPCODE_QUERY = 0;
const FLAG_QR = 0x8000;
const FLAG_TC = 0x0200;
const FLAG_RD = 0x0100;
const FLAG_RA = 0x0080;
const FLAG_CD = 0x0010;

export const RCODE = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5,
};

// Error `node:dns` -> rcode DNS.
const RCODE_BY_ERROR = {
  ENOTFOUND: RCODE.NOERROR, // nama tidak ada / tidak punya record -> NODATA
  ENODATA: RCODE.NOERROR,
  NODATA: RCODE.NOERROR,
  NONAME: RCODE.NOERROR,
  NOTFOUND: RCODE.NOERROR,
  SERVFAIL: RCODE.SERVFAIL,
  ETIMEOUT: RCODE.SERVFAIL,
  TIMEOUT: RCODE.SERVFAIL,
  ECONNREFUSED: RCODE.SERVFAIL,
  ECONNRESET: RCODE.SERVFAIL,
  EAI_AGAIN: RCODE.SERVFAIL,
  REFUSED: RCODE.REFUSED,
  NOTIMP: RCODE.NOTIMP,
  FORMERR: RCODE.FORMERR,
  BADNAME: RCODE.FORMERR,
};

// --- wire format: decode -----------------------------------------------------

/** Baca nama domain (dukung kompresi pointer) mulai dari `offset`. */
function decodeName(buf, offset) {
  const labels = [];
  let pos = offset;
  let end = -1;
  let jumps = 0;

  for (;;) {
    if (pos >= buf.length) return null;
    const len = buf[pos];

    if (len === 0) {
      pos += 1;
      if (end === -1) end = pos;
      break;
    }

    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) return null;
      const pointer = ((len & 0x3f) << 8) | buf[pos + 1];
      if (end === -1) end = pos + 2;
      if (pointer >= buf.length || jumps++ > 20) return null;
      pos = pointer;
      continue;
    }

    if ((len & 0xc0) !== 0) return null;
    if (pos + 1 + len > buf.length) return null;
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }

  return { name: labels.join('.'), end };
}

/** Lewati satu record (dipakai untuk menelusuri section answer/authority). */
function skipRecord(buf, offset) {
  const name = decodeName(buf, offset);
  if (!name) return -1;
  const start = name.end;
  if (start + 10 > buf.length) return -1;
  const rdlength = buf.readUInt16BE(start + 8);
  const end = start + 10 + rdlength;
  if (end > buf.length) return -1;
  return end;
}

/**
 * Urai pesan DNS. Cukup untuk kebutuhan server: pertanyaan + deteksi EDNS(0) OPT.
 * Return null kalau pesannya rusak.
 */
export function parseMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);
  const nscount = buf.readUInt16BE(8);
  const arcount = buf.readUInt16BE(10);

  if (qdcount < 1) return null;

  let offset = 12;
  const question = { name: '', type: TYPES.A, class: 1 };
  for (let i = 0; i < qdcount; i += 1) {
    const decoded = decodeName(buf, offset);
    if (!decoded) return null;
    offset = decoded.end;
    if (offset + 4 > buf.length) return null;
    if (i === 0) {
      question.name = decoded.name;
      question.type = buf.readUInt16BE(offset);
      question.class = buf.readUInt16BE(offset + 2);
    }
    offset += 4;
  }

  for (let i = 0; i < ancount + nscount; i += 1) {
    offset = skipRecord(buf, offset);
    if (offset === -1) return null;
  }

  let opt = null;
  for (let i = 0; i < arcount; i += 1) {
    const decoded = decodeName(buf, offset);
    if (!decoded) return null;
    const start = decoded.end;
    if (start + 10 > buf.length) return null;
    const type = buf.readUInt16BE(start);
    const klass = buf.readUInt16BE(start + 2);
    const rdlength = buf.readUInt16BE(start + 8);
    offset = start + 10 + rdlength;
    if (offset > buf.length) return null;
    if (type === 41) opt = { udpSize: Math.max(512, klass) };
  }

  return {
    id,
    flags,
    opcode: (flags >> 11) & 0x0f,
    question,
    opt,
    edns: Boolean(opt),
  };
}

// --- wire format: encode -----------------------------------------------------

/** Domain ("example.com" / "example.com.") -> bytes label DNS. */
function encodeName(name) {
  const clean = String(name || '').replace(/\.$/, '');
  if (clean === '') return Buffer.from([0]);

  const parts = [];
  for (const label of clean.split('.')) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length === 0 || bytes.length > 63) return null;
    parts.push(Buffer.from([bytes.length]), bytes);
  }

  const body = Buffer.concat(parts);
  if (body.length + 1 > 255) return null;
  return Buffer.concat([body, Buffer.from([0])]);
}

/** Alamat IPv6 ("2606:4700::1111", "::ffff:1.2.3.4") -> 16 byte. */
function ipv6ToBuffer(address) {
  let host = String(address || '').trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.split('%')[0];
  if (!host.includes(':')) return null;

  const lastColon = host.lastIndexOf(':');
  if (host.slice(lastColon + 1).includes('.')) {
    const parts = host.slice(lastColon + 1).split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const high = ((parts[0] << 8) | parts[1]).toString(16);
    const low = ((parts[2] << 8) | parts[3]).toString(16);
    host = `${host.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = host.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;

  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }

  if (groups.length !== 8) return null;

  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
    buf.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  }
  return buf;
}

const toUint32 = (value) => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 0xffffffff);
};

/** RDATA sesuai tipe. Return null kalau data tidak bisa dikodekan. */
function encodeRdata(rr) {
  const data = rr.data;

  switch (rr.type) {
    case TYPES.A: {
      const parts = String(data).split('.').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return null;
      }
      return Buffer.from(parts);
    }
    case TYPES.AAAA:
      return ipv6ToBuffer(data);
    case TYPES.NS:
    case TYPES.CNAME:
    case TYPES.PTR:
      return encodeName(data);
    case TYPES.TXT: {
      const chunks = Array.isArray(data) ? data : [String(data)];
      const parts = [];
      for (const chunk of chunks) {
        const bytes = Buffer.from(String(chunk), 'utf8');
        for (let i = 0; i < bytes.length; i += 255) {
          const slice = bytes.subarray(i, i + 255);
          parts.push(Buffer.from([slice.length]), slice);
        }
      }
      if (parts.length === 0) parts.push(Buffer.from([0]));
      return Buffer.concat(parts);
    }
    case TYPES.MX: {
      const name = encodeName(data.exchange);
      if (!name) return null;
      const head = Buffer.alloc(2);
      head.writeUInt16BE(Number(data.priority) || 0);
      return Buffer.concat([head, name]);
    }
    case TYPES.SRV: {
      const name = encodeName(data.target);
      if (!name) return null;
      const head = Buffer.alloc(6);
      head.writeUInt16BE(Number(data.priority) || 0, 0);
      head.writeUInt16BE(Number(data.weight) || 0, 2);
      head.writeUInt16BE(Number(data.port) || 0, 4);
      return Buffer.concat([head, name]);
    }
    case TYPES.SOA: {
      const mname = encodeName(data.nsname);
      const rname = encodeName(data.hostmaster);
      if (!mname || !rname) return null;
      const nums = Buffer.alloc(20);
      nums.writeUInt32BE(toUint32(data.serial), 0);
      nums.writeUInt32BE(toUint32(data.refresh), 4);
      nums.writeUInt32BE(toUint32(data.retry), 8);
      nums.writeUInt32BE(toUint32(data.expire), 12);
      nums.writeUInt32BE(toUint32(data.minttl), 16);
      return Buffer.concat([mname, rname, nums]);
    }
    case TYPES.CAA: {
      const tag = Buffer.from(String(data.tag || ''), 'latin1').subarray(0, 255);
      if (tag.length === 0) return null;
      const value = Buffer.from(String(data.value ?? ''), 'utf8');
      return Buffer.concat([Buffer.from([Number(data.flags) || 0, tag.length]), tag, value]);
    }
    default:
      return null;
  }
}

function buildResponse(message, result, { maxSize, answers = [], tc = false }) {
  const question = message.question;
  const questionName = encodeName(question.name);
  if (!questionName) return null;

  const questionSection = Buffer.alloc(4);
  questionSection.writeUInt16BE(question.type, 0);
  questionSection.writeUInt16BE(question.class || 1, 2);

  const rdataList = [];
  for (const rr of answers) {
    const rdata = encodeRdata(rr);
    if (!rdata) continue;
    const nameBuf =
      String(rr.name).toLowerCase() === String(question.name).toLowerCase()
        ? Buffer.from([0xc0, 0x0c]) // pointer ke nama di question section
        : encodeName(rr.name);
    if (!nameBuf) continue;

    const head = Buffer.alloc(10);
    head.writeUInt16BE(rr.type, 0);
    head.writeUInt16BE(1, 2); // IN
    head.writeUInt32BE(toUint32(rr.ttl) || config.dnsTtl, 4);
    head.writeUInt16BE(rdata.length, 8);
    rdataList.push(Buffer.concat([nameBuf, head, rdata]));
  }

  // Balas OPT kalau penanya memakai EDNS(0) — supaya client besar tetap senang.
  const optBuf = message.edns
    ? Buffer.concat([
        Buffer.from([0]),
        (() => {
          const head = Buffer.alloc(10);
          head.writeUInt16BE(41, 0); // OPT
          head.writeUInt16BE(config.dnsMaxUdpSize, 2);
          head.writeUInt32BE(0, 4);
          head.writeUInt16BE(0, 8);
          return head;
        })(),
      ])
    : null;

  const header = Buffer.alloc(12);
  header.writeUInt16BE(message.id, 0);
  header.writeUInt16BE(
    FLAG_QR |
      FLAG_RA |
      (message.flags & (FLAG_RD | FLAG_CD)) |
      (tc ? FLAG_TC : 0) |
      (result.rcode & 0x0f),
    2
  );
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(rdataList.length, 6); // ancount
  header.writeUInt16BE(0, 8); // nscount
  header.writeUInt16BE(optBuf ? 1 : 0, 10); // arcount

  const parts = [header, questionName, questionSection, ...rdataList];
  if (optBuf) parts.push(optBuf);
  const buf = Buffer.concat(parts);

  return buf.length > maxSize ? null : buf;
}

/** Ubah hasil resolver jadi pesan DNS siap kirim. */
export function encodeResponse(message, result, { maxSize = 65535 } = {}) {
  const full = buildResponse(message, result, { maxSize, answers: result.answers });
  if (full) return full;

  // Terlalu besar untuk transport ini -> tandai TC, client akan ulang via TCP.
  const truncated = buildResponse(message, result, { maxSize, answers: [], tc: true });
  if (truncated) return truncated;

  return buildResponse(message, { rcode: RCODE.SERVFAIL }, { maxSize, answers: [], tc: true });
}

// --- resolver ----------------------------------------------------------------

let resolver = null;

function getResolver() {
  if (!resolver) {
    resolver = new dns.promises.Resolver({
      timeout: config.dnsTimeoutMs,
      tries: 2,
    });
    if (config.dnsUpstream.length > 0) {
      try {
        resolver.setServers(config.dnsUpstream);
      } catch {
        // upstream tidak valid -> biarkan pakai DNS default container/host
      }
    }
  }
  return resolver;
}

/** Record hasil `resolveAny()` -> bentuk internal. */
function fromAny(name, ttl, record) {
  const base = { name, ttl: ttl || config.dnsTtl };

  switch (record.type) {
    case 'A':
    case 'AAAA':
      return { ...base, type: TYPES[record.type], data: record.address };
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return { ...base, type: TYPES[record.type], data: record.value };
    case 'MX':
      return { ...base, type: TYPES.MX, data: { priority: record.priority, exchange: record.exchange } };
    case 'TXT':
      return { ...base, type: TYPES.TXT, data: record.entries };
    case 'SRV':
      return {
        ...base,
        type: TYPES.SRV,
        data: { priority: record.priority, weight: record.weight, port: record.port, target: record.name },
      };
    case 'SOA':
      return {
        ...base,
        type: TYPES.SOA,
        data: {
          nsname: record.nsname,
          hostmaster: record.hostmaster || record.hostname,
          serial: record.serial,
          refresh: record.refresh,
          retry: record.retry,
          expire: record.expire,
          minttl: record.minttl,
        },
      };
    case 'CAA': {
      const key = ['issue', 'issuewild', 'iodef'].find((k) => record[k] !== undefined) || 'issue';
      return {
        ...base,
        type: TYPES.CAA,
        data: { flags: record.critical || 0, tag: key, value: record[key] || '' },
      };
    }
    default:
      return null;
  }
}

/** Ambil record dari upstream. Throw kalau tipe tidak didukung. */
async function lookupRecords(name, type) {
  const dnsResolver = getResolver();
  const jitter = config.dnsTtl;
  const rows = (list, map) =>
    list.map((item) => ({ name, type, ttl: item.ttl || jitter, data: map(item) }));

  switch (type) {
    case TYPES.A: {
      const list = await dnsResolver.resolve4(name, { ttl: true });
      return rows(list, (r) => r.address);
    }
    case TYPES.AAAA: {
      const list = await dnsResolver.resolve6(name, { ttl: true });
      return rows(list, (r) => r.address);
    }
    case TYPES.CNAME:
      return rows(await dnsResolver.resolveCname(name), (r) => r);
    case TYPES.NS:
      return rows(await dnsResolver.resolveNs(name), (r) => r);
    case TYPES.PTR:
      return rows(await dnsResolver.resolvePtr(name), (r) => r);
    case TYPES.MX:
      return rows(await dnsResolver.resolveMx(name), (r) => ({
        priority: r.priority,
        exchange: r.exchange,
      }));
    case TYPES.TXT:
      return rows(await dnsResolver.resolveTxt(name), (r) => r);
    case TYPES.SOA: {
      const soa = await dnsResolver.resolveSoa(name);
      return [
        {
          name,
          type,
          ttl: jitter,
          data: {
            nsname: soa.nsname,
            hostmaster: soa.hostmaster || soa.hostname,
            serial: soa.serial,
            refresh: soa.refresh,
            retry: soa.retry,
            expire: soa.expire,
            minttl: soa.minttl,
          },
        },
      ];
    }
    case TYPES.SRV:
      return rows(await dnsResolver.resolveSrv(name), (r) => ({
        priority: r.priority,
        weight: r.weight,
        port: r.port,
        target: r.name,
      }));
    case TYPES.CAA:
      return rows(await dnsResolver.resolveCaa(name), (r) => {
        const key = ['issue', 'issuewild', 'iodef'].find((k) => r[k] !== undefined) || 'issue';
        return { flags: r.critical || 0, tag: key, value: r[key] || '' };
      });
    case TYPES.ANY: {
      const list = await dnsResolver.resolveAny(name);
      return list.map((r) => fromAny(name, jitter, r)).filter(Boolean);
    }
    default: {
      const err = new Error(`Tipe record ${typeName(type)} belum didukung.`);
      err.code = 'ENOTSUP';
      throw err;
    }
  }
}

/**
 * Resolve nama -> { rcode, answers }.
 * Nama yang tidak ada tetap dijawab NOERROR tanpa answer (NODATA).
 */
export async function resolveQuery(name, type) {
  const question = String(name || '').trim();
  if (!question) return { rcode: RCODE.FORMERR, answers: [] };

  try {
    const answers = await lookupRecords(question, type);
    return { rcode: RCODE.NOERROR, answers };
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOTSUP') return { rcode: RCODE.NOTIMP, answers: [] };
    return { rcode: RCODE_BY_ERROR[code] ?? RCODE.SERVFAIL, answers: [] };
  }
}

// --- format JSON (kompatibel Google / Cloudflare DoH JSON) --------------------

const fqdn = (name) => (name ? `${String(name).replace(/\.$/, '')}.` : '.');

function dataToString(rr) {
  switch (rr.type) {
    case TYPES.TXT: {
      const chunks = Array.isArray(rr.data) ? rr.data : [rr.data];
      return chunks.map((c) => `"${String(c)}"`).join(' ');
    }
    case TYPES.MX:
      return `${rr.data.priority} ${fqdn(rr.data.exchange)}`;
    case TYPES.SRV:
      return `${rr.data.priority} ${rr.data.weight} ${rr.data.port} ${fqdn(rr.data.target)}`;
    case TYPES.SOA:
      return [
        fqdn(rr.data.nsname),
        fqdn(rr.data.hostmaster),
        rr.data.serial,
        rr.data.refresh,
        rr.data.retry,
        rr.data.expire,
        rr.data.minttl,
      ].join(' ');
    case TYPES.CAA:
      return `${rr.data.flags} ${rr.data.tag} "${rr.data.value}"`;
    case TYPES.NS:
    case TYPES.CNAME:
    case TYPES.PTR:
      return fqdn(rr.data);
    default:
      return String(rr.data);
  }
}

/** Jawaban versi JSON (`application/dns-json`) ala DoH Google/Cloudflare. */
export async function resolveJson(name, typeNameOrCode) {
  const type = typeof typeNameOrCode === 'number' ? typeNameOrCode : typeFromName(typeNameOrCode);
  const { rcode, answers } = await resolveQuery(name, type);

  const payload = {
    Status: rcode,
    TC: false,
    RD: true,
    RA: true,
    AD: false,
    CD: false,
    Question: [{ name: fqdn(name), type }],
  };

  if (answers.length > 0) {
    payload.Answer = answers.map((rr) => ({
      name: fqdn(rr.name),
      type: rr.type,
      TTL: rr.ttl,
      data: dataToString(rr),
    }));
  }

  return payload;
}

// --- DNS-over-HTTPS ----------------------------------------------------------

function base64UrlToBuffer(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function minTtl(answers, fallback) {
  if (!answers || answers.length === 0) return fallback;
  return Math.max(1, Math.min(...answers.map((rr) => Number(rr.ttl) || fallback)));
}

async function answerMessage(payload, maxSize) {
  const message = parseMessage(payload);
  if (!message) return { error: 'Pesan DNS tidak valid.' };

  const result =
    message.opcode === OPCODE_QUERY
      ? await resolveQuery(message.question.name, message.question.type)
      : { rcode: RCODE.NOTIMP, answers: [] };

  const wire = encodeResponse(message, result, { maxSize });
  if (!wire) return { error: 'Gagal menyusun respons DNS.' };
  return { wire, ttl: minTtl(result.answers, config.dnsTtl) };
}

/**
 * Handler Express untuk `/dns-query` (RFC 8484 + format JSON Google/Cloudflare).
 */
export async function handleDoh(req, res) {
  // 1) GET ?dns=<base64url> — wireformat (dipakai browser DoH)
  if (req.method === 'GET' && req.query.dns) {
    let payload;
    try {
      payload = base64UrlToBuffer(req.query.dns);
    } catch {
      return res.status(400).json({ ok: false, error: 'Parameter "dns" bukan base64url yang valid.' });
    }
    return sendWire(res, payload);
  }

  // 2) GET ?name=example.com&type=A — JSON
  if (req.method === 'GET' && req.query.name) {
    const answer = await resolveJson(String(req.query.name), String(req.query.type || 'A'));
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.type('application/dns-json').send(answer);
  }

  // 3) POST dengan body wireformat (dipakai browser DoH)
  if (req.method === 'POST' || req.method === 'PUT') {
    let body = null;
    if (Buffer.isBuffer(req.body)) body = req.body;
    else if (typeof req.body === 'string') body = Buffer.from(req.body, 'binary');
    if (!body || body.length < 12) {
      return res.status(400).json({
        ok: false,
        error: 'Kirim pesan DNS biner dengan Content-Type: application/dns-message.',
      });
    }
    return sendWire(res, body);
  }

  return res.status(400).json({
    ok: false,
    error: 'Format tidak dikenali.',
    contoh: {
      json: '/dns-query?name=example.com&type=A',
      wire: '/dns-query?dns=<base64url pesan DNS>',
      post: 'POST /dns-query  (Content-Type: application/dns-message)',
    },
  });
}

async function sendWire(res, payload) {
  const answer = await answerMessage(payload, 65535);
  if (answer.error) {
    return res.status(400).json({ ok: false, error: answer.error });
  }
  res.setHeader('Content-Type', 'application/dns-message');
  res.setHeader('Cache-Control', `public, max-age=${answer.ttl}`);
  return res.send(answer.wire);
}

// --- DNS server biasa (UDP + TCP) -------------------------------------------

let udpServer = null;
let tcpServer = null;

async function answerForTransport(payload, limit) {
  const answer = await answerMessage(payload, limit);
  return answer.wire || null;
}

/**
 * Nyalakan DNS server UDP+TCP. Return null kalau dinonaktifkan (DNS_SERVER=false).
 */
export function startDnsServer() {
  if (!config.dnsServer) return null;

  const family = config.dnsHost.includes(':') ? 'udp6' : 'udp4';
  udpServer = dgram.createSocket(family);
  udpServer.on('message', async (msg, rinfo) => {
    try {
      const answer = await answerForTransport(msg, config.dnsMaxUdpSize);
      if (answer) udpServer.send(answer, rinfo.port, rinfo.address);
    } catch (err) {
      console.error(`[dns] gagal menjawab UDP: ${err.message}`);
    }
  });
  udpServer.on('error', (err) => console.error(`[dns] UDP error: ${err.message}`));
  udpServer.bind(config.dnsPort, config.dnsHost, () => {
    console.log(`DNS server (UDP) mendengarkan di ${config.dnsHost}:${config.dnsPort}`);
  });

  tcpServer = net.createServer((socket) => {
    let pending = Buffer.alloc(0);

    socket.on('data', async (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const length = pending.readUInt16BE(0);
        if (pending.length < 2 + length) break;
        const payload = pending.subarray(2, 2 + length);
        pending = pending.subarray(2 + length);

        try {
          const answer = await answerForTransport(payload, 65535);
          if (!answer) continue;
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(answer.length);
          socket.write(Buffer.concat([prefix, answer]));
        } catch (err) {
          console.error(`[dns] gagal menjawab TCP: ${err.message}`);
        }
      }
    });

    socket.on('error', () => socket.destroy());
  });
  tcpServer.on('error', (err) => console.error(`[dns] TCP error: ${err.message}`));
  tcpServer.listen(config.dnsPort, config.dnsHost, () => {
    console.log(`DNS server (TCP) mendengarkan di ${config.dnsHost}:${config.dnsPort}`);
  });

  return {
    close() {
      try {
        udpServer?.close();
      } catch {
        /* sudah tertutup */
      }
      try {
        tcpServer?.close();
      } catch {
        /* sudah tertutup */
      }
    },
  };
}
