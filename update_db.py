import sqlite3
import os

db_path = os.path.expanduser("~/patch-review-dashboard-v2/prisma/patch-review.db")
if not os.path.exists(db_path):
    print("DB not found")
    exit(1)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

try:
    cursor.execute("UPDATE PreprocessedPatch SET vendor='Ubuntu' WHERE vendor='Canonical / Ubuntu'")
    cursor.execute("UPDATE RawPatch SET vendor='Ubuntu' WHERE vendor='Canonical / Ubuntu'")
    cursor.execute("UPDATE ReviewedPatch SET vendor='Ubuntu' WHERE vendor='Canonical / Ubuntu'")
    conn.commit()
    print("DB updated successfully.")
except Exception as e:
    print(f"Error: {e}")
finally:
    conn.close()
