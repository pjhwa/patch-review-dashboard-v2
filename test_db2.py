import sqlite3
import json
conn = sqlite3.connect('/home/citec/patch-review-dashboard-v2/patch-review.db')
c = conn.cursor()
c.execute("SELECT vendor, issueId, component, version FROM PreprocessedPatch ORDER BY collectedAt DESC LIMIT 15")
print(json.dumps(c.fetchall(), indent=2))
