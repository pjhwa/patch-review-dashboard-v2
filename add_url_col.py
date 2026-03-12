import sqlite3
import sys

db_path = '/home/citec/patch-review-dashboard-v2/patch-review.db'
conn = sqlite3.connect(db_path)
c = conn.cursor()

# Check if url column already exists
c.execute("PRAGMA table_info(PreprocessedPatch)")
cols = [row[1] for row in c.fetchall()]
print("Current columns:", cols)

if 'url' not in cols:
    c.execute("ALTER TABLE PreprocessedPatch ADD COLUMN url TEXT")
    conn.commit()
    print("Added 'url' column successfully.")
else:
    print("'url' column already exists, skipping.")

conn.close()
