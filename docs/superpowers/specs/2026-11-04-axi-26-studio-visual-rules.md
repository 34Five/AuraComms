# AXI-26: Studio visual rules for the Aura inbox

Taken from staging Studio screenshots, which are attached to AXI-26 in Linear and are not stored in this repository. Studio's source and real design tokens were not available. Values marked (estimate) were judged from screenshots or adjusted for contrast.

The direction is Studio's colors, font and components inside a genuine email inbox layout. Do not copy Studio's page layouts or navigation.

## Color

| Token | Value | Use |
|---|---|---|
| `--surface-canvas` | `#f2eee4` | Reading pane, search field |
| `--surface-paper` | `#ffffff` | Top bar, thread list, messages |
| `--surface-linen` | `#faf8f2` | Selected row, attachments, Aura messages |
| `--surface-rail` | `#3d3d3d` | Aura sidebar |
| `--rule` | `#e6e0d3` | Dividers, input borders |
| `--accent` | `#855b4a` | Primary buttons, active Aura, links |
| `--ink` | `#3d3d3d` | Main text |
| `--ink-muted` | `#6f6a60` | Secondary text |
| `--rail-ink` | `#d9d5cc` (estimate) | Sidebar text |
| `--rail-ink-muted` | `#b8b3a9` (estimate) | Secondary sidebar text |
| `--avatar` | `#5f7183` (estimate) | Sender avatars. Studio samples at `#6b7d8f`, darkened to reach 4.5:1 with white initials |

Studio's link color samples near `#9b6d5a`, which is 4.44:1 on white. Text links use `--accent` instead.

## Status badges

| Status | Text | Background | Contrast |
|---|---|---|---|
| Open (green) | `#51603f` | `#eaede7` | 5.74:1 |
| Closed (clay) | `#855b4a` | `#efe7e4` | 4.79:1 |
| Archived (slate) | `#47586a` | `#eaedf0` | 6.22:1 |
| Errors (red) | `#8a3b2c` | `#f5eae9` | 6.50:1 |

## Type

- Poppins (estimate, matched by eye), self-hosted in weights 400, 500, 600 and 700. Latin only, so other scripts use the system font.
- Headings are bold and tightly set, with negative letter spacing.
- No text below 12px.
- No uppercase labels. Studio uses them only for table headers, and the inbox has no tables.

## Shape and spacing (all estimates)

- Buttons, badges and the search field are pills.
- Message cards use a 16px radius, attachments 12px and selects 8px.
- Primary buttons are `--accent` with white text. Secondary buttons are white pills with a `--rule` border.
- Spacing uses a 4px base: 4, 8, 12, 16, 24, 32.
- Shadows are warm and faint, and appear only on messages.

## Security limits

- `frontend/public/_headers` already allows same-origin fonts through `default-src 'self'`, so no header change is needed.
- Do not use `style=` attributes or load fonts from another origin.
