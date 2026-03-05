import json

with open('/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/patches_for_llm_review.json', 'r') as f:
    data = json.load(f)

for item in data:
    if item.get('id') == 'USN-8043-1-24.04_LTS':
        print(item)
