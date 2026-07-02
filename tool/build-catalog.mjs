// Pipeline: lê a raw M3U Xtream e produz catálogo JSON enxuto (sem deps externas).

const JUNK = ['doação','doacao','pix','test chama','quer um test','usem o apk',
  'atualizado','novidades','canal do usuário','canal do usuario','whats','manotv',
  '+vpn','warp','grupo vip','telegram','aviso'];
const PHONE = /\d{2}\s?9?\d{4}[\s-]?\d{4}/;
const DATE = /\b\d{2}\/\d{2}\/\d{2,4}\b/;

export function isJunk(name, group) {
  if (PHONE.test(name) || DATE.test(name)) return true;
  const hay = `${name.toLowerCase()} ${group.toLowerCase()}`;
  return JUNK.some((w) => hay.includes(w));
}

function attr(line, key) {
  const m = line.match(new RegExp(`${key}="([^"]*)"`, 'i'));
  return m ? m[1].trim() : null;
}

// PRESERVA o case original do hash: o TMDB é case-sensitive na URL da imagem
// (8HzA55… funciona; 8hza55… dá 404). Minúsculo é só p/ chave de dedup/casamento.
export function posterHash(url) {
  if (!url || !url.includes('image.tmdb.org')) return null;
  const seg = url.split('?')[0].split('/').pop().trim();
  return seg.includes('.') ? seg : null;
}

export function cleanName(raw) {
  return raw.replace(/\[[^\]]*\]/g, ' ')
    .replace(/\(\s*\d{4}\s*\)\s*$/, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function extractYear(name) {
  const m = name.match(/\((\d{4})\)/);
  const y = m ? parseInt(m[1], 10) : 0;
  return y >= 1900 && y <= 2100 ? y : 0;
}

export function canonCat(raw) {
  let s = (raw || '').replace(/[^A-Za-zÀ-ÿ0-9|\s]/g, ' ');
  s = s.replace(/^\s*(filmes|s[eé]ries?)\s*\|\s*/i, '');
  s = s.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return 'Geral';
  return s.split(' ').map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(' ');
}

export function parseEpisode(name) {
  let m = name.match(/^(.*?)[\s\-_.:]+[sStT](\d{1,3})\s*[eE](\d{1,4})\b(.*)$/);
  if (!m) m = name.match(/^(.*?)[\s\-_.:]+(\d{1,3})[xX](\d{1,4})\b(.*)$/);
  if (!m) return null;
  const show = m[1].trim();
  if (!show) return null;
  const tail = (m[4] || '').trim().replace(/^[\-:\s.]+/, '').trim();
  return { show, season: parseInt(m[2], 10) || 1, episode: parseInt(m[3], 10) || 1, title: tail || null };
}

export function slug(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function streamType(url) {
  const p = url.toLowerCase().split('?')[0];
  if (p.includes('.m3u8')) return 'hls';
  if (p.endsWith('.ts')) return 'ts';
  return 'mpegts';
}

export function parseEntries(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let name = null, logo = null, group = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toUpperCase().startsWith('#EXTINF')) {
      logo = attr(line, 'tvg-logo');
      group = attr(line, 'group-title') || '';
      const tvg = attr(line, 'tvg-name');
      const comma = line.indexOf(',');
      name = (tvg && tvg.length) ? tvg : (comma >= 0 ? line.slice(comma + 1).trim() : '');
    } else if (line.startsWith('#')) {
      continue;
    } else {
      const url = line;
      const nm = (name || '').trim();
      const gp = (group || '').trim();
      const lg = (logo && logo.length) ? logo : null;
      name = logo = group = null;
      if (!nm || isJunk(nm, gp)) continue;
      const lu = url.toLowerCase();
      const ep = parseEpisode(nm);
      let type;
      if (lu.includes('/series/') || ep) type = 'series';
      else if (lu.includes('/movie/')) type = 'movie';
      else if (/\.(ts)$/.test(lu) || /\/\d+\/\d+\/\d+$/.test(lu.split('?')[0])) type = 'live';
      else continue;
      out.push({ type, name: nm, logo: lg, group: gp, url, st: streamType(url),
        year: extractYear(nm), posterHash: posterHash(lg), ep });
    }
  }
  return out;
}

