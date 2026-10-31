# E07 review validation — 2026-10-31

## Checks performed

- 51 Python/SQLite tests passed using Python 3.12 and foreign-key enforcement.
- Tests load the full exported auras and studio_members CREATE TABLE statements from
  the 2026-10-22 D1 schema export, not minimal substitute parent tables.
- Coverage includes received mail followed by address reassignment, historical/new Aura
  ownership, overlapping/current assignments, cross-org domain/address/Aura references,
  duplicate ingest/send/events, reviewers, body storage, query plans and local tooling.
- Python syntax, local config JSON, and CI target/job configuration were checked.
- Local D1: imported exported parent DDL, applied 0001_email_model.sql through Wrangler's
  migration runner (52 statements), then imported the fictional seed successfully.
- Local D1 reassignment smoke check: msg_quote_in retained e07_demo_aura_sales and
  assignment_sales; msg_d1_new used e07_demo_aura_support and assignment_sales_d1_new.
- Local D1 PRAGMA foreign_key_check returned no rows; PRAGMA quick_check returned ok.

## Reproduce

Run `python3 -m unittest discover -s tests/email -v` from the repository root. The
complete local D1 import/migration/seed commands and prerequisites are in
[email-model.md](email-model.md). The reusable D1 reassignment smoke SQL is
tests/email/d1_reassignment_check.sql and is for a fresh local seed only.

## Limits

The locally available Wrangler was 4.107.0, running under Node 22.14.0. The spike
package pins Wrangler 4.151.3; validation with that pinned installation and the
confirmed staging binding remains an integration step. No remote database, DNS,
email route or deployed Worker was changed. These checks do not establish the current
Studio remote schema version, member-sync behavior, or final tier semantics. CI
configuration is included; hosted CI results must be checked on the updated PR.
