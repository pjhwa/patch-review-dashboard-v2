import sqlite3
import json
conn = sqlite3.connect('/home/citec/patch-review-dashboard-v2/patch-review.db')
c = conn.cursor()
c.execute("SELECT vendor, issueId, component, description FROM PreprocessedPatch WHERE version='Unknown' LIMIT 5")
print(json.dumps(c.fetchall(), indent=2))