function streamId(url) {
  return url.split('?')[0].split('/').pop().replace(/\.[a-z0-9]+$/i, '');
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function buildCatalog(text, { buckets = 64 } = {}) {
  const entries = parseEntries(text);
  const live = [];
  const movieByKey = new Map();   // dedupKey → movie
  const showBySlug = new Map();   // slug → show
  const episodeBuckets = {};

  for (const e of entries) {
    if (e.type === 'live') {
      const id = `m3u_${slug(e.name)}`;
      live.push({ id, name: e.name, logo: e.logo, group: canonCat(e.group), url: e.url, type: e.st });
    } else if (e.type === 'movie') {
      const name = cleanName(e.name);
      // dedup: chave em MINÚSCULO (case-insensitive); o poster guardado mantém o case.
      const key = (e.posterHash ? e.posterHash.toLowerCase() : null) || `${slug(name)}_${e.year}`;
      if (movieByKey.has(key)) continue; // 1ª vista vence (dublado/cinema costuma vir 1º)
      movieByKey.set(key, {
        id: `m_${streamId(e.url)}`, name, year: e.year,
        poster: e.posterHash, cat: canonCat(e.group), url: e.url,
      });
    } else { // series
      const show = (e.ep && e.ep.show) ? e.ep.show : cleanName(e.name);
      const sg = slug(show);
      let sh = showBySlug.get(sg);
      if (!sh) {
        const bucket = hashStr(sg) % buckets;
        sh = { slug: sg, name: show, poster: e.posterHash, cat: canonCat(e.group), eps: 0, bucket };
        showBySlug.set(sg, sh);
      }
      const bk = (episodeBuckets[sh.bucket] ??= {});
      const list = (bk[sg] ??= []);
      list.push({ s: e.ep?.season ?? 1, e: e.ep?.episode ?? (list.length + 1), t: e.ep?.title ?? `Episódio ${list.length + 1}`, url: e.url });
      sh.eps = list.length;
    }
  }

  for (const bk of Object.values(episodeBuckets))
    for (const eps of Object.values(bk))
      eps.sort((a, b) => a.s !== b.s ? a.s - b.s : a.e - b.e);

  return { live, movies: [...movieByKey.values()], shows: [...showBySlug.values()], episodeBuckets };
}

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function writeArtifacts(c, outDir) {
  await mkdir(join(outDir, 'series'), { recursive: true });
  const stamp = process.env.CATALOG_TS || ''; // data injetada via env p/ reprodutibilidade
  const meta = { v: 1, generated_at: stamp };
  await writeFile(join(outDir, 'live.json'), JSON.stringify({ ...meta, channels: c.live }));
  await writeFile(join(outDir, 'movies.json'), JSON.stringify({ ...meta, movies: c.movies }));
  await writeFile(join(outDir, 'series-index.json'), JSON.stringify({ ...meta, shows: c.shows }));
  for (const [n, shows] of Object.entries(c.episodeBuckets))
    await writeFile(join(outDir, 'series', `${n}.json`), JSON.stringify({ v: 1, shows }));
  return { live: c.live.length, movies: c.movies.length, shows: c.shows.length, buckets: Object.keys(c.episodeBuckets).length };
}

// CLI (guarda cross-platform via pathToFileURL)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , input, outDir] = process.argv;
  if (!input || !outDir) { console.error('uso: node build-catalog.mjs <input.m3u8> <outDir>'); process.exit(1); }
  const text = await readFile(input, 'utf8');
  const stats = await writeArtifacts(buildCatalog(text), outDir);
  console.log('catálogo gerado:', stats);
}
