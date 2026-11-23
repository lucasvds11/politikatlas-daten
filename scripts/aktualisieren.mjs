// Politikatlas Daten
// Holt alle Quellen, bereitet sie auf und schreibt statische JSON-Dateien nach ./public.
// Lauf: node scripts/aktualisieren.mjs   (Node 20+, keine Abhängigkeiten)
// Optionales Secret: DIP_KEY (Bundestag DIP)

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UA = "Politikatlas/1.0 (+https://politikatlas.com)";
const CACHE = ".cache";
const OUT = "public";
const TOLERANZ_MS = 5 * 60 * 1000;

const QUELLEN = {
  dawum: { name: "DAWUM", url: "https://dawum.de/", lizenz: "ODbL 1.0", lizenzUrl: "https://opendatacommons.org/licenses/odbl/1-0/" },
  bundestakt: { name: "Bundestakt", url: "https://www.bundestakt.de/api-doku", lizenz: "CC BY 4.0", lizenzUrl: "https://creativecommons.org/licenses/by/4.0/" },
  bundestag: { name: "Deutscher Bundestag – Parteispenden über 50.000 €", url: "https://www.bundestag.de/parlament/praesidium/parteienfinanzierung/fundstellen50000", lizenz: null, lizenzUrl: null },
  eurostat: { name: "Eurostat", url: "https://ec.europa.eu/eurostat", lizenz: null, lizenzUrl: null },
  weltbank: { name: "Weltbank", url: "https://data.worldbank.org/", lizenz: "CC BY 4.0", lizenzUrl: "https://creativecommons.org/licenses/by/4.0/" },
  abgeordnetenwatch: { name: "abgeordnetenwatch.de", url: "https://www.abgeordnetenwatch.de/api", lizenz: null, lizenzUrl: null },
  dip: { name: "DIP – Deutscher Bundestag", url: "https://search.dip.bundestag.de/api/v1/swagger-ui/", lizenz: null, lizenzUrl: null },
};

const FEEDS = {
  spiegel: { name: "SPIEGEL", feed: "https://www.spiegel.de/politik/index.rss", seite: "https://www.spiegel.de/politik" },
  zeit: { name: "ZEIT", feed: "https://newsfeed.zeit.de/politik/index", seite: "https://www.zeit.de/politik/index" },
  faz: { name: "FAZ", feed: "https://www.faz.net/rss/aktuell/politik/", seite: "https://www.faz.net/aktuell/politik/" },
  dlf: { name: "Deutschlandfunk", feed: "https://www.deutschlandfunk.de/nachrichten-100.rss", seite: "https://www.deutschlandfunk.de" },
  sz: { name: "Süddeutsche", feed: "https://rss.sueddeutsche.de/rss/Politik", seite: "https://www.sueddeutsche.de/politik" },
};

const EUROSTAT = {
  arbeitslosenquote: { dataset: "une_rt_m", filter: "freq=M&s_adj=SA&age=TOTAL&unit=PC_ACT&sex=T", einheit: "% der Erwerbspersonen", takt: "M" },
  inflation: { dataset: "prc_hicp_manr", filter: "freq=M&unit=RCH_A&coicop=CP00", einheit: "% zum Vorjahr", takt: "M" },
  "bip-wachstum": { dataset: "namq_10_gdp", filter: "freq=Q&unit=CLV_PCH_PRE&s_adj=SCA&na_item=B1GQ", einheit: "% zum Vorquartal", takt: "Q" },
  staatsverschuldung: { dataset: "gov_10q_ggdebt", filter: "freq=Q&unit=PC_GDP&sector=S13&na_item=GD", einheit: "% des BIP", takt: "Q" },
  industrieproduktion: { dataset: "sts_inpr_m", filter: "freq=M&indic_bt=PRD&nace_r2=B-D&s_adj=CA&unit=PCH_SM", einheit: "% zum Vorjahresmonat", takt: "M" },
  verbrauchervertrauen: { dataset: "ei_bsco_m", filter: "freq=M&indic=BS-CSMCI&s_adj=SA&unit=BAL", einheit: "Saldo, saisonbereinigt", takt: "M" },
  jugendarbeitslosigkeit: { dataset: "une_rt_m", filter: "freq=M&s_adj=SA&age=Y_LT25&unit=PC_ACT&sex=T", einheit: "% der unter 25-Jährigen", takt: "M" },
};

