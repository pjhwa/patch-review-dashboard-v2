import sqlite3

db_path = "/home/citec/patch-review-dashboard-v2/prisma/patch-review.db"
conn = sqlite3.connect(db_path)
c = conn.cursor()

try:
    c.execute("DELETE FROM PreprocessedPatch;")
    c.execute("DELETE FROM ReviewedPatch;")
    conn.commit()
    print("Cleared PreprocessedPatch and ReviewedPatch tables from Prisma DB.")
except Exception as e:
    print(e)
