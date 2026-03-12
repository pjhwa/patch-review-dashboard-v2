import json

with open('/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/patches_for_llm_review.json') as f:
    data = json.load(f)

for p in data:
    if p.get('id') == 'RHSA-2026:3291':
        print(p.get('full_text', '')[:1000])
        print('=================================')
        print(p.get('full_text', '')[-1000:])