const WELTBANK = {
  lebenserwartung: { code: "SP.DYN.LE00.IN", einheit: "Jahre" },
  "erneuerbare-energien": { code: "EG.FEC.RNEW.ZS", einheit: "% des Endenergieverbrauchs" },
  "bip-pro-kopf-kkp": { code: "NY.GDP.PCAP.PP.CD", einheit: "internationale Dollar (KKP)" },
  jugendarbeitslosigkeit: { code: "SL.UEM.1524.ZS", einheit: "% der 15- bis 24-Jährigen" },
};

// ---------- Hilfsfunktionen ----------

async function holeText(url, { timeout = 30000 } = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "*/*" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} antwortete mit HTTP ${res.status}`);
  return res.text();
}

const slug = (s) =>
  s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "", auml: "ä", ouml: "ö", uuml: "ü",
  Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", euro: "€", ndash: "–", mdash: "—", hellip: "…",
  laquo: "«", raquo: "»", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
};

const entit = (s) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const c = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(c) && c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m;
    }
    return Object.hasOwn(NAMED, e) ? NAMED[e] : m;
  });

const textVon = (html) =>
  entit(html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const zeilenVon = (html) =>
  entit(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, ""))
    .split("\n").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);

function sicheresLink(href, basis) {
  try {
    const u = new URL(href, basis);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

const isoVonDeutsch = (s) => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s ?? "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

const body = (quelle, rest) => JSON.stringify({ quelle: QUELLEN[quelle] ?? quelle, ...rest });

// ---------- Jobs: Ergebnis ist { "pfad/relativ/zu/public.json": jsonText } ----------

async function jobDawum() {
  const roh = JSON.parse(await holeText("https://api.dawum.de/", { timeout: 60000 }));
  const parteien = roh.Parties ?? {};
  const gruppen = new Map();

  for (const [id, s] of Object.entries(roh.Surveys ?? {})) {
    if (!s?.Date) continue;
    const werte = {};
    for (const [pid, w] of Object.entries(s.Results ?? {})) {
      const k = parteien[pid]?.Shortcut;
      if (k && Number.isFinite(Number(w))) werte[k] = Number(w);
    }
    if (!Object.keys(werte).length) continue;
    const pid = String(s.Parliament_ID);
    if (!gruppen.has(pid)) gruppen.set(pid, []);
    gruppen.get(pid).push({
      id,
      datum: s.Date,
      institut: roh.Institutes?.[s.Institute_ID]?.Name ?? "Unbekannt",
      auftraggeber: roh.Taskers?.[s.Tasker_ID]?.Name ?? null,
      methode: roh.Methods?.[s.Method_ID]?.Name ?? null,
      teilnehmer: Number.parseInt(s.Surveyed_Persons, 10) || null,
      zeitraum: { von: s.Survey_Period?.Date_Start ?? null, bis: s.Survey_Period?.Date_End ?? null },
      werte,
    });
  }

  const stand = roh.Database?.Last_Update ?? null;
  const grenze = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const dateien = {};
  const index = [];

  for (const [pid, liste] of gruppen) {
    const p = roh.Parliaments?.[pid];
    if (!p?.Shortcut) continue;
    const s = slug(p.Shortcut);
    liste.sort((a, b) => (a.datum < b.datum ? 1 : a.datum > b.datum ? -1 : 0));
    const vorkommende = [...new Set(liste.flatMap((u) => Object.keys(u.werte)))]
      .map((k) => ({ kuerzel: k, name: Object.values(parteien).find((x) => x.Shortcut === k)?.Name ?? k }));
    const parlament = { slug: s, kuerzel: p.Shortcut, name: p.Name ?? p.Shortcut, wahl: p.Election ?? null };

    dateien[`v1/umfragen/${s}-alle.json`] = body("dawum", { stand, parlament, zeitraum: "alle", parteien: vorkommende, umfragen: liste });
    dateien[`v1/umfragen/${s}.json`] = body("dawum", { stand, parlament, zeitraum: "aktuell", parteien: vorkommende, umfragen: liste.filter((u) => u.datum >= grenze) });
    index.push({ ...parlament, anzahl: liste.length, neuesteUmfrage: liste[0]?.datum ?? null });
  }

  if (!dateien["v1/umfragen/bundestag.json"]) throw new Error("DAWUM lieferte keine Bundestagsumfragen");
  index.sort((a, b) => a.kuerzel.localeCompare(b.kuerzel, "de"));
  dateien["v1/umfragen/index.json"] = body("dawum", { stand, parlamente: index });
  return dateien;
}

function parseFeed(xml, basis) {
  const textTag = (s, tag) => {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(s);
    if (!m) return "";
    return entit(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")).trim();
  };
  const items = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const meldungen = items.map((it) => {
    const href = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(it)?.[1];
    const link = href || textTag(it, "link") || textTag(it, "guid") || textTag(it, "id");
    const d = new Date(textTag(it, "pubDate") || textTag(it, "published") || textTag(it, "updated") || textTag(it, "dc:date"));
    return { titel: textTag(it, "title"), link: sicheresLink(link, basis), datum: Number.isNaN(d.getTime()) ? null : d.toISOString() };
  }).filter((x) => x.titel);
  meldungen.sort((a, b) => (b.datum ?? "").localeCompare(a.datum ?? ""));
  return meldungen.slice(0, 40);
}

const jobNachrichten = (id) => async () => {
  const f = FEEDS[id];
  const meldungen = parseFeed(await holeText(f.feed), f.seite);
  if (!meldungen.length) throw new Error("Feed enthält keine auswertbaren Meldungen");
  return { [`v1/nachrichten/${id}.json`]: JSON.stringify({ quelle: { name: f.name, url: f.seite }, feed: { id, name: f.name }, meldungen }) };
};

async function jobFaktenchecks() {
  const daten = JSON.parse(await holeText("https://www.bundestakt.de/api/v1/claims"));
  return { "v1/faktenchecks.json": body("bundestakt", { daten }) };
}

const jobSpenden = (jahr) => async () => {
  const html = await holeText(`${QUELLEN.bundestag.url}/${jahr}`);
  const schwelle = new RegExp(`über\\s+([\\d.]+)\\s*€\\s*[-–]\\s*Jahr\\s*${jahr}`).exec(textVon(html))?.[1];
  const spenden = [];
  let letzte = "";

  for (const tr of html.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    const zellen = [...tr[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
    let partei, r;
    if (zellen.length >= 4 && /Euro/.test(textVon(zellen[1]))) {
      partei = textVon(zellen[0]);
      r = zellen.slice(1);
    } else if (zellen.length >= 3 && /Euro/.test(textVon(zellen[0])) && letzte) {
      partei = letzte;
      r = zellen;
    } else continue;
    letzte = partei;

    const betragText = textVon(r[0]);
    const m = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*Euro/.exec(betragText);
    const betrag = m ? Number.parseFloat(m[1].replace(/\./g, "") + (m[2] ? "." + m[2] : "")) : null;
    const zeilen = zeilenVon(r[1] ?? "");
    const d1 = textVon(r[2] ?? "");
    const d2 = textVon(r[3] ?? "");
    const href = /<a\b[^>]*\bhref=["']([^"']+)["']/i.exec(r[3] ?? "")?.[1];

    spenden.push({
      partei: /\(([^)]+)\)\s*$/.exec(partei)?.[1] ?? partei.slice(0, 22),
      parteiVoll: partei,
      betragEuro: betrag,
      hinweis: m ? textVon(betragText.replace(m[0], "")) : "",
      spender: zeilen[0] ?? "Spender nicht angegeben",
      adresse: zeilen.slice(1).join(", "),
      datumSpende: isoVonDeutsch(/\d{2}\.\d{2}\.\d{4}/.exec(d1)?.[0]),
      datumAnzeige: isoVonDeutsch(/\d{2}\.\d{2}\.\d{4}/.exec(d2)?.[0]),
      drucksache: /Drs\.\s*[\d/]+/.exec(d2)?.[0] ?? null,
      link: href ? sicheresLink(href, "https://www.bundestag.de/") : null,
    });
  }

  if (!spenden.length) throw new Error(`Keine Spenden für ${jahr} gefunden – Seitenstruktur geändert?`);
  return { [`v1/spenden/${jahr}.json`]: body("bundestag", { jahr, schwelleEuro: schwelle ? Number(schwelle.replace(/\./g, "")) : null, spenden }) };
};

function indexKarte(kategorie) {
  const idx = kategorie.index;
  if (Array.isArray(idx)) return Object.fromEntries(idx.map((code, i) => [code, i]));
  return idx;
}

const jobEurostat = (id) => async () => {
  const p = EUROSTAT[id];
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 60);
  const seit = p.takt === "M"
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
    : `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  const url = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${p.dataset}?format=JSON&lang=EN&${p.filter}&sinceTimePeriod=${seit}`;
  const js = JSON.parse(await holeText(url, { timeout: 60000 }));

  const ids = js.id, groesse = js.size;
  const gi = ids.indexOf("geo"), ti = ids.indexOf("time");
  if (gi < 0 || ti < 0) throw new Error("Unerwartetes Eurostat-Format");
  const schritt = new Array(ids.length);
  let s = 1;
  for (let i = ids.length - 1; i >= 0; i--) { schritt[i] = s; s *= groesse[i]; }

  const geo = js.dimension.geo.category;
  const zeit = indexKarte(js.dimension.time.category);
  const laender = {};
  for (const [code, g] of Object.entries(indexKarte(geo))) {
    const werte = {};
    for (const [t, tIdx] of Object.entries(zeit)) {
      const v = js.value?.[g * schritt[gi] + tIdx * schritt[ti]];
      if (v !== null && v !== undefined) werte[t] = v;
    }
    if (Object.keys(werte).length) laender[code] = { name: geo.label?.[code] ?? code, werte };
  }
  if (!Object.keys(laender).length) throw new Error("Eurostat lieferte keine Werte");
  return { [`v1/eurostat/${id}.json`]: body("eurostat", { preset: id, dataset: p.dataset, einheit: p.einheit, takt: p.takt, stand: js.updated ?? null, laender }) };
};

const jobWeltbank = (id) => async () => {
  const p = WELTBANK[id];
  const jahr = new Date().getUTCFullYear();
  const url = `https://api.worldbank.org/v2/country/all/indicator/${p.code}?format=json&per_page=20000&date=${jahr - 8}:${jahr}`;
  const res = JSON.parse(await holeText(url, { timeout: 60000 }));
  const zeilen = Array.isArray(res) ? res[1] : null;
  if (!Array.isArray(zeilen)) throw new Error("Unerwartetes Weltbank-Format");
  const laender = {};
  for (const z of zeilen) {
    if (z.value === null || !z.countryiso3code) continue;
    (laender[z.countryiso3code] ??= { name: z.country?.value ?? z.countryiso3code, werte: {} }).werte[z.date] = z.value;
  }
  if (!Object.keys(laender).length) throw new Error("Weltbank lieferte keine Werte");
  return { [`v1/weltbank/${id}.json`]: body("weltbank", { preset: id, indikator: p.code, einheit: p.einheit, laender }) };
};

