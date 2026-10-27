# SHOP-17: wishlist
Branch: feature
Language: en

## Status: stage 2 of 2 - all stages closed

## Force run 2026-09-03
Boundaries:
- no sharing of the wishlist with other people, no accounts, no server sync: the list lives in localStorage only
- no new dependencies

## Decisions (whole task)
- D1 The wishlist is stored in localStorage under the key `wishlist` (2026-09-02).

## Stages

### Stage 1: Wishlist store  [status: done]
What to do: add and remove products from the wishlist and keep the list between visits.
Acceptance criteria:
- `AC-1.1` WHEN a product is toggled THEN it is added to the wishlist, and toggled again it is removed - [verify: pro-review] PASS
- `AC-1.2` WHEN the page is reloaded THEN the wishlist is restored from localStorage - [verify: pro-review] PASS
Pipeline:
- [x] kickoff
- [x] implement
- [x] pro-review
- [x] commit

### Stage 2: Wishlist page  [status: done]
What to do: the page lists the saved products and handles the empty and out-of-stock cases.
Acceptance criteria:
- `AC-2.1` WHEN the wishlist has items THEN the page lists each with its name and price - [verify: pro-review] PASS
- `AC-2.2` WHEN the wishlist is empty THEN the page shows `t('wishlist.empty')` instead of an empty list - [verify: pro-review] PASS
- `AC-2.3` WHEN a saved item is out of stock THEN it shows the "Out of stock" label and its add-to-cart button is disabled - [verify: pro-review] PASS
Pipeline:
- [x] kickoff
- [x] implement
- [x] pro-review
- [x] commit

## Journal
- 2026-09-04 stage 2: pro-review checked the diff of stage 2 - no findings.
