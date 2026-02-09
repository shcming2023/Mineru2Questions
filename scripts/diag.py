import urllib.request
import sqlite3
import os
import sys

print("--- System Diagnostic Report ---")

# 1. Server Connectivity
try:
    resp = urllib.request.urlopen("http://localhost:3000")
    print(f"[PASS] HTTP Service (Port 3000): {resp.status} OK")
except Exception as e:
    print(f"[FAIL] HTTP Service: {e}")

# 2. Database Integrity
db_path = "sqlite.db"
if os.path.exists(db_path):
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Check extraction_tasks
        try:
            cursor.execute("SELECT count(*) FROM extraction_tasks")
            count = cursor.fetchone()[0]
            print(f"[PASS] Database Read (extraction_tasks): {count} records found")
        except sqlite3.OperationalError as e:
            print(f"[FAIL] Table 'extraction_tasks' query failed: {e}")

        # Check llm_configs
        try:
            cursor.execute("SELECT count(*) FROM llm_configs")
            count = cursor.fetchone()[0]
            print(f"[PASS] Database Read (llm_configs): {count} records found")
        except sqlite3.OperationalError as e:
            print(f"[FAIL] Table 'llm_configs' query failed: {e}")
            
    except Exception as e:
        print(f"[FAIL] Database Connection: {e}")
else:
    print(f"[FAIL] Database File: {db_path} not found")

print("--- End Report ---")
