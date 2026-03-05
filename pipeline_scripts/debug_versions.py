import json

with open('/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/patches_for_llm_review.json', 'r') as f:
    data = json.load(f)

for item in data[:3]:
    print("Keys:", list(item.keys()))
    print("Item snippet:", {k: str(v)[:100] for k, v in item.items()})
    print("-" * 40)
