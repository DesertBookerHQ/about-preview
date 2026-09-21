# DesertBooker — About page preview

A **static review build** of the DesertBooker About page. It exists so the
page can be opened and shared without running the app.

- This is **not** the live site and not the product source.
- It is generated from the private product repository by `npm run preview:about`,
  which bundles the real React components — so the motion and the full waitlist
  flow (including Back and multi-select) are the real ones, not a re-creation.
- The waitlist **sends nothing**. The submit endpoint is deliberately null in this
  build; completing the flow only renders the confirmation state locally.
- Served with `noindex, nofollow`.

Do not edit anything here by hand: every file is build output and the next
publish overwrites it.