async function jobAbgeordnetenwatch() {
  const aw = async (pfad) => JSON.parse(await holeText(`https://www.abgeordnetenwatch.de/api/v2/${pfad}`));
  const parlamente = (await aw("parliaments?range_end=100")).data ?? [];
  const bt = parlamente.find((p) => p.label === "Bundestag");
  if (!bt) throw new Error("Bundestag bei abgeordnetenwatch nicht gefunden");
  const perioden = (await aw(`parliament-periods?parliament=${bt.id}&type=legislature&range_end=30`)).data ?? [];
  const aktuell = [...perioden].sort((a, b) => String(b.start_date_period ?? "").localeCompare(String(a.start_date_period ?? "")))[0];
  if (!aktuell) throw new Error("Keine Wahlperiode gefunden");
  const abstimmungen = (await aw(`polls?field_legislature=${aktuell.id}&sort_by=field_poll_date&sort_direction=desc&range_end=100`)).data ?? [];
  return {
    "v1/abgeordnetenwatch/bundestag.json": body("abgeordnetenwatch", {
      parlamente: parlamente.map((p) => ({ id: p.id, label: p.label })),
      bundestag: { id: bt.id, wahlperiode: aktuell },
      abstimmungen,
    }),
  };
}

async function jobDip() {
  const key = process.env.DIP_KEY;
  const vorgaenge = [];
  let cursor = "";
  for (let seite = 0; seite < 10; seite++) {
    const q = new URLSearchParams({ "f.zuordnung": "BT", "f.deskriptor": "Parlamentarische Ordnung", rows: "100", format: "json", apikey: key });
    if (cursor) q.set("cursor", cursor);
    const d = JSON.parse(await holeText(`https://search.dip.bundestag.de/api/v1/vorgang?${q}`));
    if (!Array.isArray(d.documents)) throw new Error("Ungültige DIP-Antwort");
    vorgaenge.push(...d.documents);
    if (!d.cursor || d.cursor === cursor || d.documents.length === 0) break;
    cursor = d.cursor;
  }
  const perioden = vorgaenge.map((x) => Number(x.wahlperiode)).filter(Number.isFinite);
  if (!perioden.length) throw new Error("Keine DIP-Vorgänge gefunden");
  const wp = Math.max(...perioden);
  return { "v1/dip/ordnungsrufe.json": body("dip", { wahlperiode: wp, vorgaenge: vorgaenge.filter((x) => Number(x.wahlperiode) === wp) }) };
}

