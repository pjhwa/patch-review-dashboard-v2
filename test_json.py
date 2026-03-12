import json
import sys

try:
    with open('/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/patches_for_llm_review.json') as f:
        data = json.load(f)
    print("Found JSON, reading first 15 patches with missing versions:")
    count = 0
    for p in data:
        if not p.get('specific_version') or p.get('specific_version') == 'Unknown':
            print(f"Vendor: {p.get('vendor', 'Unknown')} | Component: {p.get('component')}")
            print(f"Summary: {p.get('summary', '')[:100]}...")
            print(f"Title: {p.get('id', '')} - {p.get('full_text', '')[:100]}...")
            print("---")
            count += 1
        if count >= 8:
            break
except Exception as e:
    print("Error:", e)
