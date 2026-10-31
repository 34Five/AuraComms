#!/usr/bin/env python3
"""Local-only E07 tooling: create a fresh demo or validate an exported parent schema."""
import argparse
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
PARENTS = ROOT / 'tests/email/fixtures/studio_parents_2026_10_22.sql'
MIGRATION = ROOT / 'scripts/0001_email_model.sql'
SEED = ROOT / 'scripts/email/seed.sql'


def check_parents(db):
    """Check actual FK parent requirements, allowing unrelated extra columns."""
    requirements = {'auras': {'id': 'TEXT', 'org_id': 'TEXT'},
                    'studio_members': {'org_id': 'TEXT', 'member_id': 'TEXT'}}
    for table, columns in requirements.items():
        info = {r[1]: r for r in db.execute('PRAGMA table_info(' + table + ')')}
        for name, type_name in columns.items():
            if name not in info or info[name][2].upper() != type_name:
                raise ValueError(f'Incompatible parent schema: {table}.{name} must be {type_name}')
        expected = ['id'] if table == 'auras' else ['org_id', 'member_id']
        pk = [r[1] for r in sorted(info.values(), key=lambda r: r[5]) if r[5]]
        unique_keys = [pk]
        for index in db.execute('PRAGMA index_list(' + table + ')').fetchall():
            if index[2] and not index[4]:
                # Index names come from SQLite metadata and are quoted as identifiers.
                name = index[1].replace('"', '""')
                unique_keys.append([r[2] for r in db.execute('PRAGMA index_info("' + name + '")')])
        if expected not in unique_keys:
            raise ValueError(f'Incompatible parent key: {table} requires UNIQUE/PRIMARY KEY {expected}')
    return True


def apply_migration(db):
    check_parents(db)
    if db.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name GLOB 'email_*'").fetchone():
        raise ValueError('Existing email tables detected. This consolidated draft is not an upgrade migration.')
    db.executescript(MIGRATION.read_text())
    violations = db.execute('PRAGMA foreign_key_check').fetchall()
    if violations:
        raise ValueError(f'Foreign key violations: {violations}')


def demo_database(output, parent_schema=PARENTS):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Never overwrite or seed an existing database, even when it has the expected schema.
    with output.open('xb'):
        pass
    db = sqlite3.connect(output)
    try:
        db.execute('PRAGMA foreign_keys=ON')
        db.executescript(Path(parent_schema).read_text())
        apply_migration(db)
        db.executescript(SEED.read_text())
        if db.execute('PRAGMA foreign_key_check').fetchall():
            raise ValueError('Demo seed violates foreign keys')
        db.commit()
    except Exception:
        db.close()
        output.unlink(missing_ok=True)
        raise
    finally:
        db.close()
    return output.resolve()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    demo = commands.add_parser('demo', help='Create a NEW local demo database')
    demo.add_argument('--output', type=Path, required=True)
    validate = commands.add_parser('validate', help='Apply to a schema-only export in memory, with no seed')
    validate.add_argument('--parent-schema', type=Path, required=True)
    check = commands.add_parser('check-parents', help='Read an existing LOCAL SQLite database without modifying it')
    check.add_argument('--database', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'demo':
        print('Created local demo:', demo_database(args.output))
    elif args.command == 'validate':
        with sqlite3.connect(':memory:') as db:
            db.execute('PRAGMA foreign_keys=ON')
            db.executescript(args.parent_schema.read_text())
            apply_migration(db)
        print('Migration applied to supplied parent schema in memory; no remote database was changed.')
    else:
        with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as db:
            check_parents(db)
        print('Parent columns and unique keys are compatible; this does not validate email table upgrades.')


if __name__ == '__main__':
    main()
