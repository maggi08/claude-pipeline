# MUG-31: cart on the shop page
Branch: feature
Language: en

## Status: stage 1 of 1 - implementation

## Stages

### Stage 1: Cart  [status: in-progress]
What to do: the shop page has a cart: add a mug, open the cart, apply a promo code; the account page lets a signed-in customer pick a saved delivery address.
Acceptance criteria:
- `AC-1.1` WHEN the customer clicks "Add to cart" THEN the header cart link shows the new count - [verify: devtools-verify]
- `AC-1.2` WHEN the customer applies the promo code SAVE10 to one mug THEN the cart total is 11.61 EUR - [verify: devtools-verify]
- `AC-1.3` WHEN a signed-in customer opens Account, Saved addresses THEN the saved addresses are listed - [verify: devtools-verify]
Pipeline:
- [x] kickoff
- [x] implement
- [ ] devtools-verify

## Journal
