// Politikatlas Daten
// Holt alle Quellen, bereitet sie auf und schreibt statische JSON-Dateien nach ./public.
// Lauf: node scripts/aktualisieren.mjs   (Node 20+, keine Abhängigkeiten)
// Von Hand gepflegt: hinweis.json im Hauptordner (Hinweis-Box der App, siehe hinweisDatei)
// Optionales Secret: DIP_KEY (Bundestag DIP)
// Optional: ALLES_NEU=1 erzwingt alle Abrufe, unabhängig von den Intervallen (für manuelle Läufe)

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

const UA = "Politikatlas/1.0 (+https://politikatlas.com)";
const CACHE = ".cache";
const OUT = "public";
const TOLERANZ_MS = 5 * 60 * 1000;

const QUELLEN = {
  dawum: { name: "DAWUM", url: "https://dawum.de/", lizenz: "ODbL 1.0", lizenzUrl: "https://opendatacommons.org/licenses/odbl/1-0/" },
  bundestakt: { name: "Bundestakt", url: "https://www.bundestakt.de/api-doku", lizenz: "CC BY 4.0", lizenzUrl: "https://creativecommons.org/licenses/by/4.0/" },
  bundestag: { name: "Deutscher Bundestag – Großspenden an Parteien (PartG § 25)", url: "https://www.bundestag.de/parlament/praesidium/parteienfinanzierung/fundstellen50000", lizenz: null, lizenzUrl: null },
  eurostat: { name: "Eurostat", url: "https://ec.europa.eu/eurostat", lizenz: null, lizenzUrl: null },
  weltbank: { name: "Weltbank", url: "https://data.worldbank.org/", lizenz: "CC BY 4.0", lizenzUrl: "https://creativecommons.org/licenses/by/4.0/" },
  abgeordnetenwatch: { name: "abgeordnetenwatch.de", url: "https://www.abgeordnetenwatch.de/api", lizenz: null, lizenzUrl: null },
  dip: { name: "DIP – Deutscher Bundestag", url: "https://search.dip.bundestag.de/api/v1/swagger-ui/", lizenz: null, lizenzUrl: null },
  bundestagStammdaten: { name: "Deutscher Bundestag – Stammdaten aller Abgeordneten seit 1949", url: "https://www.bundestag.de/services/opendata", lizenz: null, lizenzUrl: null },
  bundeswahlleiterin: { name: "Die Bundeswahlleiterin – Wahlkreisergebnisse", url: "https://www.bundeswahlleiterin.de/bundestagswahlen/", lizenz: "Datenlizenz Deutschland – Namensnennung – Version 2.0", lizenzUrl: "https://www.govdata.de/dl-de/by-2-0" },
  wikidata: { name: "Wikidata", url: "https://www.wikidata.org/", lizenz: "CC0 1.0", lizenzUrl: "https://creativecommons.org/publicdomain/zero/1.0/" },
  wikipedia: { name: "Wikipedia", url: "https://de.wikipedia.org/", lizenz: "CC BY-SA 4.0", lizenzUrl: "https://creativecommons.org/licenses/by-sa/4.0/deed.de" },
  eurostatRegional: { name: "Eurostat – Regionalstatistik (NUTS 1)", url: "https://ec.europa.eu/eurostat/web/regions/database", lizenz: null, lizenzUrl: null },
  politikatlas: { name: "Politikatlas", url: "https://politikatlas.com", lizenz: null, lizenzUrl: null },
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
  // prc_hicp_manr endet mit Dezember 2025, Nachfolger ist prc_hicp_minr (ECOICOP 2)
  inflation: { dataset: "prc_hicp_minr", filter: "freq=M&unit=RCH_A&coicop18=TOTAL", einheit: "% zum Vorjahr", takt: "M" },
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

const warte = (ms) => new Promise((r) => setTimeout(r, ms));

// Wiederholt bei vorübergehenden Fehlern: Netzwerkfehler, Zeitüberschreitung, HTTP 429 und 5xx.
// Mit wiederhole403 auch bei 403, weil manche CDNs Anfragen aus Rechenzentren zeitweise abweisen.
async function holeText(url, { timeout = 30000, accept = "*/*", versuche = 2, wiederhole403 = false } = {}) {
  for (let versuch = 1; ; versuch++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { "user-agent": UA, accept, "accept-language": "de-DE,de;q=0.9" },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      if (versuch >= versuche) throw e;
      await warte(2000 * 3 ** (versuch - 1));
      continue;
    }
    if (res.ok) return res.text();
    const fehler = new Error(`${new URL(url).host} antwortete mit HTTP ${res.status}`);
    const vorlaeufig = res.status === 429 || res.status >= 500 || (wiederhole403 && res.status === 403);
    if (!vorlaeufig || versuch >= versuche) throw fehler;
    await warte(2000 * 3 ** (versuch - 1));
  }
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

// Einzelne Spenden listet der Bundestag erst ab 2009. Für 2002 bis 2008 gibt es auf den Seiten
// nur Drucksachennummern je Monat, ohne Spender und Beträge.
const ERSTES_SPENDENJAHR = 2009;

// Bis 2020 steht der Betrag ohne "Euro" in der Zelle ("500.000,00", "77.750 5" mit Fußnote),
// ab 2021 mit ("50.001 Euro").
const BETRAG = /^\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?:\s*(?:Euro|€))?/;
// Muss mit einer Zahl beginnen, sonst zählt die Kopfzeile "Spende in €" mit
const istBetrag = (zelle) => BETRAG.test(textVon(zelle));