function jobs() {
  const jahr = new Date().getUTCFullYear();
  const liste = [
    { id: "dawum", quelle: "dawum", alleMinuten: 30, run: jobDawum },
    ...Object.keys(FEEDS).map((id) => ({ id: `news:${id}`, quelle: FEEDS[id].name, alleMinuten: 30, run: jobNachrichten(id) })),
    { id: "faktenchecks", quelle: "bundestakt", alleMinuten: 60, run: jobFaktenchecks },
    { id: "abgeordnetenwatch", quelle: "abgeordnetenwatch", alleMinuten: 360, run: jobAbgeordnetenwatch },
    ...Object.keys(EUROSTAT).map((id) => ({ id: `eurostat:${id}`, quelle: "eurostat", alleMinuten: 720, run: jobEurostat(id) })),
    ...Object.keys(WELTBANK).map((id) => ({ id: `weltbank:${id}`, quelle: "weltbank", alleMinuten: 1440, run: jobWeltbank(id) })),
  ];
  for (let j = 2002; j <= jahr; j++) {
    liste.push({ id: `spenden:${j}`, quelle: "bundestag", alleMinuten: j >= jahr - 1 ? 360 : 43200, run: jobSpenden(j) });
  }
  if (process.env.DIP_KEY) liste.push({ id: "dip", quelle: "dip", alleMinuten: 360, run: jobDip });
  return liste;
}

