const fs = require('fs');
const path = require('path');

module.exports = function() {
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'book-meta.json'), 'utf-8'));
  const csvPath = path.join(__dirname, 'goodreads.csv');
  const csv = fs.readFileSync(csvPath, 'utf-8');

  const lines = csv.split('\n');
  const headers = parseCSVLine(lines[0]);

  const allBooks = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const values = parseCSVLine(lines[i]);
    const book = {};
    headers.forEach((header, index) => {
      book[header] = values[index] || '';
    });

    if (book['Exclusive Shelf'] !== 'read') continue;

    let isbn13 = (book['ISBN13'] || '').replace(/^="?|"?$/g, '').replace(/^=|"$/g, '');
    let isbn10 = (book['ISBN'] || '').replace(/^="?|"?$/g, '').replace(/^=|"$/g, '');

    const yearPublished = book['Original Publication Year'] || book['Year Published'] || '';

    allBooks.push({
      id: book['Book Id'],
      title: book['Title'],
      author: book['Author'].trim().replace(/\s+/g, ' '),
      isbn: isbn13,
      isbn10: isbn10,
      rating: parseInt(book['My Rating']) || 0,
      dateRead: book['Date Read'] || '',
      yearPublished: yearPublished.trim(),
      myReview: book['My Review'] || ''
    });
  }

  // Normalize curly quotes/apostrophes for matching
  const norm = s => s.replace(/[\u2018\u2019\u201C\u201D]/g, c =>
    c === '\u2018' || c === '\u2019' ? "'" : '"'
  );

  // Map each series volume to its series (for category assignment only —
  // volumes are NOT collapsed; each keeps its own read date)
  const seriesByTitle = new Map();
  for (const [name, series] of Object.entries(meta.series)) {
    for (const title of series.books) seriesByTitle.set(norm(title), series);
  }

  // Resolve display title. Overrides in book-meta.json → displayTitles can be
  // keyed either by Book Id (stable across edition/title changes made by the
  // sync pipeline) or by raw title string. The curly-quote-normalized title
  // fallback handles smart-quote drift between exports.
  const displayTitle = (title, id) => {
    if (id && meta.displayTitles[id]) return meta.displayTitles[id];
    if (meta.displayTitles[title]) return meta.displayTitles[title];
    const key = Object.keys(meta.displayTitles || {}).find(k => norm(k) === norm(title));
    return key ? meta.displayTitles[key] : title;
  };

  // Drop " (Series Name, #3)" suffixes so volumes read as plain titles
  const stripSeriesSuffix = (title) => title.replace(/\s*\([^()]*#\d+[^()]*\)\s*$/, '');

  const categoryFor = (b) => {
    const series = seriesByTitle.get(norm(b.title));
    if (series) return series.category;
    return meta.classification[b.title]
      || meta.classification[Object.keys(meta.classification).find(k => norm(k) === norm(b.title))]
      || 'non-fiction';
  };

  // Permanent corrections registry (book-meta.json → corrections), keyed by
  // Book Id: { "5015": { "title": "…", "author": "…", "series": "Name",
  // "category": "fiction" } } — every field optional. Applied last, over
  // everything else, so curated values always win.
  const corrections = meta.corrections || {};

  // One entry per read row
  const all = allBooks.map(b => {
    const fix = corrections[b.id] || {};
    const series = fix.series && meta.series[fix.series];
    return {
      ...b,
      title: fix.title || displayTitle(stripSeriesSuffix(b.title), b.id),
      author: fix.author || b.author,
      dateReadDisplay: formatDateRead(b.dateRead),
      category: series
        ? series.category
        : (fix.category || categoryFor(b)),
      review: cleanReview(b.myReview)
    };
  });

  const fiction = all
    .filter(b => b.category === 'fiction')
    .sort((a, b) => b.rating - a.rating || b.dateRead.localeCompare(a.dateRead));

  const nonFiction = all
    .filter(b => b.category === 'non-fiction')
    .sort((a, b) => b.rating - a.rating || b.dateRead.localeCompare(a.dateRead));

  return {
    fiction,
    nonFiction,
    total: allBooks.length,
    timeline: buildTimeline(all)
  };
};

// ---------------------------------------------------------------------------
// Timeline: one flat list per year, newest first; books within a year in
// reverse read order (most recently finished on top), ties broken by rating.
// Year label only — no months, no counts.
// ---------------------------------------------------------------------------

function buildTimeline(all) {
  const enriched = all.map(book => ({
    ...book,
    stars: '★'.repeat(book.rating) + '☆'.repeat(Math.max(0, 5 - book.rating)),
    readYear: parseInt((book.dateRead || '').split('/')[0]) || null
  }));

  const years = [...new Set(enriched.map(b => b.readYear).filter(Boolean))].sort().reverse();

  return years.map(year => ({
    year,
    books: enriched
      .filter(b => b.readYear === year)
      .sort((a, b) => b.dateRead.localeCompare(a.dateRead) || b.rating - a.rating)
  }));
}

// Goodreads stores reviews as HTML (<br/>, entities). Reduce to plain text;
// Nunjucks autoescaping keeps whatever remains inert.
function cleanReview(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&(apos|#39);/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function formatDateRead(dateStr) {
  if (!dateStr) return '';
  // Goodreads format: "2025/11/19"
  const parts = dateStr.split('/');
  if (parts.length >= 2) return parts[0];
  return dateStr;
}

// RFC 4180: quotes open only at field start, "" escapes a quote inside.
// The old toggle-anywhere parser silently merged the ="ISBN" fields and
// shifted every column after them by one.
function parseCSVLine(line) {
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
