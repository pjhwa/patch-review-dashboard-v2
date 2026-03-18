import sqlite3

db_path = "/home/citec/patch-review-dashboard-v2/prisma/patch-review.db"
conn = sqlite3.connect(db_path)
c = conn.cursor()

c.execute("SELECT id, vendor, component, osVersion FROM PreprocessedPatch LIMIT 5")
rows = c.fetchall()
for row in rows:
    print(row)
