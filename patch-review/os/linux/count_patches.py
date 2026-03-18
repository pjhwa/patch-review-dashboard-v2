import json
data = json.load(open('/home/citec/.openclaw/workspace/skills/patch-review/os/linux/patches_for_llm_review.json'))
print('Total elements:', len(data))
vendors = [x.get('vendor') for x in data]
print({v: vendors.count(v) for v in set(vendors)})
