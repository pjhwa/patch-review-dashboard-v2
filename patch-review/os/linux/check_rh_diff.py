import json
import sys
data = json.load(open('/home/citec/.openclaw/workspace/skills/patch-review/os/linux/patches_for_llm_review.json'))
rh_patches = [x for x in data if x['vendor'] == 'Red Hat']
for p in rh_patches:
    print(f"ID: {p['id']}\nDiff: {p['diff_content']}\n---")
