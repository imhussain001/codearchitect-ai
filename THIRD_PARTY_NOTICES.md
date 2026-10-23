# Third-party notices

CodeArchitect AI is Copyright 2026 Hussain Tak and licensed under the Apache License 2.0 (see LICENSE and NOTICE). It depends on the open-source packages below, each under its own license.

## Direct production dependencies

| Package | Version | License | Source |
|---|---|---|---|
| @anthropic-ai/sdk | 0.135.0 | MIT | github:anthropics/anthropic-sdk-typescript |
| @xyflow/react | 12.12.0 | MIT | https://github.com/xyflow/xyflow |
| clsx | 2.1.1 | MIT | lukeed/clsx |
| jszip | 3.10.2 | (MIT OR GPL-3.0-or-later) | https://github.com/Stuk/jszip |
| lucide-react | 1.58.0 | ISC | https://github.com/lucide-icons/lucide |
| next | 16.4.2 | MIT | vercel/next.js |
| openai | 7.34.0 | Apache-2.0 | github:openai/openai-node |
| react | 19.3.1 | MIT | https://github.com/react/react |
| react-dom | 19.3.1 | MIT | https://github.com/react/react |
| zod | 4.6.7 | MIT | https://github.com/colinhacks/zod |

## All production dependencies, by license

69 packages in total (direct and transitive).

| License | Packages |
|---|---|
| MIT | 43 |
| ISC | 12 |
| Apache-2.0 | 6 |
| BSD-3-Clause | 2 |
| (MIT OR GPL-3.0-or-later) | 1 |
| (MIT AND Zlib) | 1 |
| CC-BY-4.0 | 1 |
| Unlicense | 1 |
| 0BSD | 1 |
| Apache-2.0 AND LGPL-3.0-or-later | 1 |

## Notes

- **jszip** is offered under `MIT OR GPL-3.0-or-later`; this project uses it under the **MIT** license.
- **caniuse-lite** (a data package used at build time by the CSS tooling) is licensed CC-BY-4.0: data derived from caniuse.com, copyright Alexis Deveria and contributors.
- **sharp** (installed as an optional dependency of Next.js, for image optimization) ships prebuilt libvips binaries under LGPL-3.0-or-later. They are installed by `npm install` and are not part of this repository or of the VS Code extension.
- Each package listed is the property of its authors and is used under its own license. This file lists them to meet their attribution requirements; it is not a substitute for their license texts, which ship inside each package.