function statischeDateien() {
  const aktuell = new Date().getUTCFullYear();
  const j = (o) => JSON.stringify(o);
  return {
    "v1/index.json": j({
      name: "Politikatlas Daten", version: 1,
      dateien: [
        "v1/status.json", "v1/umfragen/index.json", "v1/umfragen/{parlament}.json", "v1/umfragen/{parlament}-alle.json",
        "v1/nachrichten/index.json", "v1/nachrichten/{feed}.json", "v1/faktenchecks.json",
        "v1/spenden/index.json", "v1/spenden/{jahr}.json", "v1/eurostat/index.json", "v1/eurostat/{preset}.json",
        "v1/weltbank/index.json", "v1/weltbank/{preset}.json", "v1/abgeordnetenwatch/bundestag.json", "v1/dip/ordnungsrufe.json",
      ],
    }),
    "v1/nachrichten/index.json": j({ feeds: Object.entries(FEEDS).map(([id, f]) => ({ id, name: f.name, url: f.seite })) }),
    "v1/spenden/index.json": j({ aktuellesJahr: aktuell, jahre: Array.from({ length: aktuell - 2002 + 1 }, (_, i) => aktuell - i) }),
    "v1/eurostat/index.json": j({ presets: Object.entries(EUROSTAT).map(([id, p]) => ({ id, dataset: p.dataset, einheit: p.einheit, takt: p.takt })) }),
    "v1/weltbank/index.json": j({ presets: Object.entries(WELTBANK).map(([id, p]) => ({ id, indikator: p.code, einheit: p.einheit })) }),
  };
}

