"""Reorder only exported CREATE TABLE statements; never modify the snapshot."""
import os
import re
import sqlite3
import sys


def body(statement):
    return re.sub(r"\A(?:\s+|--[^\n]*(?:\n|$)|/\*.*?\*/)*", "", statement, flags=re.S)


def prepare(source, destination):
    with open(source, encoding="utf-8", newline="") as stream:
        sql = stream.read()
    statements = []
    start = 0
    # complete_statement understands quoted semicolons and entire trigger bodies.
    for offset, character in enumerate(sql):
        if character == ";" and sqlite3.complete_statement(sql[start:offset + 1]):
            statements.append(sql[start:offset + 1])
            start = offset + 1
    tail = sql[start:]
    if body(tail).strip():
        raise ValueError("Incomplete dump")
    tables, remaining, leading = [], [], []
    for statement in statements:
        text = body(statement)
        if re.match(r"CREATE\s+TABLE\s+", text, re.I):
            # Wrangler emits ordinary definitions, not CREATE TABLE AS SELECT.
            if not re.match(r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"(?:[^"]|"")*"|`[^`]*`|\[[^]]*\]|[\w]+)\s*\(', text, re.I):
                raise ValueError("Unsupported table definition")
            tables.append(statement)
        elif not tables and not remaining and re.match(r"PRAGMA\s+", text, re.I):
            leading.append(statement)
        else:
            remaining.append(statement)
    if not tables:
        raise ValueError("Empty or unsupported dump")
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
        stream.write("\n".join(leading + tables + remaining) + tail)


try:
    prepare(sys.argv[1], sys.argv[2])
except Exception:
    # SQL and parser diagnostics can contain credentials. Never print them.
    sys.exit("Could not prepare exported SQL (complete Wrangler dump and python3 required)")
