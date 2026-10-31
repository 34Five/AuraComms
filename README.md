# AuraComms
This repository will hold the architecture for allowing Auras to communicate through email and phone number assignments.

Email schema, relationships and local verification: [docs/email-model.md](docs/email-model.md).

```bash
python3 -m unittest discover -s tests/email -v
python3 scripts/email_schema.py demo --output /tmp/aura-email-demo.sqlite
```