// ---------- Ablauf ----------

const cacheDatei = (id) => join(CACHE, `${id.replace(/[^a-z0-9]+/gi, "_")}.json`);

async function ladeCache(id) {
  try {
    return JSON.parse(await readFile(cacheDatei(id), "utf8"));
  } catch {
    return null;
  }
}

async function schreibe(basis, pfad, text) {
  const ziel = join(basis, pfad);
  await mkdir(dirname(ziel), { recursive: true });
  await writeFile(ziel, text);
}

function istFaellig(rec, job) {
  if (!rec) return true;
  const alter = Date.now() - Date.parse(rec.versuch);
  const intervall = rec.ok ? job.alleMinuten : Math.min(job.alleMinuten, 180);
  return !(alter < intervall * 60 * 1000 - TOLERANZ_MS);
}

async function verarbeite(job) {
  const alt = await ladeCache(job.id);
  if (!istFaellig(alt, job)) return { job, rec: alt, neu: false };

  const t0 = Date.now();
  const jetzt = new Date().toISOString();
  try {
    const dateien = await job.run();
    const rec = { ok: true, versuch: jetzt, erfolg: jetzt, dauerMs: Date.now() - t0, fehler: null, dateien };
    await schreibe(CACHE, `${job.id.replace(/[^a-z0-9]+/gi, "_")}.json`, JSON.stringify(rec));
    return { job, rec, neu: true };
  } catch (e) {
    const rec = {
      ok: false, versuch: jetzt, erfolg: alt?.erfolg ?? null, dauerMs: Date.now() - t0,
      fehler: String(e?.message ?? e).slice(0, 300), dateien: alt?.dateien ?? {},
    };
    await schreibe(CACHE, `${job.id.replace(/[^a-z0-9]+/gi, "_")}.json`, JSON.stringify(rec));
    return { job, rec, neu: true };
  }
}

async function pool(liste, grenze, fn) {
  const ergebnisse = new Array(liste.length);
  let i = 0;
  await Promise.all(Array.from({ length: grenze }, async () => {
    while (i < liste.length) {
      const n = i++;
      ergebnisse[n] = await fn(liste[n]);
    }
  }));
  return ergebnisse;
}

export async function main() {
  const alle = jobs();
  const ergebnisse = await pool(alle, 6, verarbeite);

  for (const [pfad, text] of Object.entries(statischeDateien())) await schreibe(OUT, pfad, text);
  for (const { rec } of ergebnisse) {
    for (const [pfad, text] of Object.entries(rec.dateien ?? {})) await schreibe(OUT, pfad, text);
  }

  const status = {
    jetzt: new Date().toISOString(),
    quellen: ergebnisse.map(({ job, rec }) => ({
      id: job.id,
      quelle: QUELLEN[job.quelle]?.name ?? job.quelle,
      intervallMinuten: job.alleMinuten,
      ok: rec.ok,
      letzterErfolg: rec.erfolg,
      letzterVersuch: rec.versuch,
      dauerMs: rec.dauerMs,
      fehler: rec.fehler,
    })),
  };
  await schreibe(OUT, "v1/status.json", JSON.stringify(status));

  for (const s of status.quellen) {
    console.log(`${s.ok ? "ok    " : "FEHLER"} ${s.id}${s.fehler ? ` – ${s.fehler}` : ""}`);
  }

  // Ohne Bundestagsumfragen nichts veröffentlichen, damit die App keine kaputte Seite bekommt.
  try {
    await readFile(join(OUT, "v1/umfragen/bundestag.json"));
  } catch {
    console.error("Keine Bundestagsumfragen vorhanden – Abbruch ohne Veröffentlichung.");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
