# AXI-26 Aura Inbox Restyle Implementation Plan

**Goal:** Give the Aura inbox Studio's colors, font and components while it stays a three-pane email client.

**Architecture:** One stylesheet built on CSS custom properties, plus markup changes in the render output of `App.tsx`. Data loading, polling, pagination and email sanitization stay untouched.

**Tech Stack:** React 19, Vite, plain CSS, self-hosted Poppins.

**Spec:** `docs/superpowers/specs/2026-11-04-axi-26-studio-visual-rules.md`

## Global Constraints

- No API, Worker, data model or behavior changes.
- No new dependencies. No `_headers` change. No `style=` attributes.
- Do not change `plain()`, `MessageBody`, `get()` or any `useEffect`.
- Keep the public-test warning and the read-only notice visible.
- Studio screenshots never enter this repository.

## Review Focus

1. Long subjects, sender names and unbroken addresses should wrap or truncate without breaking a pane.
2. A narrow window should show the list or the message, with a working back button.
3. Keyboard users should see focus on the dark sidebar as well as on light surfaces.
4. Polling every five seconds should not close an expanded quote or move the selected row.
5. Failed loads and empty results should say what happened and keep "Try again" usable.

---

### Task 1: Tokens and font

**Files:**
- Create: `apps/aura-inbox/frontend/public/fonts/` (four woff2 files and the license)
- Modify: `apps/aura-inbox/frontend/src/style.css`, `apps/aura-inbox/frontend/index.html`, `apps/aura-inbox/frontend/public/favicon.svg`

**Interfaces:**
- Produces: the custom properties named in the spec's color table, used by every later rule.

- [ ] **Step 1:** Replace `style.css` with `@font-face` rules, the `:root` tokens and base element styles.
- [ ] **Step 2:** Set `theme-color` to `#3d3d3d` and recolor the favicon to `#855b4a`.
- [ ] **Step 3:** Run `npm run build`. Expected: pass, with `dist/fonts/poppins-400.woff2` present.

### Task 2: Inbox layout and markup

**Files:**
- Modify: `apps/aura-inbox/frontend/src/App.tsx` (`Icon`, `MessageCard` markup and the `App` return only), `apps/aura-inbox/frontend/src/style.css`

**Interfaces:**
- Consumes: tokens from Task 1.
- Produces: dark Aura sidebar, white top bar holding the Aura name, address, search pill, read-only badge and Refresh, then a thread list pane and a canvas reading pane.

- [ ] **Step 1:** Remove the static breadcrumb, the fake profile and workspace blocks, the non-interactive "Inbox" item, the decorative taglines and the mail illustration.
- [ ] **Step 2:** Move search into the top bar. Hide the "open" badge on list rows and show message counts only above 1. Add an `outbound` class to messages the Aura sent.
- [ ] **Step 3:** Write the empty state copy: "Select a conversation" and "Messages for this Aura open here." Write "No mail yet" for an empty list.
- [ ] **Step 4:** Add responsive rules at 1100px, 850px and 560px, and visible focus states. The sheet has no motion, so it needs no reduced-motion rule.
- [ ] **Step 5:** Run `npm run typecheck && npm test`. Expected: pass, 31 tests.

### Task 3: Verify

**Files:**
- Scratch only, outside the repository: a mock `/api` server on port 8788.

- [ ] **Step 1:** With Vite and the mock running, screenshot the list, the open thread, expanded quote, attachments, empty, loading and error states at 1440px, 900px and 400px.
- [ ] **Step 2:** Exercise each Review Focus item in the browser, including a long unbroken address.
- [ ] **Step 3:** Run `npm ci && npm run check`. Expected: pass, including `wrangler deploy --dry-run`, which does not deploy.
- [ ] **Step 4:** List the remaining differences from Studio for the PR.
