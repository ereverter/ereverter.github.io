# ereverter.github.io

Personal site: a library timeline synced from Goodreads, built with
[Eleventy](https://www.11ty.dev).

## Structure

```
src/
  _data/        goodreads.csv (export), book-meta.json, site.json, books.js (build logic)
  _includes/    base.njk layout, post.njk
  assets/       css source (minified at build)
  writing/      posts (markdown)
  books.njk     library page (the main content)
tools/
  sync-goodreads.js   incremental Goodreads RSS → CSV upsert (needs GOODREADS_USER_ID env)
```

## Commands

```sh
npm install
npm run build   # eleventy → _site/
npm run start   # dev server on 127.0.0.1:8080
```

## Library sync

GitHub Action `.github/workflows/sync-library.yml` runs weekly: it pulls the
Goodreads RSS feed and upserts `src/_data/goodreads.csv`, then commits. The
Goodreads user id is supplied via the `GOODREADS_USER_ID` repository secret.
