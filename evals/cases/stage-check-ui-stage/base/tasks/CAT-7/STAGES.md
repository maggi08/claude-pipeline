# CAT-7: product tile in the catalog
Branch: feature
Language: en

## Status: stage 1 of 1 - checking

## Stages

### Stage 1: Product tile  [status: in-progress]
Figma nodes: 31:208 (Product tile, default)
What to do: the catalog page shows a product tile with a title, a price and a "Buy" button, laid out as in the design node.
Acceptance criteria:
- `AC-1.1` WHEN the tile is rendered THEN its padding, gap and corner radius equal the design values - [verify: figma-compare]
- `AC-1.2` WHEN the tile is rendered THEN its colors come from the design tokens - [verify: figma-compare]
- `AC-1.3` WHEN the catalog page loads THEN the browser console has no errors - [verify: devtools-verify]
- `AC-1.4` WHEN the viewport is 1440, 1280 or 1024 px wide THEN the page has no horizontal scroll - [verify: devtools-verify]
- `AC-1.5` WHEN a price is shown THEN it goes through `formatPrice` and not through string concatenation - [verify: pro-review]
Pipeline:
- [x] kickoff
- [x] implement
- [ ] figma-compare
- [ ] devtools-verify
- [ ] pro-review

## Journal
