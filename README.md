# DesertBooker — marketing and waitlist site

The static site served at <https://desertbooker.com> while the product is being
built: the About page with the waitlist, plus the privacy policy and terms of
service.

- This is **build output**, not the product source. It is generated from the
  private product repository by `npm run preview:about`, which bundles the real
  React components.
- The pages are **indexable**. Each has its own title, description and canonical
  URL; `robots.txt` allows everything and points to `sitemap.xml`.
- The waitlist **sends real data** to a Google Apps Script web app, which stores
  it in one tab of a Google Sheet.

## What the waitlist saves

| When | Request | Saved |
|---|---|---|
| Email step | `join` | Email, role, consent, page, device, referrer, UTM tags, language, time zone |
| Each time the question changes, and when the page is hidden | `answers` | Every answer on the current path |
| Last step | `answers` | The same, and the done screen waits for the reply |

The browser makes an `id` for each signup. The script stores it with the row and
asks for it, with the email, before it writes any answer.

## Folders that are not part of the site

| Folder | Holds |
|---|---|
| `apps-script/` | `Code.gs`, the script pasted into the Apps Script editor, and its tests |
| `tools/` | The bundle patch and the browser tests |

The Dockerfile copies named paths only, so neither folder ships in the image.

## Deploying a script change

1. Paste `apps-script/Code.gs` into the Apps Script editor and save.
2. Run `checkSheet`, read the log, then run `setup`.
3. **Deploy > Manage deployments > edit > Version: New version.**
   "New deployment" would create a new URL that the site does not call.
4. Open the web app URL: it must show the new `version`.

Deploy the script before the site.

`VERSION` at the top of `Code.gs` is what the web app URL reports, so it shows
which copy is live. Raise it with every change to the script.

## Patched by hand

The waitlist requests, the consent checkbox and the waitlist section of the
privacy policy were patched directly into the built bundles in this repository.
The indexing tags, `robots.txt` and `sitemap.xml` were also edited here.

None of that is in the product source yet. The next `npm run preview:about`
publish will overwrite all of it unless the same changes are made there first.

`/assets/` is served as immutable for a year, so a bundle whose content changes
must also get a new file name, and the HTML that references it must be updated.
`tools/patch-answers.cjs` does both. It documents the last change and cannot be
applied twice.

## Tests

```sh
node --test apps-script/Code.test.cjs
node tools/e2e.cjs <path to the playwright package> [screenshot folder]
```

The first runs the script against a fake sheet. The second drives the site in
Chromium with the endpoint mocked, so neither touches the real sheet.

## Run locally

```sh
docker build -t desertbooker-site .
docker run --rm -p 8090:80 desertbooker-site
```

Then open <http://localhost:8090/>. Any static file server pointed at the
repository root works as well; the pages must be served over HTTP, not opened
from disk. A signup made this way is written to the real sheet.

**Run `docker build` again after every change.** The image is a copy of the
files taken when it was built. `docker run` alone starts that old copy, however
much the files have changed since.

To check which form a running copy serves, open the page source and look for
`assets/about-….js`. It must be the same name as in `index.html` here.
