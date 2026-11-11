# Cart
Routes: / · /account/ · Auth: partly · Platforms: desktop · Status: draft
The customer puts a mug in the cart, applies a promo code and, when signed in, picks a saved delivery address.
## Sub-features
- `cart-add` · `cart-promo` · `cart-address`
## How to get to it (user POV)
- Home → the mug card → «Add to cart»
- Header → «Cart»
- Header → «Account» → «Saved addresses» (needs the SMS code of the account's phone)
## Driving it with Chrome DevTools MCP
Preconditions: doctor ok; reload the page to reset the cart.
- **Card entry.** click `button "Add to cart"` → the header link reads `link "Cart (1)"`.
- **Header entry.** click `link "Cart (1)"` → `heading "Your cart"` and the line `Stone mug`.
- **Promo.** fill `textbox "Promo code"` with `SAVE10`, click `button "Apply"` → `StaticText "Total: 11.61 EUR"`.
- **Saved addresses.** Header → `link "Account"` → `/account/`, sign in with the SMS code, click `link "Saved addresses"` → `heading "Saved addresses"` and the list of addresses.
## Gotchas
- The account page needs the SMS code of a real phone; without it the page stays on the sign-in form.
- The cart is kept in the tab only: a reload empties it.
