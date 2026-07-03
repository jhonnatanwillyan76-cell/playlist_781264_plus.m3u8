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
      // dedup por NOME+ANO (NÃO por pôster): a MESMA obra reaparece na lista com
      // pôsteres diferentes — a 1ª cópia é a limpa (.mp4 oficial), a 2ª costuma
      // ser um rip com anúncio 1xbet embutido. Chavear por hash deixava as duas
      // passarem (pôsteres != ) e a 2ª vazava só pra aba Filmes (a Home/Busca já
      // resolvem por nome → pegam a 1ª limpa). Nome+ano colapsa todas na 1ª vista.
      const key = `${slug(name)}_${e.year}`;
      if (movieByKey.has(key)) continue; // 1ª vista vence (cópia limpa vem 1º)
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

// ── Enriquecimento de capas de SÉRIE via TMDB ──────────────────────────────
// As capas de série da raw são péssimas: genéricas e REPETIDAS (um mesmo hash
// chega a servir 42 séries diferentes) porque saem do tvg-logo do 1º episódio.
// Aqui buscamos o pôster CERTO por nome no TMDB, mas SÓ pras capas ruins (hash
// compartilhado por ≥2 shows, ou ausente) — as capas únicas da raw costumam já
// estar certas e não vale arriscar trocar. Fail-safe: erro de rede mantém a capa
// atual (nunca derruba o build). A key vem SÓ do env TMDB_KEY (nunca commitada —
// este arquivo mora num repo público); sem ela, o enriquecimento é pulado e as
// capas ficam as da raw. No GitHub Actions passe via secrets.TMDB_KEY.
const TMDB_KEY = process.env.TMDB_KEY || '';
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmdbShowPoster(name, tries = 2) {
  const u = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&language=pt-BR&query=${encodeURIComponent(name)}`;
  const r = await fetch(u);
  if (r.status === 429 && tries > 0) { await _sleep(1500); return tmdbShowPoster(name, tries - 1); }
  if (!r.ok) return null;
  const j = await r.json();
  const hit = (j.results || []).find((x) => x.poster_path);
  return hit ? hit.poster_path.replace(/^\//, '') : null;
}

// Durabilidade SEM key nem ação do usuário: reaproveita os pôsteres do
// series-index.json JÁ publicado (já enriquecidos). Assim uma re-geração do
// Action (cron diário) NÃO volta as capas boas pras ruins da raw quando não há
// TMDB_KEY. Casa por slug (estável). Séries novas (fora do índice antigo) seguem
// pro enriquecimento (se houver key) ou ficam com a capa da raw.
export function reusePosters(shows, prevShows) {
  const bySlug = new Map();
  for (const s of prevShows || []) if (s.poster && s.slug) bySlug.set(s.slug, s.poster);
  let kept = 0;
  for (const s of shows) {
    const p = bySlug.get(s.slug);
    if (p && p !== s.poster) { s.poster = p; kept++; }
  }
  return kept;
}

export async function enrichShowPosters(shows, { concurrency = 10, fetchPoster = tmdbShowPoster } = {}) {
  const cnt = new Map();
  for (const s of shows) if (s.poster) cnt.set(s.poster, (cnt.get(s.poster) || 0) + 1);
  const targets = shows.filter((s) => !s.poster || cnt.get(s.poster) >= 2);
  let i = 0, fixed = 0;
  async function worker() {
    while (i < targets.length) {
      const s = targets[i++];
      try { const p = await fetchPoster(s.name); if (p) { s.poster = p; fixed++; } } catch {}
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { targets: targets.length, fixed };
}

// ── SÉRIES pela API Xtream ──────────────────────────────────────────────────
// A raw M3U traz IDs de episódio de SÉRIE que estão STALE (o painel re-indexou →
// 404 em TODA série). A API Xtream (`player_api.php`) tem os IDs ATUAIS. Aqui
// reconstruímos séries+episódios pela API (URLs que abrem). Movies/live seguem
// da raw (funcionam). Credenciais saem da PRÓPRIA raw (já estão nas URLs).
const XUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function extractCreds(text) {
  const m = text.match(/(https?:\/\/[^/\s]+)\/(?:movie|series)\/([^/]+)\/([^/]+)\//);
  return m ? { host: m[1], user: m[2], pass: m[3] } : null;
}

// Só a LISTA (get_series = 1 chamada, confiável). Os episódios o APP busca
// on-demand por `sid` ao abrir a série (get_series_info) — o painel é instável
// pra puxar os 8k de uma vez (perde ~40%), mas 1 chamada por série abre liso.
export async function buildSeriesFromApi(host, user, pass) {
  const api = async (action, extra = '') => {
    const r = await fetch(`${host}/player_api.php?username=${user}&password=${pass}&action=${action}${extra}`,
      { headers: { 'User-Agent': XUA } });
    if (!r.ok) throw new Error(`api ${action} ${r.status}`);
    return JSON.parse(await r.text());
  };
  const cats = {};
  try { for (const c of await api('get_series_categories')) cats[c.category_id] = c.category_name; } catch {}
  const list = await api('get_series');
  const showBySlug = new Map();
  for (const s of (list || [])) {
    const name = cleanName(s.name || '');
    const sg = slug(name);
    if (!sg || showBySlug.has(sg)) continue;
    showBySlug.set(sg, {
      slug: sg, name, poster: posterHash(s.cover),
      cat: canonCat(cats[s.category_id] || ''),
      sid: s.series_id, // ID Xtream — o app puxa os episódios por ele
      eps: (s.episode_run_time ? 0 : 0), // desconhecido até abrir; UI não depende
    });
  }
  return { shows: [...showBySlug.values()] };
}

// CLI (guarda cross-platform via pathToFileURL)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , input, outDir] = process.argv;
  if (!input || !outDir) { console.error('uso: node build-catalog.mjs <input.m3u8> <outDir>'); process.exit(1); }
  const text = await readFile(input, 'utf8');
  const c = buildCatalog(text);
  // SÉRIES: troca as da raw (IDs stale → 404) pelas da API Xtream (IDs atuais).
  if (process.env.SKIP_SERIES_API !== '1') {
    const creds = extractCreds(text);
    if (creds) {
      try {
        const api = await buildSeriesFromApi(creds.host, creds.user, creds.pass);
        if (api.shows.length) {
          c.shows = api.shows;
          c.episodeBuckets = {}; // episódios são buscados on-demand pelo app (por sid)
          console.log('séries (lista) da API Xtream:', api.shows.length);
        }
      } catch (e) { console.log('API de séries falhou (mantém raw):', e.message); }
    }
  }
  // 1) DURÁVEL: preserva as capas boas já publicadas (sem key, sem rede) — evita
  //    que o cron do Action volte as capas boas pras ruins da raw.
  try {
    const prev = JSON.parse(await readFile(join(outDir, 'series-index.json'), 'utf8')).shows;
    const kept = reusePosters(c.shows, prev);
    if (kept) console.log(`capas de série reaproveitadas do índice publicado: ${kept}`);
  } catch {}
  // 2) Enriquece as que ainda estão ruins (só com TMDB_KEY; cobre série nova).
  if (process.env.SKIP_ENRICH !== '1' && TMDB_KEY) {
    const er = await enrichShowPosters(c.shows);
    console.log('capas de série enriquecidas (TMDB):', er);
  } else {
    console.log('enriquecimento TMDB pulado (sem TMDB_KEY) — capas mantidas do índice publicado/raw.');
  }
  const stats = await writeArtifacts(c, outDir);
  console.log('catálogo gerado:', stats);
}
