#!/usr/bin/env node
// Syncs read books from a Goodreads review-list RSS feed into
// src/_data/goodreads.csv. Feed exposes, per item:
// book_id, title, author_name, isbn (10), user_rating, book_published and
// user_read_at (the finish date) — everything books.js needs.
//
// The feed returns the 100 most recent reviews, so this is an incremental
// upsert: existing rows are updated in place (rating / date read), new Book
// Ids are appended. Books that leave the "read" shelf are NOT removed — that
// still needs the manual CSV export.
//
// Usage:
//   GOODREADS_USER_ID=<id> node tools/sync-goodreads.js            apply changes
//   GOODREADS_USER_ID=<id> node tools/sync-goodreads.js --dry-run  report only
//
// Env: GOODREADS_USER_ID (required), GOODREADS_SHELF (default "read")
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
// No default: the Goodreads user id is account data, not site data.
// Export GOODREADS_USER_ID in your environment or the workflow secrets.
const userId = process.env.GOODREADS_USER_ID;
if (!userId) {
  console.error('ERROR: set GOODREADS_USER_ID (numeric Goodreads id) in the environment');
  process.exit(1);
}
const shelf = process.env.GOODREADS_SHELF || 'read';
const csvPath = path.join(__dirname, '..', 'src', '_data', 'goodreads.csv');

function fetchFeed() {
  const url = `https://www.goodreads.com/review/list_rss/${userId}?shelf=${shelf}`;
  return fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'Mozilla/5.0 (library-sync)' }
  }).then(r => {
    if (!r.ok) throw new Error(`Feed returned HTTP ${r.status}`);
    return r.text();
  });
}

function cdata(s) {
  const m = s.match(/^<!\[CDATA\[(.*)\]\]>$/s);
  const raw = m ? m[1] : s;
  return raw
    .replace(/&(apos|#39);/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function parseFeed(xml) {
  const items = [];
  for (const raw of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
    const get = tag => {
      const m = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return m ? cdata(m[1]).trim() : '';
    };
    // RFC2822 e.g. "Sat, 12 Sep 2026 04:15:44 -0700" -> "2026/09/12",
    // keeping the calendar day as Goodreads displays it in the feed
    let read = '';
    const m = get('user_read_at').match(/(\d{1,2}) (\w{3}) (\d{4})/);
    if (m) {
      const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
      read = `${m[3]}/${months[m[2]]}/${m[1].padStart(2, '0')}`;
    }
    items.push({
      'Book Id': get('book_id'),
      Title: get('title'),
      Author: get('author_name'),
      ISBN: get('isbn'),
      'My Rating': get('user_rating') || '0',
      'Date Read': read,
      'Original Publication Year': get('book_published'),
      'My Review': get('user_review'),
      'Exclusive Shelf': shelf
    });
  }
  return items;
}

// Minimal CSV line writer matching the export's conventions: quote fields
// containing commas/quotes, double the quotes. ISBN13 keeps its ="..." form.
function csvField(value, formula) {
  if (value === undefined || value === null) value = '';
  value = String(value);
  if (formula && value) return `="${value}"`;
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function rowToCsvLine(row, headers) {
  return headers.map(h => csvField(row[h], h === 'ISBN13' || h === 'ISBN')).join(',');
}

function normTitle(s) {
  return s.toLowerCase().replace(/\(.*\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

(async () => {
  const xml = await fetchFeed();
  const items = parseFeed(xml).filter(it => it['Book Id']);
  if (!items.length) throw new Error('Feed parsed to zero items — layout may have changed');

  const src = fs.readFileSync(csvPath, 'utf-8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const headers = parseLine(lines[0]);
  const needed = ['Book Id', 'Title', 'Author', 'ISBN', 'My Rating', 'Date Read', 'Original Publication Year', 'Exclusive Shelf'];
  for (const h of needed) if (!headers.includes(h)) throw new Error(`CSV missing column: ${h}`);

  // Index existing rows by Book Id and by normalized title (editions differ
  // between the feed and the export, so titles are the fallback key).
  // Only 'read' rows may be mutated; the export keeps a second 'to-read' row
  // per book that we must not touch.
  const byId = new Map();
  const byTitle = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = {};
    parseLine(lines[i]).forEach((v, j) => { row[headers[j]] = v; });
    if (row['Exclusive Shelf'] !== 'read') continue;
    const id = row['Book Id'];
    if (id) byId.set(id, { i, row });
    const t = normTitle(row['Title'] || '');
    if (t) byTitle.set(t, { i, row });
  }

  const updated = [], appended = [], skipped = [];
  const dirtyRows = new Set();
  const newRows = [];

  for (const it of items) {
    const hit = byId.get(it['Book Id'])
      || byTitle.get(normTitle(it.Title))
      || null;
    if (!hit) {
      newRows.push(it);
      continue;
    }
    const row = hit.row;
    const changed = [];
    for (const h of ['Title', 'Author', 'My Rating', 'Date Read', 'Original Publication Year', 'My Review']) {
      const cur = (row[h] || '').trim();
      const next = (it[h] || '').trim();
      if (next && cur !== next) {
        row[h] = next;
        changed.push(`${h}: ${cur || '∅'} -> ${next}`);
      }
    }
    if (changed.length) {
      updated.push(`${row['Title'].slice(0, 40)} (${changed.join('; ')})`);
      dirtyRows.add(hit.i);
    } else {
      skipped.push(row['Title']);
    }
  }
  if (DRY_RUN) {
    console.log(`feed items: ${items.length}`);
    console.log(`would update: ${updated.length}`);
    updated.slice(0, 15).forEach(u => console.log('  ~ ' + u));
    console.log(`would append: ${newRows.length}`);
    newRows.slice(0, 15).forEach(r => console.log('  + ' + r.Title + ' — ' + r.Author + ' (' + r['Date Read'] + ')'));
    console.log(`unchanged: ${skipped.length}`);
    return;
  }

  if (!updated.length && !newRows.length) {
    console.log(`no changes (feed items: ${items.length})`);
    return;
  }

  for (const i of dirtyRows) lines[i] = rowToCsvLine(byRowAt(i), headers);
  for (const r of newRows) lines.push(rowToCsvLine(r, headers));

  function byRowAt(i) {
    for (const { i: j, row } of byId.values()) if (j === i) return row;
    for (const { i: j, row } of byTitle.values()) if (j === i) return row;
    throw new Error('row not found: ' + i);
  }

  fs.writeFileSync(csvPath, lines.join(eol) + eol);
  console.log(`updated: ${updated.length}, appended: ${newRows.length}, unchanged: ${skipped.length}`);
})().catch(err => {
  console.error('sync failed:', err.message);
  process.exit(1);
});

function parseLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"' && current === '') {
      inQuotes = true;
    } else if (char === ',') {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values.map(v => v.trim());
}
