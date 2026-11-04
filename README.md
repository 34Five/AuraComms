# AuraComms
This repository will hold the architecture for allowing Auras to communicate through email and phone number assignments.

The [Aura inbox test app](apps/aura-inbox/README.md) contains the Vite frontend, Cloudflare Worker API, and incoming email receiver.

Email schema, relationships and local verification: [docs/email-model.md](docs/email-model.md).

```bash
python3 -m unittest discover -s tests/email -v
python3 scripts/email_schema.py demo --output /tmp/aura-email-demo.sqlite
```

AXI-8 tier rules and mocked approval state machine: [docs/email-governance.md](docs/email-governance.md).

```bash
python3 scripts/email_rules_demo.py
```

The inbox includes separate [governance, Aura management and email setup pages](apps/aura-inbox/README.md#separate-management-pages).