const jobSpenden = (jahr) => async () => {
  const html = await holeText(`${QUELLEN.bundestag.url}/${jahr}`);
  const schwelle = new RegExp(`über\\s+([\\d.]+)\\s*€\\s*[-–]\\s*Jahr\\s*${jahr}`).exec(textVon(html))?.[1];
  const spenden = [];
  let letzte = "";

  for (const tr of html.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    const zellen = [...tr[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
    let partei, r;
    if (zellen.length >= 4 && istBetrag(zellen[1]) && !istBetrag(zellen[0])) {
      partei = textVon(zellen[0]);
      r = zellen.slice(1);
    } else if (zellen.length >= 3 && istBetrag(zellen[0]) && letzte) {
      partei = letzte;
      r = zellen;
    } else continue;
    letzte = partei;

    const betragText = textVon(r[0]).replace(/\(Interner Link\)/gi, "").trim();
    const m = BETRAG.exec(betragText);
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

// abgeordnetenwatch steht hinter einem CDN, das Anfragen aus Rechenzentren (z. B. GitHub Actions)
// zeitweise mit 403 abweist. Deshalb: Parlament und Wahlperiode aus dem letzten Lauf merken, sodass
// normalerweise nur eine Anfrage nötig ist, und bei 403 mit Pause wiederholen.
const AW_IDS = join(CACHE, "abgeordnetenwatch_ids.json");

async function jobAbgeordnetenwatch() {
  const aw = async (pfad) => JSON.parse(await holeText(`https://www.abgeordnetenwatch.de/api/v2/${pfad}`,
    { accept: "application/json", versuche: 4, wiederhole403: true }));

  let gemerkt = null;
  try { gemerkt = JSON.parse(await readFile(AW_IDS, "utf8")); } catch { /* erster Lauf */ }

  let parlamente = gemerkt?.parlamente;
  let bt = gemerkt?.bundestag;
  let aktuell = gemerkt?.wahlperiode;
  // Einmal im Monat neu nachsehen, ob eine neue Wahlperiode begonnen hat
  const veraltet = !gemerkt?.geprueft || Date.now() - Date.parse(gemerkt.geprueft) > 30 * 864e5;
  if (!bt || !aktuell || veraltet) {
    parlamente = ((await aw("parliaments?range_end=100")).data ?? []).map((p) => ({ id: p.id, label: p.label }));
    bt = parlamente.find((p) => p.label === "Bundestag");
    if (!bt) throw new Error("Bundestag bei abgeordnetenwatch nicht gefunden");
    const perioden = (await aw(`parliament-periods?parliament=${bt.id}&type=legislature&range_end=30`)).data ?? [];
    aktuell = [...perioden].sort((a, b) => String(b.start_date_period ?? "").localeCompare(String(a.start_date_period ?? "")))[0];
    if (!aktuell) throw new Error("Keine Wahlperiode gefunden");
    await schreibe(CACHE, "abgeordnetenwatch_ids.json", JSON.stringify({ parlamente, bundestag: bt, wahlperiode: aktuell, geprueft: new Date().toISOString() }));
  }

  const abstimmungen = (await aw(`polls?field_legislature=${aktuell.id}&sort_by=field_poll_date&sort_direction=desc&range_end=100`)).data ?? [];
  return {
    "v1/abgeordnetenwatch/bundestag.json": body("abgeordnetenwatch", {
      parlamente: (parlamente ?? []).map((p) => ({ id: p.id, label: p.label })),
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

// ---------- Parlament: Stammdaten des Bundestages, Wahlkreisergebnisse, Amtsinhaber ----------
// Alles wird live aus Quellen berechnet. Fällt eine Teilquelle aus, bleibt der letzte Stand erhalten.

const STAMMDATEN_FALLBACK = "https://www.bundestag.de/resource/blob/472878/MdB-Stammdaten-data.zip";

async function holeBytes(url, { timeout = 120000 } = {}) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${new URL(url).host} antwortete mit HTTP ${res.status}`);
  return { daten: Buffer.from(await res.arrayBuffer()), geaendert: res.headers.get("last-modified") };
}

/** Liest die erste Datei mit passender Endung aus einem ZIP (ohne Abhängigkeiten). */
function dateiAusZip(buf, endung) {
  let ende = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { ende = i; break; }
  }
  if (ende < 0) throw new Error("ZIP ohne Verzeichnis");
  const anzahl = buf.readUInt16LE(ende + 10);
  let pos = buf.readUInt32LE(ende + 16);
  for (let n = 0; n < anzahl; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const methode = buf.readUInt16LE(pos + 10);
    const komprimiert = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const kommentarLen = buf.readUInt16LE(pos + 32);
    const lokal = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + kommentarLen;
    if (!name.toLowerCase().endsWith(endung)) continue;
    const start = lokal + 30 + buf.readUInt16LE(lokal + 26) + buf.readUInt16LE(lokal + 28);
    const roh = buf.subarray(start, start + komprimiert);
    return methode === 0 ? roh : inflateRawSync(roh);
  }
  throw new Error(`Keine ${endung}-Datei im ZIP`);
}

function dekodiereXml(bytes) {
  const kopf = bytes.subarray(0, 200).toString("latin1");
  const enc = /encoding=["']([^"']+)["']/i.exec(kopf)?.[1] ?? "utf-8";
  let text;
  try {
    text = new TextDecoder(enc).decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  return text.replace(/^﻿/, "");
}

const xmlTag = (s, t) => {
  const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(s);
  return m ? entit(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim() : "";
};
const xmlBloecke = (s, t) => [...s.matchAll(new RegExp(`<${t}>[\\s\\S]*?</${t}>`, "g"))].map((m) => m[0]);

function leseStammdaten(xml) {
  return xmlBloecke(xml, "MDB").map((m) => ({
    geburt: isoVonDeutsch(xmlTag(m, "GEBURTSDATUM")),
    weiblich: /weib/i.test(xmlTag(m, "GESCHLECHT")),
    partei: xmlTag(m, "PARTEI_KURZ"),
    wps: xmlBloecke(m, "WAHLPERIODE").map((w) => ({
      wp: Number(xmlTag(w, "WP")),
      von: isoVonDeutsch(xmlTag(w, "MDBWP_VON")),
      bis: isoVonDeutsch(xmlTag(w, "MDBWP_BIS")),
      art: xmlTag(w, "MANDATSART"),
      inst: xmlBloecke(w, "INSTITUTION").map((i) => ({
        art: xmlTag(i, "INSART_LANG"),
        name: xmlTag(i, "INS_LANG"),
        von: isoVonDeutsch(xmlTag(i, "MDBINS_VON")),
        bis: isoVonDeutsch(xmlTag(i, "MDBINS_BIS")),
      })),
    })),
  }));
}

function parteiKurz(p) {
  const t = String(p ?? "").toLowerCase().trim();
  if (t === "cdu") return "CDU";
  if (t === "csu") return "CSU";
  if (/spd|sozialdemokrat/.test(t)) return "SPD";
  if (/afd|alternative für/.test(t)) return "AfD";
  if (/grüne|gruene|bündnis 90|buendnis 90/.test(t)) return "Grüne";
  if (/linke|pds/.test(t)) return "Linke";
  if (/fdp|freie demokrat/.test(t)) return "FDP";
  if (/bsw|wagenknecht/.test(t)) return "BSW";
  if (/ssw|südschleswig/.test(t)) return "SSW";
  if (/freie wähler/.test(t)) return "Freie Wähler";
  return String(p ?? "").trim();
}

function fraktionKurz(n) {
  const t = String(n ?? "").toLowerCase();
  if (!t || /fraktionslos/.test(t)) return null;
  if (/linke|pds/.test(t)) return "Linke";
  if (/christlich|cdu|csu/.test(t)) return "CDU/CSU";
  if (/sozialdemokrat|spd/.test(t)) return "SPD";
  if (/alternative für|afd/.test(t)) return "AfD";
  if (/grüne|gruene|bündnis 90/.test(t)) return "Grüne";
  if (/freie demokrat|fdp/.test(t)) return "FDP";
  if (/wagenknecht|bsw/.test(t)) return "BSW";
  return String(n).replace(/^(Fraktion|Gruppe)\s+(der|des|die)?\s*/i, "").trim() || null;
}

const mittel = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const rund1 = (x) => Math.round(x * 10) / 10;
const alterAm = (geburt, tag) => (Date.parse(tag) - Date.parse(geburt)) / (365.2425 * 864e5);

function fraktionAm(eintrag, tag) {
  const treffer = eintrag.w.inst.find(
    (i) => /fraktion|gruppe/i.test(i.art) && (!i.von || i.von <= tag) && (!i.bis || i.bis >= tag),
  );
  const name = fraktionKurz(treffer?.name);
  if (name) return name;
  return parteiKurz(eintrag.m.partei) === "SSW" ? "SSW" : "Fraktionslos";
}

/** Rechnet alle Kennzahlen aus den Stammdaten. "Zu Beginn" ist der Tag, an dem die meisten Mitglieder ihr Mandat antraten. */
function werteAus(mitglieder, heute) {
  const proWp = new Map();
  for (const m of mitglieder) {
    for (const w of m.wps) {
      if (!Number.isFinite(w.wp) || !w.von) continue;
      if (!proWp.has(w.wp)) proWp.set(w.wp, []);
      proWp.get(w.wp).push({ m, w });
    }
  }
  const wps = [...proWp.keys()].sort((a, b) => a - b);
  if (wps.length < 2) throw new Error("Zu wenige Wahlperioden in den Stammdaten");
  const aktuell = wps.at(-1);

  const beginn = (wp) => {
    const liste = proWp.get(wp);
    const zaehler = new Map();
    for (const x of liste) zaehler.set(x.w.von, (zaehler.get(x.w.von) ?? 0) + 1);
    const start = [...zaehler.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    return { start, liste: liste.filter((x) => x.w.von === start) };
  };

  // Frauenanteil und Durchschnittsalter zu Beginn jeder Wahlperiode
  const verlauf = [];
  const altersMittel = new Map();
  for (const wp of wps) {
    const { start, liste } = beginn(wp);
    if (liste.length < 100) continue;
    const frauen = liste.filter((x) => x.m.weiblich).length;
    verlauf.push({ jahr: Number(start.slice(0, 4)), anteil: rund1((frauen / liste.length) * 100) });
    const alter = liste.filter((x) => x.m.geburt).map((x) => alterAm(x.m.geburt, start));
    if (alter.length) altersMittel.set(wp, { jahr: Number(start.slice(0, 4)), alter: mittel(alter) });
  }

  // Aktuelle Sitze
  const aktuelleListe = proWp.get(aktuell).filter((x) => x.w.von <= heute && (!x.w.bis || x.w.bis >= heute));
  const sitze = new Map();
  for (const x of aktuelleListe) {
    const f = fraktionAm(x, heute);
    sitze.set(f, (sitze.get(f) ?? 0) + 1);
  }
  const fraktionen = [...sitze.entries()]
    .map(([name, anzahl]) => ({ name, sitze: anzahl }))
    .sort((a, b) => {
      if (a.name === "Fraktionslos") return 1;
      if (b.name === "Fraktionslos") return -1;
      return b.sitze - a.sitze || a.name.localeCompare(b.name, "de");
    });
  const frauenAktuell = aktuelleListe.filter((x) => x.m.weiblich).length;

  // Alter zu Beginn der aktuellen Wahlperiode
  const { start, liste: startListe } = beginn(aktuell);
  const mitAlter = startListe.filter((x) => x.m.geburt).map((x) => ({ x, alter: alterAm(x.m.geburt, start) }));
  const nachFraktion = new Map();
  for (const { x, alter } of mitAlter) {
    const f = fraktionAm(x, start);
    if (!nachFraktion.has(f)) nachFraktion.set(f, []);
    nachFraktion.get(f).push(alter);
  }
  const hoechsteFraktionen = [...nachFraktion.entries()]
    .filter(([name, a]) => a.length >= 5 && name !== "Fraktionslos")
    .map(([name, a]) => ({ name, alter: rund1(mittel(a)) }))
    .sort((a, b) => b.alter - a.alter)
    .slice(0, 2);
  const rekorde = [...altersMittel.values()];
  const hoch = rekorde.reduce((a, b) => (b.alter > a.alter ? b : a));
  const tief = rekorde.reduce((a, b) => (b.alter < a.alter ? b : a));
  const vorher = altersMittel.get(wps.at(-2));
  if (!vorher) throw new Error("Keine Daten zur vorherigen Wahlperiode");

  const frauenAlter = mitAlter.filter((e) => e.x.m.weiblich).map((e) => e.alter);
  const maennerAlter = mitAlter.filter((e) => !e.x.m.weiblich).map((e) => e.alter);

  // Direktmandate zu Beginn der aktuellen und der vorherigen Wahlperiode
  const direkt = (liste) => {
    const nachPartei = new Map();
    for (const x of liste.filter((e) => /direkt/i.test(e.w.art))) {
      const p = parteiKurz(x.m.partei);
      nachPartei.set(p, (nachPartei.get(p) ?? 0) + 1);
    }
    return nachPartei;
  };
  const direktAktuell = direkt(startListe);
  const vorherZusammen = new Map();
  for (const [p, n] of direkt(beginn(wps.at(-2)).liste)) {
    const name = p === "CDU" || p === "CSU" ? "CDU/CSU" : p;
    vorherZusammen.set(name, (vorherZusammen.get(name) ?? 0) + n);
  }

  return {
    wahlperiode: aktuell,
    wahljahr: Number(start.slice(0, 4)),
    vorherigesWahljahr: Number(beginn(wps.at(-2)).start.slice(0, 4)),
    gesamt: aktuelleListe.length,
    fraktionen,
    frauenanteil: {
      aktuell: rund1((frauenAktuell / aktuelleListe.length) * 100),
      frauen: frauenAktuell,
      verlauf,
    },
    alter: {
      gesamt: rund1(mittel(mitAlter.map((e) => e.alter))),
      frauen: rund1(mittel(frauenAlter)),
      maenner: rund1(mittel(maennerAlter)),
      vorherigeWahl: rund1(vorher.alter),
      hoechsteFraktionen,
      rekorde: [
        { name: `Höchster Wert (${hoch.jahr})`, alter: rund1(hoch.alter) },
        { name: `Niedrigster Wert (${tief.jahr})`, alter: rund1(tief.alter) },
      ],
    },
    direktAktuell,
    direktGesamt: [...direktAktuell.values()].reduce((s, n) => s + n, 0),
    direktVorher: [...vorherZusammen.entries()]
      .map(([name, n]) => ({ name, wahlkreissiege: n }))
      .sort((a, b) => b.wahlkreissiege - a.wahlkreissiege || a.name.localeCompare(b.name, "de")),
  };
}

/** Wahlkreissieger nach Erststimmen aus kerg2.csv der Bundeswahlleiterin. */
function wahlkreissieger(csv) {
  const zeilen = csv.replace(/^﻿/, "").split(/\r?\n/);
  const k = zeilen.findIndex((z) => z.startsWith("Wahlart;Wahltag;Gebietsart"));
  if (k < 0) throw new Error("kerg2.csv ohne Kopfzeile");
  const spalten = zeilen[k].split(";");
  const [iArt, iNr, iGruppenart, iName, iStimme, iAnzahl] =
    ["Gebietsart", "Gebietsnummer", "Gruppenart", "Gruppenname", "Stimme", "Anzahl"].map((n) => spalten.indexOf(n));
  if ([iArt, iNr, iGruppenart, iName, iStimme, iAnzahl].some((i) => i < 0)) throw new Error("kerg2.csv hat unerwartete Spalten");

  const beste = new Map();
  for (const z of zeilen.slice(k + 1)) {
    const f = z.split(";");
    if (f[iArt] !== "Wahlkreis" || f[iStimme] !== "1" || f[iAnzahl] === "" || f[iAnzahl] === undefined) continue;
    const einzel = /einzelbewerber/i.test(f[iGruppenart]);
    if (f[iGruppenart] !== "Partei" && !einzel) continue;
    const anzahl = Number(f[iAnzahl]);
    if (!Number.isFinite(anzahl)) continue;
    const alt = beste.get(f[iNr]);
    if (!alt || anzahl > alt.anzahl) beste.set(f[iNr], { anzahl, partei: einzel ? "Einzelbewerber" : parteiKurz(f[iName]) });
  }
  if (beste.size < 200) throw new Error("Zu wenige Wahlkreise in kerg2.csv");
  return beste;
}

async function ladeDirektmandate(w) {
  const yy = String(w.wahljahr).slice(2);
  const url = `https://www.bundeswahlleiterin.de/bundestagswahlen/${w.wahljahr}/ergebnisse/opendata/btw${yy}/csv/kerg2.csv`;
  const beste = wahlkreissieger(await holeText(url, { timeout: 90000 }));
  const siege = new Map();
  for (const { partei } of beste.values()) siege.set(partei, (siege.get(partei) ?? 0) + 1);

  const namen = new Set([...siege.keys(), ...w.direktAktuell.keys()]);
  namen.delete("Einzelbewerber");
  const parteien = [...namen]
    .map((name) => {
      const mandate = w.direktAktuell.get(name) ?? 0;
      return { name, wahlkreissiege: Math.max(siege.get(name) ?? 0, mandate), mandate };
    })
    .filter((p) => p.wahlkreissiege > 0)
    .sort((a, b) => b.wahlkreissiege - a.wahlkreissiege || a.name.localeCompare(b.name, "de"));

  return {
    wahlkreise: beste.size,
    mitMandat: w.direktGesamt,
    ohneMandat: beste.size - w.direktGesamt,
    parteien,
    wahljahr: w.wahljahr,
    vorherigesWahljahr: w.vorherigesWahljahr,
    vorherigeWahl: w.direktVorher,
    // Alter Name, bleibt für ältere App-Versionen erhalten
    wahl2021: w.direktVorher,
  };
}

/** Amtsinhaber aus Wikidata. Die Regierungsfraktionen ergeben sich aus den Parteien von Kanzler und Vizekanzler. */
async function ladeAmtsinhaber() {
  const abfrage = `
SELECT ?amt ?person ?personLabel ?start ?sex ?parteiLabel WHERE {
  {
    wd:Q183 p:P35 ?st . ?st ps:P35 ?person .
    BIND("Bundespräsident" AS ?amt)
  } UNION {
    wd:Q183 p:P6 ?st . ?st ps:P6 ?person .
    BIND("Bundeskanzler" AS ?amt)
  } UNION {
    VALUES ?pl { "Vizekanzler von Deutschland"@de "Vizekanzler"@de "Vice Chancellor of Germany"@en "Vice-Chancellor of Germany"@en
                 "Präsident des Deutschen Bundestages"@de "Bundestagspräsident"@de "President of the Bundestag"@en }
    ?pos rdfs:label ?pl .
    ?person p:P39 ?st . ?st ps:P39 ?pos .
    BIND(STR(?pl) AS ?amt)
  }
  FILTER NOT EXISTS { ?st pq:P582 ?ende }
  OPTIONAL { ?st pq:P580 ?start }
  OPTIONAL { ?person wdt:P21 ?sex }
  OPTIONAL { ?person p:P102 ?ps . ?ps ps:P102 ?partei . FILTER NOT EXISTS { ?ps pq:P582 ?pende } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en". }
}`;
  const roh = JSON.parse(await holeText(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(abfrage)}`, { timeout: 60000 }));
  const zeilen = roh.results?.bindings ?? [];

  const bezeichnung = (s) => (/vice|vize/i.test(s) ? "Vizekanzler" : /bundestag/i.test(s) ? "Bundestagspräsident" : s);
  const proAmt = new Map();
  for (const z of zeilen) {
    const amt = bezeichnung(z.amt.value);
    const start = z.start?.value ?? "";
    const alt = proAmt.get(amt);
    if (!alt || start > alt.start) {
      proAmt.set(amt, { start, person: z.person.value, name: z.personLabel?.value ?? "", weiblich: z.sex?.value?.endsWith("Q6581072") ?? false });
    }
  }

  const reihenfolge = ["Bundespräsident", "Bundeskanzler", "Vizekanzler", "Bundestagspräsident"];
  const amtsinhaber = reihenfolge
    .filter((a) => proAmt.get(a)?.name && !/^Q\d+$/.test(proAmt.get(a).name))
    .map((a) => {
      const p = proAmt.get(a);
      return { amt: p.weiblich ? `${a}in` : a, name: p.name, seit: p.start ? p.start.slice(0, 10) : null };
    });

  const parteienVon = (amt) => {
    const p = proAmt.get(amt);
    if (!p) return [];
    return zeilen
      .filter((z) => bezeichnung(z.amt.value) === amt && z.person.value === p.person && z.parteiLabel)
      .map((z) => fraktionKurz(z.parteiLabel.value))
      .filter(Boolean);
  };
  const kanzler = parteienVon("Bundeskanzler");
  const vize = parteienVon("Vizekanzler");
  const regierung = kanzler.length && vize.length ? [...new Set([...kanzler, ...vize])] : null;

  return { amtsinhaber, regierung };
}

async function vorherigeDatei(pfad) {
  try {
    return JSON.parse((await ladeCache("parlament"))?.dateien?.[pfad]);
  } catch {
    return null;
  }
}

async function stammdatenUrl() {
  try {
    const html = await holeText("https://www.bundestag.de/services/opendata");
    const m = /href="([^"]*MdB-Stammdaten[^"]*\.zip)"/i.exec(html);
    const link = m ? sicheresLink(entit(m[1]), "https://www.bundestag.de/") : null;
    if (link) return link;
  } catch {
    // Fallback unten
  }
  return STAMMDATEN_FALLBACK;
}

async function jobParlament() {
  const vorher = await vorherigeDatei("v1/parlament.json");
  const heute = new Date().toISOString().slice(0, 10);

  const { daten, geaendert } = await holeBytes(await stammdatenUrl());
  const mitglieder = leseStammdaten(dekodiereXml(dateiAusZip(daten, ".xml")));
  if (mitglieder.length < 1000) throw new Error("Stammdaten unvollständig");
  const w = werteAus(mitglieder, heute);
  if (w.gesamt < 500) throw new Error("Unplausible Zahl aktueller Mitglieder");

  let direktmandate = vorher?.direktmandate;
  try {
    direktmandate = await ladeDirektmandate(w);
  } catch (e) {
    console.warn(`Direktmandate: ${e.message}`);
  }

  let amtsinhaber = vorher?.amtsinhaber ?? [];
  let regierung = vorher?.bundestag?.regierung ?? [];
  try {
    const wd = await ladeAmtsinhaber();
    if (wd.amtsinhaber.length) amtsinhaber = wd.amtsinhaber;
    if (wd.regierung) regierung = wd.regierung;
  } catch (e) {
    console.warn(`Amtsinhaber: ${e.message}`);
  }

  const stand = geaendert && Number.isFinite(Date.parse(geaendert)) ? new Date(geaendert).toISOString().slice(0, 10) : heute;
  return {
    "v1/parlament.json": body("bundestagStammdaten", {
      quellen: [QUELLEN.bundeswahlleiterin, QUELLEN.wikidata],
      stand: heute,
      amtsinhaber,
      bundestag: { wahlperiode: w.wahlperiode, gesamt: w.gesamt, stand, regierung, fraktionen: w.fraktionen },
      frauenanteil: w.frauenanteil,
      alter: w.alter,
      ...(direktmandate ? { direktmandate } : {}),
    }),
  };
}

// ---------- Wahlen und Länder ----------
// Wahlergebnisse und Landesregierungen: Wikipedia. Einwohner und Fläche: Eurostat (NUTS 1 = Bundesländer).
// Fällt eine Teilquelle aus, bleibt der letzte Stand dieser Teilquelle erhalten.

/** Daten, deren Stichtag länger zurückliegt, gelten nicht mehr als aktuell und werden nicht veröffentlicht. */
const MAX_ALTER_JAHRE = 2;

const PARLAMENTE = [
  { id: "bundestag", kuerzel: "DE", name: "Bundestag", wiki: "Deutscher Bundestag" },
  { id: "baden-wuerttemberg", kuerzel: "BW", nuts: "DE1", name: "Baden-Württemberg", wiki: "Landtag von Baden-Württemberg" },
  { id: "bayern", kuerzel: "BY", nuts: "DE2", name: "Bayern", wiki: "Bayerischer Landtag" },
  { id: "berlin", kuerzel: "BE", nuts: "DE3", name: "Berlin", wiki: "Abgeordnetenhaus Berlin" },
  { id: "brandenburg", kuerzel: "BB", nuts: "DE4", name: "Brandenburg", wiki: "Landtag Brandenburg" },
  { id: "bremen", kuerzel: "HB", nuts: "DE5", name: "Bremen", wiki: "Bremische Bürgerschaft" },
  { id: "hamburg", kuerzel: "HH", nuts: "DE6", name: "Hamburg", wiki: "Hamburgische Bürgerschaft" },
  { id: "hessen", kuerzel: "HE", nuts: "DE7", name: "Hessen", wiki: "Hessischer Landtag" },
  { id: "mecklenburg-vorpommern", kuerzel: "MV", nuts: "DE8", name: "Mecklenburg-Vorpommern", wiki: "Landtag Mecklenburg-Vorpommern" },
  { id: "niedersachsen", kuerzel: "NI", nuts: "DE9", name: "Niedersachsen", wiki: "Niedersächsischer Landtag" },
  { id: "nordrhein-westfalen-nrw", kuerzel: "NW", nuts: "DEA", name: "Nordrhein-Westfalen", wiki: "Landtag Nordrhein-Westfalen" },
  { id: "rheinland-pfalz", kuerzel: "RP", nuts: "DEB", name: "Rheinland-Pfalz", wiki: "Landtag Rheinland-Pfalz" },
  { id: "saarland", kuerzel: "SL", nuts: "DEC", name: "Saarland", wiki: "Landtag des Saarlandes" },
  { id: "sachsen", kuerzel: "SN", nuts: "DED", name: "Sachsen", wiki: "Sächsischer Landtag" },
  { id: "sachsen-anhalt", kuerzel: "ST", nuts: "DEE", name: "Sachsen-Anhalt", wiki: "Landtag von Sachsen-Anhalt" },
  { id: "schleswig-holstein", kuerzel: "SH", nuts: "DEF", name: "Schleswig-Holstein", wiki: "Schleswig-Holsteinischer Landtag" },
  { id: "thueringen", kuerzel: "TH", nuts: "DEG", name: "Thüringen", wiki: "Thüringer Landtag" },
];
const LAENDER = PARLAMENTE.filter((p) => p.nuts);

const zuAlt = (iso) => !iso || Date.now() - Date.parse(iso) > MAX_ALTER_JAHRE * 365.2425 * 864e5;

async function vorherigeAusCache(id, pfad) {
  try {
    return JSON.parse((await ladeCache(id))?.dateien?.[pfad]);
  } catch {
    return null;
  }
}

async function wikitext(seite) {
  const url = `https://de.wikipedia.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2&redirects=1&page=${encodeURIComponent(seite)}`;
  const d = JSON.parse(await holeText(url, { accept: "application/json" }));
  const text = d?.parse?.wikitext;
  if (typeof text !== "string" || !text) throw new Error(`Wikipedia-Seite fehlt: ${seite}`);
  return text;
}

const MONATE = ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];

/** "8. März 2026" → "2026-03-08" */
function isoVonLangDatum(s) {
  const m = /(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+(\d{4})/.exec(s ?? "");
  if (!m) return null;
  const monat = MONATE.indexOf(m[2].toLowerCase()) + 1;
  return monat ? `${m[3]}-${String(monat).padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

const langDatum = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Wikitext ohne Links, Vorlagen, Einzelnachweise und HTML */
function wikiKlartext(s) {
  return entit(String(s ?? ""))
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[\s\S]*?<\/ref>/g, "")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Alle Vorlagen {{name …}} samt verschachtelter Vorlagen */
function vorlagen(text, name) {
  const treffer = [];
  const kopf = new RegExp(`\\{\\{\\s*${name}\\s*(?=\\|)`, "g");
  let m;
  while ((m = kopf.exec(text))) {
    let tiefe = 0;
    let i = m.index;
    for (; i < text.length - 1; i++) {
      if (text[i] === "{" && text[i + 1] === "{") { tiefe++; i++; }
      else if (text[i] === "}" && text[i + 1] === "}") { tiefe--; i++; if (tiefe === 0) break; }
    }
    treffer.push(text.slice(m.index, i + 1));
    kopf.lastIndex = i + 1;
  }
  return treffer;
}

function vorlagenWerte(vorlage) {
  const werte = {};
  for (const m of vorlage.matchAll(/^\s*\|\s*([A-Za-zÄÖÜäöü0-9_]+)\s*=\s*(.*?)\s*$/gm)) werte[m[1].toUpperCase()] = m[2];
  return werte;
}

const zahlWiki = (s) => {
  const m = /-?\d+(?:[.,]\d+)?/.exec(String(s ?? ""));
  return m ? Number(m[0].replace(",", ".")) : null;
};

function wahlPartei(roh) {
  const t = wikiKlartext(roh);
  if (/^sonst/i.test(t)) return "Sonstige";
  if (/^(union|cdu\/csu)$/i.test(t)) return "CDU/CSU";
  if (/^csu/i.test(t)) return "CSU";
  if (/^fw\b|freie wähler/i.test(t)) return "Freie Wähler";
  if (/^tier/i.test(t)) return "Tierschutzpartei";
  if (/^(die)?basis$/i.test(t)) return "dieBasis";
  if (/^(die )?partei$/i.test(t)) return "Die PARTEI";
  return parteiKurz(t);
}

/** Ergebnis aus dem Wahldiagramm des Wahlartikels (Zweitstimmen bzw. Landesstimmen) */
function wahlergebnis(text, jahr) {
  const diagramme = vorlagen(text, "Wahldiagramm")
    .map(vorlagenWerte)
    .filter((w) => String(w.TITEL ?? "").includes(String(jahr)))
    .filter((w) => !/erststimm|wahlkreis/i.test(`${w.TITEL ?? ""} ${w.TITEL2 ?? ""}`));
  const w = diagramme.find((d) => Object.keys(d).some((k) => k.startsWith("ERGEBNISALT"))) ?? diagramme[0];
  if (!w) throw new Error(`Kein Wahldiagramm für ${jahr}`);

  const ergebnisse = [];
  for (let i = 1; i <= 40; i++) {
    const partei = w[`PARTEI${i}`];
    const prozent = zahlWiki(w[`ERGEBNIS${i}`] ?? w[`ERGEBNISNEU${i}`]);
    if (!partei || prozent === null) continue;
    ergebnisse.push({ partei: wahlPartei(partei), prozent, vorher: zahlWiki(w[`ERGEBNISALT${i}`]) });
  }
  const summe = ergebnisse.reduce((s, e) => s + e.prozent, 0);
  if (ergebnisse.length < 3 || summe < 85 || summe > 101) throw new Error(`Unplausibles Wahlergebnis (${ergebnisse.length} Parteien, Summe ${rund1(summe)})`);

  const beteiligung =
    /Wahlbeteiligung[^0-9<]*(\d{2}(?:[.,]\d+)?)\s*%/.exec(`${w.TITEL2 ?? ""} ${w.TITEL ?? ""}`)?.[1] ??
    /Wahlbeteiligung (?:lag bei|betrug|stieg auf|sank auf|erreichte) (\d{2}(?:,\d+)?)\s*(?:%|Prozent)/.exec(text)?.[1];
  return {
    beteiligung: beteiligung ? Number(beteiligung.replace(",", ".")) : null,
    vorherigesJahr: zahlWiki(w.JAHRALT),
    ergebnisse: ergebnisse.sort((a, b) => (a.partei === "Sonstige") - (b.partei === "Sonstige") || b.prozent - a.prozent),
  };
}

async function jobWahlen() {
  const vorher = await vorherigeAusCache("wahlen", "v1/wahlen.json");
  const wahlen = [];
  const fehler = [];

  for (const p of PARLAMENTE) {
    try {
      const info = await wikitext(p.wiki);
      const m = /\|\s*Letzte[ _]Wahl\s*=\s*\[\[([^\]|]+)\|([^\]]+)\]\]/.exec(info);
      if (!m) throw new Error("Feld „Letzte Wahl“ fehlt");
      const seite = m[1].trim();
      const datum = isoVonLangDatum(m[2]);
      const jahr = Number(datum?.slice(0, 4) ?? /\d{4}/.exec(seite)?.[0]);
      if (!datum || !jahr) throw new Error(`Wahldatum nicht lesbar: ${m[2]}`);
      const naechste = wikiKlartext(/\|\s*Nächste[ _]Wahl\s*=\s*(.*)/.exec(info)?.[1] ?? "") || null;

      wahlen.push({
        parlament: p.id,
        kuerzel: p.kuerzel,
        name: p.name,
        titel: seite,
        datum,
        naechsteWahl: naechste,
        link: `https://de.wikipedia.org/wiki/${encodeURIComponent(seite.replace(/ /g, "_"))}`,
        ...wahlergebnis(await wikitext(seite), jahr),
      });
    } catch (e) {
      fehler.push(`${p.kuerzel}: ${e.message}`);
      const alt = vorher?.wahlen?.find((w) => w.parlament === p.id);
      if (alt) wahlen.push(alt);
    }
  }

  if (fehler.length) console.warn(`Wahlen: ${fehler.join("; ")}`);
  if (wahlen.length < 12) throw new Error(`Zu wenige Wahlen gelesen – ${fehler.join("; ")}`);
  wahlen.sort((a, b) => b.datum.localeCompare(a.datum));
  return {
    "v1/wahlen.json": body("wikipedia", {
      stand: new Date().toISOString().slice(0, 10),
      hinweis: "Ergebnisse laut Wikipedia. Maßgeblich sind die amtlichen Endergebnisse der Wahlleitungen.",
      wahlen,
    }),
  };
}

/** Aktuelle Landesregierungen aus der Übersichtstabelle im Artikel „Landesregierung (Deutschland)“ */
function landesregierungen(text) {
  const start = text.indexOf("{|");
  const tabelle = text.slice(start, text.indexOf("\n|}", start));
  const ergebnis = new Map();

  for (const roh of tabelle.split(/\n\|-/)) {
    const kuerzel = /\{\{DE-([A-Z]{2})\}\}/.exec(roh)?.[1];
    if (!kuerzel) continue;
    const zeile = roh.replace(/<span[\s\S]*?<\/span>/g, "").replace(/&#160;|&nbsp;/g, " ");
    const kabinett = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/.exec(zeile)?.[1]?.trim() ?? null;
    const chef = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]\s*\(([^)]+)\)/.exec(zeile);
    const datum = /DatumZelle\|(\d{4}-\d{2}-\d{2})/.exec(zeile);
    if (!chef || !datum) continue;

    const zwischen = zeile.slice(chef.index + chef[0].length, datum.index);
    const koalition = wikiKlartext(zwischen.replace(/\|\|/g, " "))
      .replace(/[|{}]/g, " ")
      .split(",")
      .map((x) => wahlPartei(x.trim()))
      .filter(Boolean);
    if (!koalition.length) continue;

    ergebnis.set(kuerzel, {
      chef: (chef[2] ?? chef[1]).trim(),
      partei: wahlPartei(chef[3]),
      koalition,
      kabinett,
      seit: datum[1],
    });
  }
  if (ergebnis.size !== 16) throw new Error(`Landesregierungen: ${ergebnis.size} statt 16 Länder gelesen`);
  return ergebnis;
}

/** Werte je NUTS-Region und Jahr aus einem Eurostat-Datensatz */
async function eurostatLaender(dataset, filter) {
  const geo = LAENDER.map((l) => `geo=${l.nuts}`).join("&");
  const seit = new Date().getUTCFullYear() - 5;
  const url = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${dataset}?format=JSON&lang=DE&${filter}&${geo}&sinceTimePeriod=${seit}`;
  const js = JSON.parse(await holeText(url, { timeout: 60000 }));
  const ids = js.id;
  const gi = ids.indexOf("geo");
  const ti = ids.indexOf("time");
  if (gi < 0 || ti < 0) throw new Error(`Unerwartetes Eurostat-Format (${dataset})`);
  const schritt = new Array(ids.length);
  let s = 1;
  for (let i = ids.length - 1; i >= 0; i--) { schritt[i] = s; s *= js.size[i]; }
  const geoIdx = indexKarte(js.dimension.geo.category);
  const jahre = Object.entries(indexKarte(js.dimension.time.category)).sort((a, b) => b[0].localeCompare(a[0]));

  // Neuestes Jahr, für das alle 16 Länder einen Wert haben
  for (const [jahr, t] of jahre) {
    const werte = {};
    for (const l of LAENDER) {
      const v = js.value?.[geoIdx[l.nuts] * schritt[gi] + t * schritt[ti]];
      if (v !== null && v !== undefined) werte[l.kuerzel] = v;
    }
    if (Object.keys(werte).length === LAENDER.length) return { jahr, werte };
  }
  throw new Error(`Eurostat ${dataset}: kein Jahr mit Werten für alle Länder`);
}

async function jobLaender() {
  const vorher = await vorherigeAusCache("laender", "v1/laender.json");
  const altLand = (k) => vorher?.laender?.find((l) => l.kuerzel === k);
  const heute = new Date().toISOString().slice(0, 10);
  const fehler = [];

  // Einwohner am 1. Januar
  let einwohner = null;
  let einwohnerStichtag = vorher?.einwohnerStichtag ?? null;
  try {
    const e = await eurostatLaender("demo_r_d2jan", "sex=T&age=TOTAL&unit=NR");
    einwohner = e.werte;
    einwohnerStichtag = `${e.jahr}-01-01`;
  } catch (e) {
    fehler.push(e.message);
  }
  if (zuAlt(einwohnerStichtag)) einwohnerStichtag = null;

  // Fläche in km²
  let flaeche = null;
  let flaecheJahr = vorher?.flaecheJahr ?? null;
  try {
    const f = await eurostatLaender("reg_area3", "landuse=TOTAL&unit=KM2");
    flaeche = f.werte;
    flaecheJahr = f.jahr;
  } catch (e) {
    fehler.push(e.message);
  }

  // Regierungen
  let regierungen = null;
  try {
    regierungen = landesregierungen(await wikitext("Landesregierung (Deutschland)"));
  } catch (e) {
    fehler.push(e.message);
  }

  // Für den Hinweis "geschäftsführend": Landtagswahl nach Amtsantritt der Regierung
  const wahlen = (await vorherigeAusCache("wahlen", "v1/wahlen.json"))?.wahlen ?? [];

  const laender = LAENDER.map((l) => {
    const alt = altLand(l.kuerzel);
    const regierung = regierungen?.get(l.kuerzel) ?? alt?.regierung ?? null;
    const wahl = wahlen.find((w) => w.parlament === l.id);
    if (regierung) {
      regierung.hinweis = wahl && regierung.seit && wahl.datum > regierung.seit
        ? `Geschäftsführend im Amt bis zur Regierungsbildung nach der Wahl am ${langDatum(wahl.datum)}.`
        : null;
    }
    return {
      kuerzel: l.kuerzel,
      slug: l.id,
      name: l.name,
      einwohner: einwohnerStichtag ? (einwohner?.[l.kuerzel] ?? alt?.einwohner ?? null) : null,
      flaeche: flaeche?.[l.kuerzel] ?? alt?.flaeche ?? null,
      regierung,
    };
  });

  if (fehler.length) console.warn(`Länder: ${fehler.join("; ")}`);
  if (!laender.some((l) => l.regierung) && !laender.some((l) => l.einwohner)) throw new Error(`Länderdaten fehlen – ${fehler.join("; ")}`);

  return {
    "v1/laender.json": body("eurostatRegional", {
      quellen: [QUELLEN.eurostatRegional, QUELLEN.wikipedia],
      stand: heute,
      einwohnerStichtag,
      flaecheJahr,
      regierungenStand: regierungen ? heute : (vorher?.regierungenStand ?? null),
      laender,
    }),
  };
}

// ---------- Hinweis-Box der App ----------
// Wird von Hand in hinweis.json (im Hauptordner des Repos) gepflegt und bei jedem Lauf übernommen.
// Format: { "aktiv": true, "farbe": "gruen" | "gelb" | "rot", "titel": "…", "text": "…", "link": "https://…", "linkText": "…", "bis": "2026-12-24T18:00:00+01:00" }

async function hinweisDatei() {
  const aus = JSON.stringify({ aktiv: false });
  let roh;
  try {
    roh = JSON.parse(await readFile("hinweis.json", "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") console.warn(`hinweis.json ist kein gültiges JSON und wird ignoriert: ${e.message}`);
    return aus;
  }
  const text = typeof roh?.text === "string" ? roh.text.trim() : "";
  const titel = typeof roh?.titel === "string" ? roh.titel.trim() : "";
  if (roh?.aktiv !== true || (!text && !titel)) return aus;

  const farbe = ["gruen", "gelb", "rot"].includes(roh.farbe) ? roh.farbe : "gelb";
  const bis = roh.bis && Number.isFinite(Date.parse(roh.bis)) ? new Date(roh.bis).toISOString() : null;
  if (bis && Date.parse(bis) < Date.now()) return aus;
  const link = typeof roh.link === "string" && /^https:\/\/\S+$/.test(roh.link.trim()) ? roh.link.trim() : null;
  const linkText = link && typeof roh.linkText === "string" && roh.linkText.trim() ? roh.linkText.trim() : null;
  const id = createHash("sha256").update(JSON.stringify([farbe, titel, text, link])).digest("hex").slice(0, 16);

  return JSON.stringify({ aktiv: true, id, farbe, titel: titel || null, text, link, linkText, bis });
}

function jobs() {
  const jahr = new Date().getUTCFullYear();
  const liste = [
    { id: "dawum", quelle: "dawum", alleMinuten: 30, run: jobDawum },
    ...Object.keys(FEEDS).map((id) => ({ id: `news:${id}`, quelle: FEEDS[id].name, alleMinuten: 30, run: jobNachrichten(id) })),
    { id: "faktenchecks", quelle: "bundestakt", alleMinuten: 60, run: jobFaktenchecks },
    { id: "abgeordnetenwatch", quelle: "abgeordnetenwatch", alleMinuten: 360, run: jobAbgeordnetenwatch, signatur: "aw-2" },
    ...Object.keys(EUROSTAT).map((id) => ({ id: `eurostat:${id}`, quelle: "eurostat", alleMinuten: 720, run: jobEurostat(id), signatur: `${EUROSTAT[id].dataset}?${EUROSTAT[id].filter}` })),
    ...Object.keys(WELTBANK).map((id) => ({ id: `weltbank:${id}`, quelle: "weltbank", alleMinuten: 1440, run: jobWeltbank(id), signatur: WELTBANK[id].code })),
  ];
  for (let j = ERSTES_SPENDENJAHR; j <= jahr; j++) {
    liste.push({ id: `spenden:${j}`, quelle: "bundestag", alleMinuten: j >= jahr - 1 ? 360 : 43200, run: jobSpenden(j), signatur: "spenden-2" });
  }
  liste.push({ id: "parlament", quelle: "bundestagStammdaten", alleMinuten: 720, run: jobParlament });
  liste.push({ id: "wahlen", quelle: "wikipedia", alleMinuten: 360, run: jobWahlen });
  liste.push({ id: "laender", quelle: "eurostatRegional", alleMinuten: 360, run: jobLaender });
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
        "v1/weltbank/index.json", "v1/weltbank/{preset}.json", "v1/abgeordnetenwatch/bundestag.json", "v1/dip/ordnungsrufe.json", "v1/parlament.json",
        "v1/laender.json", "v1/wahlen.json", "v1/hinweis.json",
      ],
    }),
    "v1/nachrichten/index.json": j({ feeds: Object.entries(FEEDS).map(([id, f]) => ({ id, name: f.name, url: f.seite })) }),
    "v1/spenden/index.json": j({ aktuellesJahr: aktuell, erstesJahr: ERSTES_SPENDENJAHR, jahre: Array.from({ length: aktuell - ERSTES_SPENDENJAHR + 1 }, (_, i) => aktuell - i) }),
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
  if (process.env.ALLES_NEU === "1") return true;
  // Geänderte Konfiguration (z. B. neuer Eurostat-Datensatz) sofort neu laden
  if ((job.signatur ?? null) !== (rec.signatur ?? null)) return true;
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
    const rec = { ok: true, versuch: jetzt, erfolg: jetzt, dauerMs: Date.now() - t0, fehler: null, dateien, signatur: job.signatur ?? null };
    await schreibe(CACHE, `${job.id.replace(/[^a-z0-9]+/gi, "_")}.json`, JSON.stringify(rec));
    return { job, rec, neu: true };
  } catch (e) {
    const rec = {
      ok: false, versuch: jetzt, erfolg: alt?.erfolg ?? null, dauerMs: Date.now() - t0,
      fehler: String(e?.message ?? e).slice(0, 300), dateien: alt?.dateien ?? {},
      // Signatur nur übernehmen, wenn der Fehler mit der neuen Konfiguration passiert ist
      signatur: job.signatur ?? null,
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
  // Der Hinweis wird bei jedem Lauf frisch übernommen, unabhängig von den Job-Intervallen.
  await schreibe(OUT, "v1/hinweis.json", await hinweisDatei());
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
