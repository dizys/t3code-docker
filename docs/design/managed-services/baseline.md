# Current-console visual grounding

Captured from this design checkout's in-memory fixture console at a 1280 × 800 CSS viewport. Original PNGs are 2560 × 1600 pixels, representing device scale 2. Comparison layouts display them at 1280 × 800 CSS pixels. These are source references, not screenshots of the proposed feature.

1. [Access](evidence/baseline-access.png): restrained title and lede, one blue primary action, quiet grouped device rows, persistent sidebar. Connectivity is below the device list, supporting task tabs for the extended Access surface.
2. [Gateways](evidence/baseline-gateways.png): compact neutral rows, semantic status, contextual actions, and dense information without dashboard tiles.
3. [Toolchains](evidence/baseline-toolchains.png): reusable installation/version context and a consistent settings content lane.
4. [Add a tool](evidence/baseline-add-tool.png): approximately 448px side sheet, labeled inputs, focus treatment and lower action area. The fixture does not implement the registry endpoint and displays a fixture error. This is not evidence of a production registry failure.

Source: `docker/setup/design/{tokens.css,components.css,ui.js}` and the existing console fixture, based on `844d8504021f7c534851d78e3eabadf7cae5dd26`. The fixture's older displayed runtime versions are sample values, not the versions installed in the user's containers.

The proposal keeps the existing font asset, actual Lucide icon geometry, semantic token recipes, grouped rows, section rhythm, and primary-action hierarchy. Tabs, service states and setup content are new proposed behavior, so comparisons judge component consistency rather than identical page content.
