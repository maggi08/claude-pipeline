# Checkout prototype - behaviour spec

| Prototype file | Spec section | Screen ids |
|---|---|---|
| flow-checkout.html | §1 Review | screen-review |

## §1 Review (`flow-checkout.html#screen-review`)

States: `review.empty`, `review.ready`.

- Guard: when the cart is empty the screen is not shown; the user is redirected to `/cart`.
- The promo banner ("Free shipping applied") hides itself 5 s after the screen opens.

CTA decision table:

| Terms checkbox | CTA label | CTA enabled |
|---|---|---|
| unchecked | Place order | no |
| checked | Place order | yes |

Legal links ("Terms", "Privacy") are shown on `review.ready` only.
